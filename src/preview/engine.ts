import { colourSchema, type ColourSettings } from '../shared/colour.js';
import { projectSchema, type ProjectDocument } from '../shared/model.js';
import { calculateLayout, sampleTimeline, type PlacedClip, type PreviewLayer, type TimelineLayout } from '../shared/timeline.js';
import { framesToSeconds, PROJECT_FPS, sameRate, secondsToFrames } from '../shared/timing.js';
import { allocateDecoders, decoderPoolSize, type DecoderPoolAssignments } from './assignment.js';
import { Compositor, type CompositeGroup } from './compositor.js';
import { VideoDecoderSlot } from './decoder.js';
import { MusicPlayback } from './music.js';

export type PreviewStatus = 'empty' | 'loading' | 'paused' | 'playing' | 'seeking' | 'buffering' | 'error' | 'disposed';
export interface PreviewDiagnostics {
  status: PreviewStatus; message: string; playing: boolean; frame: number; duration: number;
  previewFps: number; renderedFrames: number; observedDecodedFrames: number;
  lastSeekMs: number | null; medianSeekMs: number | null; seekSamples: number;
  colourLatencyMs: number | null; stalls: number; boundaryStalls: number; stallMilliseconds: number;
  droppedDecodedFrames: number; lateDecodedCallbacks: number; maximumClockErrorFrames: number;
  activeDecoders: number; decoderCount: number; assignedClipIds: (string | null)[];
  renderer: string; gpuTextureMiB: number; jsHeapMiB: number | null;
  audioClock: boolean; musicDriftFrames: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Appearance may change stacking/visibility, but never source clocks or music. */
function timingKey(project: ProjectDocument): string {
  return JSON.stringify({
    id: project.id, frameRate: project.frameRate, colourProfile: project.colourProfile,
    primary: project.clips.filter((clip) => clip.layerId === project.layers[0]!.id).map((clip) => clip.id),
    clips: project.clips.map(({ id, mediaId, layerId, start, sourceIn, sourceOut, speed }) => ({ id, mediaId, layerId, start, sourceIn, sourceOut, speed })).sort((left, right) => left.id.localeCompare(right.id)),
    layerRates: project.layers.filter((layer) => layer.keyframes.some((key) => key.values.speed !== null)).map((layer) => ({ id: layer.id, keys: layer.keyframes.filter((key) => key.values.speed !== null).map((key) => ({ frame: key.frame, interpolation: key.interpolation, value: key.values.speed })) })).sort((left, right) => left.id.localeCompare(right.id)),
    transitions: project.transitions, opening: project.openingFade, closing: project.closingFade, music: project.music,
  });
}

/** Observed source frames and premultiplied layer groups on a bounded decoder pool. */
export class PreviewEngine {
  #compositor: Compositor;
  readonly #music = new MusicPlayback();
  readonly #slots: VideoDecoderSlot[] = [];
  #assignments: DecoderPoolAssignments = [];
  #nextSlotIndex = 0;
  #proxyUrl: (mediaId: string) => string = () => { throw new Error('No media resolver loaded.'); };
  #document: ProjectDocument | null = null;
  #layout: TimelineLayout = { clips: [], transitions: [], duration: 0, baseDuration: 0 };
  #controller = new AbortController();
  readonly #preloads = new Map<VideoDecoderSlot, { clipId: string; controller: AbortController }>();
  #operationFrame = 0;
  readonly #listeners = new Set<(diagnostics: PreviewDiagnostics) => void>();
  #raf = 0;
  #disposed = false;
  #playing = false;
  #busy = false;
  #status: PreviewStatus = 'empty';
  #message = 'Add footage to the timeline';
  #frame = 0;
  #clockFrame = 0;
  #clockTime = 0;
  #lastDrawnFrame = -1;
  #dirty = true;
  #lastEmit = 0;
  #playingClips: string[] = [];
  readonly #uploadedFrames: number[] = [];
  readonly #seekTimes: number[] = [];
  readonly #renderTimes: number[] = [];
  #renderedFrames = 0;
  #colourRequested = 0;
  #colourLatency: number | null = null;
  #stalls = 0;
  #boundaryStalls = 0;
  #stallStart = 0;
  #stallTotal = 0;
  #mismatchStart = 0;
  #maxClockError = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = 1280; canvas.height = 720;
    try { this.#compositor = new Compositor(canvas); }
    catch (error) { this.#music.dispose(); throw error; }
    try { this.#resizePool(2); }
    catch (error) {
      for (const slot of this.#slots) slot.dispose();
      this.#music.dispose(); this.#compositor.dispose(); throw error;
    }
    canvas.addEventListener('webglcontextlost', this.#onContextLost);
    canvas.addEventListener('webglcontextrestored', this.#onContextRestored);
    this.#raf = requestAnimationFrame(this.#tick);
  }
  subscribe(listener: (diagnostics: PreviewDiagnostics) => void): () => void {
    this.#listeners.add(listener); listener(this.diagnostics());
    return () => { this.#listeners.delete(listener); };
  }
  diagnostics(): PreviewDiagnostics {
    const now = performance.now();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const recent = this.#renderTimes.filter((time) => time >= now - 2_000);
    const interval = recent.length > 1 ? Math.max(1_000, recent.at(-1)! - recent[0]!) : 2_000;
    return {
      status: this.#status, message: this.#message, playing: this.#playing, frame: this.#frame, duration: this.#layout.duration,
      previewFps: this.#playing ? Math.max(0, recent.length - 1) / interval * 1000 : 0,
      renderedFrames: this.#renderedFrames, observedDecodedFrames: this.#slots.reduce((sum, slot) => sum + slot.observedFrames, 0),
      lastSeekMs: this.#seekTimes.at(-1) ?? null, medianSeekMs: median(this.#seekTimes), seekSamples: this.#seekTimes.length,
      colourLatencyMs: this.#colourLatency, stalls: this.#stalls, boundaryStalls: this.#boundaryStalls,
      stallMilliseconds: this.#stallTotal + (this.#stallStart ? now - this.#stallStart : 0),
      droppedDecodedFrames: this.#slots.reduce((sum, slot) => sum + slot.droppedFrames, 0),
      lateDecodedCallbacks: this.#slots.reduce((sum, slot) => sum + slot.lateCallbacks, 0),
      maximumClockErrorFrames: this.#maxClockError, activeDecoders: this.#playingClips.length,
      decoderCount: this.#slots.length, assignedClipIds: [...this.#assignments],
      renderer: this.#compositor.renderer, gpuTextureMiB: this.#compositor.gpuTextureMiB,
      jsHeapMiB: memory ? memory.usedJSHeapSize / 1024 ** 2 : null,
      audioClock: this.#music.hasMusic, musicDriftFrames: this.#music.errorFrames,
    };
  }
  #emit(force = false): void {
    const now = performance.now();
    if (!force && now - this.#lastEmit < 100) return;
    this.#lastEmit = now;
    const diagnostics = this.diagnostics();
    for (const listener of this.#listeners) listener(diagnostics);
  }
  #setStatus(status: PreviewStatus, message: string): void {
    if (this.#status === status && this.#message === message) return;
    this.#status = status; this.#message = message;
    if (status === 'buffering') {
      if (!this.#stallStart) { this.#stallStart = performance.now(); this.#stalls++; }
    } else if (this.#stallStart) {
      this.#stallTotal += performance.now() - this.#stallStart; this.#stallStart = 0;
    }
    this.#emit(true);
  }
  #cancelPreloads(): void {
    for (const [slot, preload] of this.#preloads) { preload.controller.abort(); slot.pause(); }
    this.#preloads.clear();
  }
  #beginOperation(): AbortSignal {
    this.#music.pause();
    this.#controller.abort(); this.#cancelPreloads();
    this.#controller = new AbortController(); this.#busy = true;
    for (const slot of this.#slots) slot.pause();
    this.#playingClips = [];
    return this.#controller.signal;
  }
  #isCurrent(signal: AbortSignal): boolean {
    return !this.#disposed && !signal.aborted && signal === this.#controller.signal;
  }
  #resizePool(count: number, required: readonly string[] = []): void {
    if (count === this.#slots.length) return;
    if (required.length > count) throw new Error('Active sources exceed the requested decoder pool.');
    this.#cancelPreloads();
    const active = new Set(required);
    while (this.#slots.length > count) {
      let index = this.#slots.length - 1;
      while (index >= 0 && active.has(this.#assignments[index]!)) index--;
      if (index < 0) throw new Error('Cannot remove a required decoder.');
      this.#slots.splice(index, 1)[0]!.dispose();
      this.#assignments.splice(index, 1); this.#uploadedFrames.splice(index, 1);
    }
    while (this.#slots.length < count) {
      this.#slots.push(new VideoDecoderSlot(document.body, this.#nextSlotIndex++));
      this.#assignments.push(null); this.#uploadedFrames.push(-1);
    }
    this.#compositor.setDecoderCount(count);
    this.#uploadedFrames.fill(-1); this.#dirty = true;
  }
  #poolSize(): number {
    return this.#document?.clips.length && this.#compositor.available ? decoderPoolSize(this.#document.layers.length) : 0;
  }
  #slotIndex(clipId: string): number {
    const index = this.#assignments.indexOf(clipId);
    if (index < 0 || !this.#slots[index]) throw new Error('Required clip is not assigned to a decoder.');
    return index;
  }
  #slotFor(clipId: string): VideoDecoderSlot { return this.#slots[this.#slotIndex(clipId)]!; }
  async #prepareLayers(layers: readonly PreviewLayer[], signal: AbortSignal): Promise<void> {
    if (!this.#isCurrent(signal)) return;
    const next = allocateDecoders(this.#assignments, layers.map((layer) => layer.clipId));
    next.forEach((id, index) => { if (id !== this.#assignments[index]) this.#uploadedFrames[index] = -1; });
    this.#assignments = next;
    const rate = this.#document!.frameRate;
    await Promise.all(layers.map(async (layer) => {
      const slot = this.#slotFor(layer.clipId);
      await slot.load(this.#proxyUrl(layer.mediaId), rate, signal);
      if (!this.#isCurrent(signal) || this.#assignments[this.#slots.indexOf(slot)] !== layer.clipId) return;
      await slot.seek(layer.sourceFrame, signal);
    }));
  }
  #nextClips(frame: number): PlacedClip[] {
    return this.#document!.layers.filter((layer) => layer.enabled).flatMap((layer) => {
      const next = this.#layout.clips.find((placed) => placed.clip.layerId === layer.id && placed.start > frame);
      return next ? [next] : [];
    }).sort((left, right) => left.start - right.start);
  }
  #preloadNext(frame: number): void {
    if (!this.#document || this.#disposed) return;
    const active = sampleTimeline(this.#document, frame, this.#layout);
    const reserved = new Set(active.map((layer) => this.#slotIndex(layer.clipId)));
    const candidates = this.#nextClips(frame);
    const wanted = new Set(candidates.map((placed) => placed.clip.id));
    for (const [slot, preload] of this.#preloads) {
      if (wanted.has(preload.clipId)) continue;
      preload.controller.abort(); slot.pause(); this.#preloads.delete(slot);
    }
    for (const placed of candidates) {
      let index = this.#assignments.indexOf(placed.clip.id);
      if (index < 0) index = this.#assignments.findIndex((id, slot) => id === null && !reserved.has(slot));
      if (index < 0) index = this.#assignments.findIndex((_id, slot) => !reserved.has(slot));
      if (index < 0) break;
      reserved.add(index); this.#startPreload(index, placed);
    }
  }
  #startPreload(index: number, placed: PlacedClip): void {
    const slot = this.#slots[index]!; const clip = placed.clip;
    const firstFrame = placed.retiming.sourceAt(0);
    if (this.#preloads.get(slot)?.clipId === clip.id) return;
    if (this.#assignments[index] === clip.id && slot.ready && slot.decodedFrame === firstFrame) return;
    this.#preloads.get(slot)?.controller.abort(); slot.pause();
    const controller = new AbortController();
    const preload = { clipId: clip.id, controller };
    this.#preloads.set(slot, preload);
    this.#assignments[index] = clip.id; this.#uploadedFrames[index] = -1;
    const rate = this.#document!.frameRate;
    void (async () => {
      await slot.load(this.#proxyUrl(clip.mediaId), rate, controller.signal);
      if (!controller.signal.aborted && this.#preloads.get(slot) === preload) await slot.seek(firstFrame, controller.signal);
      if (this.#preloads.get(slot) === preload) this.#preloads.delete(slot);
    })().catch(() => {
      // Preloading is speculative. A required load/seek reports the real error;
      // the current recording must remain playable if a future source is absent.
      if (controller.signal.aborted || this.#preloads.get(slot) !== preload) return;
      this.#preloads.delete(slot); slot.pause();
      const currentIndex = this.#slots.indexOf(slot);
      if (this.#assignments[currentIndex] === clip.id) { this.#assignments[currentIndex] = null; this.#uploadedFrames[currentIndex] = -1; }
    });
  }

  async loadProject(document: ProjectDocument, proxyUrl: (mediaId: string) => string, initialFrame = 0): Promise<void> {
    if (this.#disposed) throw new Error('The preview engine is disposed.');
    if (!Number.isFinite(initialFrame)) throw new Error('Initial preview frame must be finite.');
    const snapshot = projectSchema.parse(document);
    if (!sameRate(snapshot.frameRate, PROJECT_FPS)) throw new Error('Preview requires 30000/1001 fps video.');
    this.pause();
    const signal = this.#beginOperation();
    this.#document = snapshot; this.#layout = calculateLayout(snapshot); this.#proxyUrl = proxyUrl;
    this.#frame = Math.max(0, Math.min(Math.round(initialFrame), this.#layout.duration - 1));
    this.#operationFrame = this.#frame;
    this.#lastDrawnFrame = -1; this.#uploadedFrames.fill(-1); this.#dirty = true;
    this.#setStatus('loading', 'Loading preview');
    try {
      this.#resizePool(this.#poolSize());
      const ids = new Set(snapshot.clips.map((clip) => clip.id));
      this.#assignments = this.#assignments.map((id) => id !== null && ids.has(id) ? id : null);
      this.#compositor.clear();
      await this.#music.configure(snapshot.clips.length ? snapshot.music : null, signal);
      if (!this.#isCurrent(signal)) return;
      if (!this.#compositor.available) throw new Error('WebGL context is unavailable.');
      if (!snapshot.clips.length) { this.#busy = false; this.#setStatus('empty', 'Add footage to the timeline'); return; }
      await this.#prepareLayers(sampleTimeline(snapshot, this.#frame, this.#layout), signal);
      if (!this.#isCurrent(signal)) return;
      this.#drawFrame(this.#frame); this.#busy = false;
      this.#setStatus('paused', 'Paused'); this.#preloadNext(this.#frame);
    } catch (error) { if (this.#isCurrent(signal)) this.#handleError(error); }
  }
  async seek(frame: number): Promise<void> {
    if (this.#disposed || !this.#document || !this.#layout.duration) return;
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.#layout.duration) throw new Error('Requested project frame is outside the timeline.');
    this.pause();
    const signal = this.#beginOperation(); const started = performance.now();
    this.#operationFrame = frame;
    this.#compositor.clear(); this.#setStatus('seeking', `Seeking frame ${frame}`);
    try {
      await this.#prepareLayers(sampleTimeline(this.#document, frame, this.#layout), signal);
      if (!this.#isCurrent(signal)) return;
      this.#frame = frame; this.#drawFrame(frame); this.#busy = false;
      this.#seekTimes.push(performance.now() - started);
      if (this.#seekTimes.length > 200) this.#seekTimes.shift();
      this.#setStatus('paused', 'Paused'); this.#preloadNext(frame);
    } catch (error) { if (this.#isCurrent(signal)) this.#handleError(error); }
  }
  updateColour(clipId: string, settings: ColourSettings): void {
    if (!this.#document) return;
    const clip = this.#document.clips.find((item) => item.id === clipId);
    if (!clip) throw new Error('The graded clip does not exist.');
    clip.colour = colourSchema.parse(settings); this.#dirty = true; this.#colourRequested = performance.now();
    if (!this.#playing && !this.#busy && this.#status === 'paused') this.#drawFrame(this.#frame);
  }
  /** No music configuration or retiming reload for opacity/colour/stacking edits. */
  updateProjectAppearance(document: ProjectDocument): void {
    if (this.#disposed || !this.#document) throw new Error('Load a project before updating its appearance.');
    const snapshot = projectSchema.parse(document);
    if (timingKey(snapshot) !== timingKey(this.#document)) throw new Error('Appearance updates must preserve project timing; use loadProject for source, placement, speed, transitions or music changes.');
    const frame = this.#busy ? this.#operationFrame : this.#frame;
    const previous = sampleTimeline(this.#document, frame, this.#layout).map((layer) => layer.clipId);
    this.#document = snapshot; this.#layout = calculateLayout(snapshot);
    const required = sampleTimeline(snapshot, frame, this.#layout).map((layer) => layer.clipId);
    const changed = required.length !== previous.length || required.some((id) => !previous.includes(id));
    this.#resizePool(this.#poolSize(), required);
    this.#dirty = true; this.#colourRequested = performance.now();
    if (changed) this.#cancelPreloads();
    if (!this.#layout.duration || !this.#compositor.available) { this.#compositor.clear(); return; }
    this.#refreshAppearance(frame, required, changed);
  }
  #refreshAppearance(frame: number, required: readonly string[], changed: boolean): void {
    if (this.#busy && !changed) return;
    if (this.#busy) {
      this.#controller.abort(); this.#busy = false;
      if (this.#playing) void this.#alignPlayback(frame, false);
      else void this.seek(frame);
      return;
    }
    if (this.#playing && required.some((id) => !this.#playingClips.includes(id))) { void this.#alignPlayback(frame, false); return; }
    if (this.#playing) {
      const removed = this.#playingClips.filter((id) => !required.includes(id));
      removed.forEach((id) => this.#slots[this.#assignments.indexOf(id)]?.pause());
      this.#playingClips = [...required];
      if (!this.#drawFrame(frame)) this.#compositor.clear();
      this.#preloadNext(frame); return;
    }
    if (!this.#drawFrame(frame)) { void this.seek(frame); return; }
    this.#preloadNext(frame);
  }
  async play(): Promise<void> {
    if (!this.#document || !this.#layout.duration || this.#disposed || this.#playing || this.#busy) return;
    if (this.#frame >= this.#layout.duration - 1) {
      const reset = this.seek(0); const signal = this.#controller.signal;
      await reset;
      if (!this.#isCurrent(signal)) return;
    }
    if (this.#status === 'error') return;
    const signal = this.#beginOperation(); this.#operationFrame = this.#frame;
    try {
      await this.#music.resumeContext();
      if (!this.#isCurrent(signal)) return;
      this.#busy = false; this.#playing = true; this.#renderTimes.length = 0;
      await this.#alignPlayback(this.#frame, false);
    } catch (error) { if (this.#isCurrent(signal)) this.#handleError(error); }
  }
  pause(): void {
    this.#music.pause();
    this.#playing = false; this.#controller.abort(); this.#cancelPreloads();
    this.#busy = false;
    for (const slot of this.#slots) slot.pause();
    this.#playingClips = [];
    if (this.#document && this.#status !== 'empty' && this.#status !== 'error') this.#setStatus('paused', 'Paused');
  }
  #drawFrame(frame: number): boolean {
    if (!this.#document || !this.#compositor.available) return false;
    const layers = sampleTimeline(this.#document, frame, this.#layout);
    if (layers.some((layer) => {
      if (!this.#assignments.includes(layer.clipId)) return true;
      const slot = this.#slotFor(layer.clipId);
      return !slot.ready || slot.decodedFrame !== layer.sourceFrame;
    })) return false;
    for (const layer of layers) {
      const index = this.#slotIndex(layer.clipId); const slot = this.#slots[index]!;
      if (this.#uploadedFrames[index] !== slot.decodedFrame) {
        this.#compositor.uploadVideo(index, slot.video); this.#uploadedFrames[index] = slot.decodedFrame;
      }
    }
    const groups: CompositeGroup[] = [];
    for (const group of this.#document.layers) {
      const members = layers.filter((layer) => layer.layerId === group.id);
      if (!members.length) continue;
      groups.push({
        opacity: members[0]!.layerOpacity, clips: members.map((layer) => ({
          slot: this.#slotIndex(layer.clipId), settings: layer.colour, aspect: this.#slotFor(layer.clipId).aspect,
          opacity: layer.opacity, blendWeight: layer.blendWeight, brightness: layer.brightness,
        }))
      });
    }
    this.#compositor.drawFrame(groups);
    if (frame !== this.#lastDrawnFrame || this.#dirty) {
      this.#renderedFrames++;
      if (this.#playing) {
        this.#renderTimes.push(performance.now());
        if (this.#renderTimes.length > 300) this.#renderTimes.shift();
      }
      this.#lastDrawnFrame = frame;
    }
    this.#dirty = false; this.#frame = frame;
    if (this.#colourRequested) {
      const requested = this.#colourRequested; this.#colourRequested = 0;
      requestAnimationFrame(() => {
        if (!this.#disposed) { this.#colourLatency = performance.now() - requested; this.#emit(true); }
      });
    }
    return true;
  }
  async #alignPlayback(frame: number, boundary: boolean): Promise<void> {
    if (this.#busy || !this.#document || !this.#playing) return;
    const signal = this.#beginOperation();
    this.#operationFrame = frame;
    this.#compositor.clear();
    this.#setStatus('buffering', boundary ? 'Loading next clip' : 'Waiting for decoded frames');
    if (boundary) this.#boundaryStalls++;
    try {
      let layers = sampleTimeline(this.#document, frame, this.#layout);
      await this.#prepareLayers(layers, signal);
      if (!this.#isCurrent(signal) || !this.#playing) return;
      layers = sampleTimeline(this.#document, frame, this.#layout);
      this.#drawFrame(frame); this.#playingClips = layers.map((layer) => layer.clipId);
      layers.forEach((layer) => {
        const placed = this.#layout.clips.find((item) => item.clip.id === layer.clipId)!;
        this.#slotFor(layer.clipId).setRate(placed.retiming.rateAt(frame - placed.start));
      });
      await this.#music.start(frame, signal);
      if (!this.#isCurrent(signal) || !this.#playing) return;
      await Promise.all(this.#playingClips.map((id) => this.#slotFor(id).play()));
      if (!this.#isCurrent(signal) || !this.#playing) return;
      this.#clockFrame = frame; this.#clockTime = performance.now(); this.#mismatchStart = 0;
      this.#busy = false; this.#setStatus('playing', 'Playing'); this.#preloadNext(frame);
    } catch (error) { if (this.#isCurrent(signal)) this.#handleError(error); }
  }
  readonly #tick = (now: number): void => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#tick);
    if (!this.#playing || this.#busy || !this.#document) { this.#emit(); return; }
    try { this.#advance(now); }
    catch (error) { this.#handleError(error); }
    this.#emit();
  };
  #acceptFrame(frame: number): boolean {
    if (!this.#drawFrame(frame)) return false;
    this.#mismatchStart = 0;
    if (this.#status === 'buffering') this.#setStatus('playing', 'Playing');
    return true;
  }
  #advance(now: number): void {
    if (!this.#document) return;
    // rAF's timestamp may precede a clock anchor set by a media promise in this
    // display cycle. Playback at frame zero must not request a negative frame.
    const elapsed = Math.max(0, now - this.#clockTime);
    const expected = this.#music.hasMusic ? this.#music.projectFrame() : this.#clockFrame + secondsToFrames(elapsed / 1000, this.#document.frameRate, 'floor');
    if (expected >= this.#layout.duration) { this.pause(); void this.seek(this.#layout.duration - 1); return; }
    const layers = sampleTimeline(this.#document, expected, this.#layout);
    if (!this.#music.sync(expected)) { void this.#alignPlayback(expected, false); return; }
    const required = layers.map((layer) => layer.clipId);
    if (required.some((id) => !this.#playingClips.includes(id))) { void this.#alignPlayback(expected, true); return; }
    const removed = this.#playingClips.filter((id) => !required.includes(id));
    removed.forEach((id) => this.#slotFor(id).pause()); this.#playingClips = required;
    if (removed.length) this.#preloadNext(expected);
    layers.forEach((layer) => {
      const position = this.#layout.clips.find((item) => item.clip.id === layer.clipId)!;
      this.#slotFor(layer.clipId).setRate(position.retiming.rateAt(expected - position.start));
    });
    if (this.#acceptFrame(expected)) return;
    // Enabled-layer gaps (including overlay-only tails) are valid black frames.
    const primary = layers[0];
    if (!primary) return;
    const placed = this.#layout.clips.find((item) => item.clip.id === primary.clipId)!;
    const actual = placed.start + placed.retiming.outputAt(this.#slotFor(primary.clipId).decodedFrame);
    const error = Math.abs(actual - expected);
    if (actual >= 0) this.#maxClockError = Math.max(this.#maxClockError, error);
    if (error <= 1 && actual >= 0 && actual < this.#layout.duration && this.#acceptFrame(actual)) return;
    this.#compositor.clear(); this.#setStatus('buffering', 'Waiting for decoded frames');
    if (!this.#mismatchStart) this.#mismatchStart = now;
    if (now - this.#mismatchStart > framesToSeconds(1, this.#document.frameRate) * 1000) void this.#alignPlayback(expected, false);
  }
  #handleError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (this.#disposed) return;
    this.#controller.abort(); this.#cancelPreloads();
    this.#playing = false; this.#busy = false;
    this.#music.pause();
    for (const slot of this.#slots) slot.pause();
    this.#playingClips = []; this.#compositor.clear();
    this.#setStatus('error', error instanceof Error ? error.message : 'Preview failed.');
  }
  capturePixels(): Uint8Array {
    if (!this.#drawFrame(this.#frame)) throw new Error('Cannot capture pixels without all required decoded frames.');
    return this.#compositor.readPixels();
  }
  readonly #onContextLost = (event: Event): void => {
    event.preventDefault(); this.pause();
    this.#resizePool(0); this.#compositor.dispose();
    this.#setStatus('error', 'WebGL context lost. Playback stopped.');
  };
  readonly #onContextRestored = (): void => {
    if (this.#disposed) return;
    try {
      this.#compositor.dispose(); this.#compositor = new Compositor(this.canvas);
      this.#compositor.setDecoderCount(this.#poolSize());
      this.#resizePool(this.#poolSize());
      this.#uploadedFrames.fill(-1); this.#dirty = true;
      if (this.#layout.duration) void this.seek(this.#frame);
      else this.#setStatus('empty', 'Add footage to the timeline');
    } catch (error) { this.#handleError(error); }
  };
  dispose(): void {
    if (this.#disposed) return;
    this.pause(); this.#disposed = true; cancelAnimationFrame(this.#raf);
    this.canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#resizePool(0);
    this.#music.dispose();
    this.#compositor.dispose(); this.#status = 'disposed'; this.#listeners.clear();
  }
}