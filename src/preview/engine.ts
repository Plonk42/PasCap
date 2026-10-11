import { colourSchema, NEUTRAL_COLOUR, type ColourSettings } from '../shared/colour.js';
import { isNeutralDetail, NEUTRAL_DETAIL } from '../shared/detail.js';
import { hasLayerKeys } from '../shared/keyframes.js';
import { projectSchema, type ProjectDocument, type VideoClip } from '../shared/model.js';
import {
  calculateLayout,
  layerClips,
  sampleTimeline,
  type PlacedClip,
  type PreviewLayer,
  type TimelineLayout,
} from '../shared/timeline.js';
import { PROJECT_FPS, sameRate, secondsToFrames } from '../shared/timing.js';
import { Compositor, MAX_VIDEO_DECODERS, type CompositeGroup } from './compositor.js';
import { MusicPlayback } from './music.js';
import { VideoStreams } from './video-streams.js';

export type PreviewStatus = 'empty' | 'loading' | 'paused' | 'playing' | 'seeking' | 'buffering' | 'error' | 'disposed';
/** Authoritative original metadata, never dimensions inferred from a proxy. */
export interface OriginalDimensions {
  readonly width: number;
  readonly height: number;
}
export type OriginalDimensionsResolver = (mediaId: string) => OriginalDimensions;
export interface PreviewDiagnostics {
  status: PreviewStatus;
  message: string;
  playing: boolean;
  ungraded: boolean;
  frame: number;
  duration: number;
  requestedFrame: number;
  /** Source frame in each decoder's texture, -1 when none. */
  decodedSourceFrames: number[];
  /** Decoded frames waiting in each decoder's queue. */
  queuedFrames: number[];
  previewFps: number;
  renderedFrames: number;
  decodedFrames: number;
  lastSeekMs: number | null;
  medianSeekMs: number | null;
  seekSamples: number;
  colourLatencyMs: number | null;
  stalls: number;
  boundaryStalls: number;
  stallMilliseconds: number;
  droppedDecodedFrames: number;
  activeDecoders: number;
  decoderCount: number;
  assignedClipIds: (string | null)[];
  renderer: string;
  gpuTextureMiB: number;
  jsHeapMiB: number | null;
  audioClock: boolean;
  musicDriftFrames: number;
}

/** Output frames whose source frames are requested ahead of the clock; the decoder budget bounds decoding. */
const STREAM_WINDOW = 60;
/** Decoded frames each active source holds before the clock starts. */
const PREFILL_FRAMES = 3;
/** A decoder that delivers nothing for this long has failed, not merely fallen behind. */
const STALL_DEADLINE_MS = 5_000;

/** One timeline video decoder and its compositor texture. */
interface Lane {
  readonly index: number;
  clipId: string | null;
  streaming: boolean;
  /** Next local output frame of the clip whose source frame is not yet requested. */
  requested: number;
  lastRequested: number;
  firstRequested: number | null;
  requestedCount: number;
  /** A frame of the assigned clip has been presented, so a later wait is mid-clip. */
  presented: boolean;
  shown: { mediaId: string; sourceFrame: number } | null;
  aspect: number;
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
    id: project.id,
    frameRate: project.frameRate,
    colourProfile: project.colourProfile,
    clips: project.clips
      .map(({ id, mediaId, layerId, start, sourceIn, sourceOut, speed }) => ({
        id,
        mediaId,
        layerId,
        start,
        sourceIn,
        sourceOut,
        speed,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    tracks: project.layers
      .filter((layer) => project.clips.some((clip) => clip.layerId === layer.id))
      .map((layer) => ({
        id: layer.id,
        ripple: layer.ripple,
        order: layerClips(project, layer.id).map((clip) => clip.id),
        transitions: layer.transitions,
        opening: layer.openingFade,
        closing: layer.closingFade,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    music: project.music,
  });
}

/**
 * Exact decoded source frames composed on one clock. WebCodecs decoders run in
 * a worker, two per track at most: the active clip and the next one, or both
 * dissolve sources. A frame is drawn only when every active source has its
 * exact frame for the clock frame; otherwise the image holds and playback is
 * buffering until the decoders deliver.
 */
export class PreviewEngine {
  #compositor: Compositor;
  readonly #music = new MusicPlayback();
  readonly #streams: VideoStreams;
  readonly #lanes: Lane[] = [];
  #proxyUrl: (mediaId: string) => string = () => {
    throw new Error('No media resolver loaded.');
  };
  #document: ProjectDocument | null = null;
  #originalDimensions: OriginalDimensionsResolver = () => {
    throw new Error('No original-dimensions resolver loaded.');
  };
  #layout: TimelineLayout = { clips: [], transitions: [], duration: 0 };
  #controller = new AbortController();
  #operationFrame = 0;
  readonly #listeners = new Set<(diagnostics: PreviewDiagnostics) => void>();
  #raf = 0;
  #disposed = false;
  #playing = false;
  #ungraded = false;
  #busy = false;
  #status: PreviewStatus = 'empty';
  #message = 'Add footage to the timeline';
  #frame = 0;
  #clockFrame = 0;
  #clockTime = 0;
  /** Without music, the clock stops at a frame the decoders have not delivered. */
  #clockHeld = false;
  #lastDrawnFrame = -1;
  #surfaceKey: string | null = null;
  #dirty = true;
  #lastEmit = 0;
  readonly #seekTimes: number[] = [];
  readonly #renderTimes: number[] = [];
  #renderedFrames = 0;
  #colourRequested = 0;
  #colourLatency: number | null = null;
  #stalls = 0;
  #boundaryStalls = 0;
  #stallStart = 0;
  #stallTotal = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    if (typeof VideoDecoder !== 'function' || typeof VideoFrame !== 'function')
      throw new Error('Timeline preview requires WebCodecs video decoding. Use a current Chrome or Firefox.');
    canvas.width = 1280;
    canvas.height = 720;
    try {
      this.#compositor = new Compositor(canvas);
    } catch (error) {
      this.#music.dispose();
      throw error;
    }
    this.#streams = new VideoStreams(MAX_VIDEO_DECODERS);
    canvas.addEventListener('webglcontextlost', this.#onContextLost);
    canvas.addEventListener('webglcontextrestored', this.#onContextRestored);
    this.#raf = requestAnimationFrame(this.#tick);
  }
  subscribe(listener: (diagnostics: PreviewDiagnostics) => void): () => void {
    this.#listeners.add(listener);
    listener(this.diagnostics());
    return () => {
      this.#listeners.delete(listener);
    };
  }
  diagnostics(): PreviewDiagnostics {
    const now = performance.now();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const recent = this.#renderTimes.filter((time) => time >= now - 2_000);
    const interval = recent.length > 1 ? Math.max(1_000, recent.at(-1)! - recent[0]!) : 2_000;
    return {
      status: this.#status,
      message: this.#message,
      playing: this.#playing,
      ungraded: this.#ungraded,
      frame: this.#frame,
      duration: this.#layout.duration,
      requestedFrame: this.#operationFrame,
      decodedSourceFrames: this.#lanes.map((lane) => lane.shown?.sourceFrame ?? -1),
      queuedFrames: this.#lanes.map((lane) => this.#streams.queued(lane.index)),
      previewFps: this.#playing ? (Math.max(0, recent.length - 1) / interval) * 1000 : 0,
      renderedFrames: this.#renderedFrames,
      decodedFrames: this.#streams.decodedFrames,
      lastSeekMs: this.#seekTimes.at(-1) ?? null,
      medianSeekMs: median(this.#seekTimes),
      seekSamples: this.#seekTimes.length,
      colourLatencyMs: this.#colourLatency,
      stalls: this.#stalls,
      boundaryStalls: this.#boundaryStalls,
      stallMilliseconds: this.#stallTotal + (this.#stallStart ? now - this.#stallStart : 0),
      droppedDecodedFrames: this.#streams.droppedFrames,
      activeDecoders: this.#lanes.filter((lane) => lane.streaming).length,
      decoderCount: this.#lanes.length,
      assignedClipIds: this.#lanes.map((lane) => lane.clipId),
      renderer: this.#compositor.renderer,
      gpuTextureMiB: this.#compositor.gpuTextureMiB,
      jsHeapMiB: memory ? memory.usedJSHeapSize / 1024 ** 2 : null,
      audioClock: this.#music.hasMusic,
      musicDriftFrames: this.#music.errorFrames,
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
    this.#status = status;
    this.#message = message;
    this.#emit(true);
  }
  #beginStall(boundary: boolean, now: number): void {
    if (!this.#stallStart) {
      this.#stallStart = now;
      this.#stalls++;
      if (boundary) this.#boundaryStalls++;
    }
    this.#setStatus('buffering', boundary ? 'Loading next clip' : 'Waiting for decoded frames');
  }
  #endStall(now: number): void {
    if (!this.#stallStart) return;
    this.#stallTotal += now - this.#stallStart;
    this.#stallStart = 0;
  }
  #stopStreams(): void {
    for (const lane of this.#lanes) {
      if (!lane.streaming) continue;
      lane.streaming = false;
      this.#streams.stop(lane.index);
    }
  }
  #beginOperation(): AbortSignal {
    this.#music.pause();
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#busy = true;
    this.#stopStreams();
    return this.#controller.signal;
  }
  #isCurrent(signal: AbortSignal): boolean {
    return !this.#disposed && !signal.aborted && signal === this.#controller.signal;
  }

  /** Two decoders per track, and none without footage or WebGL. */
  #resizeLanes(): void {
    const count =
      this.#document?.clips.length && this.#compositor.available ? 2 * this.#document.layers.length : 0;
    while (this.#lanes.length > count) {
      const lane = this.#lanes.pop()!;
      if (lane.streaming) this.#streams.stop(lane.index);
    }
    while (this.#lanes.length < count)
      this.#lanes.push({
        index: this.#lanes.length,
        clipId: null,
        streaming: false,
        requested: 0,
        lastRequested: -1,
        firstRequested: null,
        requestedCount: 0,
        presented: false,
        shown: null,
        aspect: 16 / 9,
      });
    if (this.#compositor.available) this.#compositor.setDecoderCount(count);
  }
  #placed(clipId: string): PlacedClip {
    const placed = this.#layout.clips.find((item) => item.clip.id === clipId);
    if (!placed) throw new Error('A required clip is missing from the timeline layout.');
    return placed;
  }
  #laneOf(clipId: string): Lane | undefined {
    return this.#lanes.find((lane) => lane.clipId === clipId);
  }
  #shows(lane: Lane | undefined, layer: PreviewLayer): boolean {
    return lane?.shown?.mediaId === layer.mediaId && lane.shown.sourceFrame === layer.sourceFrame;
  }
  #release(lane: Lane): void {
    if (lane.streaming) this.#streams.stop(lane.index);
    lane.streaming = false;
    lane.clipId = null;
  }
  /** Keep assigned decoders, reuse a free one already showing the first frame, else the lowest free one. */
  #assignLanes(wanted: readonly { clip: VideoClip; sourceFrame: number }[]): Lane[] {
    const ids = new Set(wanted.map(({ clip }) => clip.id));
    for (const lane of this.#lanes) if (lane.clipId !== null && !ids.has(lane.clipId)) this.#release(lane);
    const lanes = wanted.map(
      ({ clip, sourceFrame }) =>
        this.#laneOf(clip.id) ??
        this.#claim(
          clip,
          this.#lanes.find(
            (lane) =>
              lane.clipId === null && lane.shown?.mediaId === clip.mediaId && lane.shown.sourceFrame === sourceFrame,
          ),
        ),
    );
    return wanted.map(({ clip }, index) => {
      const lane = lanes[index] ?? this.#claim(clip, this.#lanes.find((item) => item.clipId === null));
      if (!lane) throw new Error('Active clips exceed the decoder budget of two per track.');
      return lane;
    });
  }
  #claim(clip: VideoClip, lane: Lane | undefined): Lane | undefined {
    if (lane) {
      lane.clipId = clip.id;
      lane.presented = false;
    }
    return lane;
  }
  /** Request the source frames of the clip's next output frames, without repeats of a held frame. */
  #requestFrames(lane: Lane, placed: PlacedClip, until: number): number[] {
    const end = Math.min(until, placed.duration);
    const frames: number[] = [];
    for (; lane.requested < end; lane.requested++) {
      const source = placed.retiming.sourceAt(lane.requested);
      if (source === lane.lastRequested) continue;
      frames.push(source);
      lane.lastRequested = source;
    }
    lane.requestedCount += frames.length;
    return frames;
  }
  #startStream(lane: Lane, placed: PlacedClip, local: number): void {
    lane.streaming = true;
    lane.requested = local;
    lane.requestedCount = 0;
    const first = placed.retiming.sourceAt(local);
    lane.lastRequested = lane.shown?.mediaId === placed.clip.mediaId && lane.shown.sourceFrame === first ? first : -1;
    const frames = this.#requestFrames(lane, placed, local + STREAM_WINDOW);
    lane.firstRequested = frames[0] ?? null;
    this.#streams.start(
      lane.index,
      this.#proxyUrl(placed.clip.mediaId),
      frames,
      lane.requested >= placed.duration,
    );
  }
  #extendStream(lane: Lane, placed: PlacedClip, local: number): void {
    if (lane.requested >= placed.duration || lane.requested - local > STREAM_WINDOW / 2) return;
    const frames = this.#requestFrames(lane, placed, local + STREAM_WINDOW);
    this.#streams.extend(lane.index, frames, lane.requested >= placed.duration);
  }
  /** Keep decoders streaming the active clips and, on tracks with one active clip, the next one. */
  #schedule(frame: number, layers: readonly PreviewLayer[]): void {
    const wanted: { placed: PlacedClip; local: number }[] = [];
    for (const layer of this.#document!.layers) {
      if (!layer.enabled) continue;
      const active = layers.filter((item) => item.layerId === layer.id).map((item) => this.#placed(item.clipId));
      wanted.push(...active.map((placed) => ({ placed, local: frame - placed.start })));
      const next =
        active.length < 2 &&
        this.#layout.clips.find((placed) => placed.clip.layerId === layer.id && placed.start > frame);
      if (next) wanted.push({ placed: next, local: 0 });
    }
    const lanes = this.#assignLanes(
      wanted.map(({ placed, local }) => ({ clip: placed.clip, sourceFrame: placed.retiming.sourceAt(local) })),
    );
    wanted.forEach(({ placed, local }, index) => {
      const lane = lanes[index]!;
      if (lane.streaming) this.#extendStream(lane, placed, local);
      else this.#startStream(lane, placed, local);
    });
  }
  /** Upload the exact decoded frame for `layer`; false while it is not decoded yet. */
  #present(lane: Lane, layer: PreviewLayer): boolean {
    const frame = this.#streams.take(lane.index, layer.sourceFrame);
    if (!frame) return false;
    try {
      this.#compositor.uploadFrame(lane.index, frame);
      lane.aspect = frame.displayWidth / frame.displayHeight;
    } finally {
      frame.close();
    }
    lane.shown = { mediaId: layer.mediaId, sourceFrame: layer.sourceFrame };
    lane.presented = true;
    return true;
  }
  /** Decode and draw one exact paused frame, reusing textures that already show it. */
  async #showFrame(frame: number, signal: AbortSignal): Promise<void> {
    const layers = sampleTimeline(this.#document!, frame, this.#layout);
    const lanes = this.#assignLanes(
      layers.map((layer) => ({ clip: this.#placed(layer.clipId).clip, sourceFrame: layer.sourceFrame })),
    );
    await Promise.all(
      layers.map(async (layer, index) => {
        const lane = lanes[index]!;
        if (this.#shows(lane, layer)) return;
        lane.streaming = true;
        this.#streams.start(lane.index, this.#proxyUrl(layer.mediaId), [layer.sourceFrame], true);
        await this.#streams.ready(lane.index, layer.sourceFrame, 1, signal);
        if (!this.#isCurrent(signal)) return;
        this.#present(lane, layer);
        lane.streaming = false;
        this.#streams.stop(lane.index);
      }),
    );
    if (!this.#isCurrent(signal)) return;
    // An appearance update during the decode can make other sources visible.
    if (this.#drawFrame(frame)) return;
    if (!this.#compositor.available) throw new Error('WebGL context is unavailable.');
    await this.#showFrame(frame, signal);
  }

  /** Detail shader variants compile when a document first needs them, before any draw uses them. */
  #prepareDetail(): void {
    const document = this.#document;
    if (
      this.#compositor.available &&
      document &&
      (document.clips.some((clip) => !isNeutralDetail(clip.detail)) ||
        document.layers.some((layer) => layer.colour.hdr !== 0 || hasLayerKeys(layer, 'hdr')))
    )
      this.#compositor.prepareDetail();
  }
  async loadProject(
    document: ProjectDocument,
    proxyUrl: (mediaId: string) => string,
    originalDimensions: OriginalDimensionsResolver,
    initialFrame = 0,
  ): Promise<void> {
    if (this.#disposed) throw new Error('The preview engine is disposed.');
    if (typeof originalDimensions !== 'function') throw new Error('Original-dimensions resolver is required.');
    if (!Number.isFinite(initialFrame)) throw new Error('Initial preview frame must be finite.');
    const snapshot = projectSchema.parse(document);
    if (!sameRate(snapshot.frameRate, PROJECT_FPS)) throw new Error('Preview requires 30000/1001 fps video.');
    this.pause();
    const signal = this.#beginOperation();
    if (snapshot.id !== this.#document?.id) this.#ungraded = false;
    this.#document = snapshot;
    this.#prepareDetail();
    this.#layout = calculateLayout(snapshot);
    this.#proxyUrl = proxyUrl;
    this.#originalDimensions = originalDimensions;
    this.#frame = Math.max(0, Math.min(Math.round(initialFrame), this.#layout.duration - 1));
    this.#operationFrame = this.#frame;
    this.#lastDrawnFrame = -1;
    this.#dirty = true;
    this.#setStatus('loading', 'Loading preview');
    try {
      this.#resizeLanes();
      await this.#music.configure(snapshot.music, signal);
      if (!this.#isCurrent(signal)) return;
      if (!this.#compositor.available) throw new Error('WebGL context is unavailable.');
      if (!this.#layout.duration) {
        this.#clearSurface();
        this.#busy = false;
        this.#setStatus('empty', 'Add footage to the timeline');
        return;
      }
      await this.#showFrame(this.#frame, signal);
      if (!this.#isCurrent(signal)) return;
      this.#busy = false;
      this.#setStatus('paused', 'Paused');
    } catch (error) {
      if (this.#isCurrent(signal)) this.#handleError(error);
    }
  }
  async seek(frame: number): Promise<void> {
    if (this.#disposed || !this.#document || !this.#layout.duration) return;
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.#layout.duration)
      throw new Error('Requested project frame is outside the timeline.');
    this.pause();
    const signal = this.#beginOperation();
    const started = performance.now();
    this.#operationFrame = frame;
    this.#setStatus('seeking', `Seeking frame ${frame}`);
    try {
      await this.#showFrame(frame, signal);
      if (!this.#isCurrent(signal)) return;
      this.#busy = false;
      this.#seekTimes.push(performance.now() - started);
      if (this.#seekTimes.length > 200) this.#seekTimes.shift();
      this.#setStatus('paused', 'Paused');
    } catch (error) {
      if (this.#isCurrent(signal)) this.#handleError(error);
    }
  }
  /** Paused redraws reuse the exact textures, decoding only when a source is not shown yet. */
  #redrawPaused(): void {
    if (!this.#playing && !this.#busy && this.#status === 'paused' && !this.#drawFrame(this.#frame))
      void this.seek(this.#frame);
  }
  /** Editor-only bypass of Colour and clip detail filters: keep source clocks, coverage and saved settings. */
  setUngraded(enabled: boolean): void {
    if (this.#disposed || !this.#document || this.#ungraded === enabled) return;
    this.#ungraded = enabled;
    this.#dirty = true;
    this.#redrawPaused();
    this.#emit(true);
  }
  updateColour(layerId: string, settings: ColourSettings): void {
    if (!this.#document) return;
    const layer = this.#document.layers.find((item) => item.id === layerId);
    if (!layer) throw new Error('The graded track does not exist.');
    layer.colour = colourSchema.parse(settings);
    this.#prepareDetail();
    this.#dirty = true;
    this.#colourRequested = performance.now();
    this.#redrawPaused();
  }
  /** No music configuration or retiming reload for opacity/colour/spatial/stacking edits. */
  updateProjectAppearance(document: ProjectDocument): void {
    if (this.#disposed || !this.#document) throw new Error('Load a project before updating its appearance.');
    const snapshot = projectSchema.parse(document);
    if (timingKey(snapshot) !== timingKey(this.#document))
      throw new Error(
        'Appearance updates must preserve project timing; use loadProject for source, placement, speed, transitions or music changes.',
      );
    this.#document = snapshot;
    this.#prepareDetail();
    this.#layout = calculateLayout(snapshot);
    this.#resizeLanes();
    this.#dirty = true;
    this.#colourRequested = performance.now();
    if (!this.#layout.duration || !this.#compositor.available) {
      this.#clearSurface();
      return;
    }
    // Playback schedules newly visible sources on its next frame.
    this.#redrawPaused();
  }
  async play(): Promise<void> {
    if (!this.#document || !this.#layout.duration || this.#disposed || this.#playing || this.#busy) return;
    if (this.#frame >= this.#layout.duration - 1) {
      const reset = this.seek(0);
      const signal = this.#controller.signal;
      await reset;
      if (!this.#isCurrent(signal)) return;
    }
    if (this.#status === 'error') return;
    const signal = this.#beginOperation();
    this.#operationFrame = this.#frame;
    try {
      await this.#music.resumeContext(signal);
      if (!this.#isCurrent(signal)) return;
      this.#playing = true;
      this.#renderTimes.length = 0;
      await this.#startPlayback(this.#frame);
    } catch (error) {
      if (this.#isCurrent(signal)) this.#handleError(error);
    }
  }
  /** Prefill every active source, then start the clock (music output or wall clock) at `frame`. */
  async #startPlayback(frame: number): Promise<void> {
    const signal = this.#beginOperation();
    this.#operationFrame = frame;
    this.#setStatus('buffering', 'Starting playback');
    try {
      const layers = sampleTimeline(this.#document!, frame, this.#layout);
      this.#schedule(frame, layers);
      await Promise.all(
        layers.map((layer) => {
          const lane = this.#laneOf(layer.clipId)!;
          if (lane.firstRequested === null) return undefined;
          const count = Math.min(PREFILL_FRAMES, lane.requestedCount);
          return this.#streams.ready(lane.index, lane.firstRequested, count, signal);
        }),
      );
      if (!this.#isCurrent(signal) || !this.#playing) return;
      await this.#music.start(frame, signal);
      if (!this.#isCurrent(signal) || !this.#playing) return;
      this.#clockFrame = frame;
      this.#clockTime = performance.now();
      this.#clockHeld = false;
      this.#busy = false;
      this.#advance(performance.now());
    } catch (error) {
      if (this.#isCurrent(signal)) this.#handleError(error);
    }
  }
  pause(): void {
    this.#music.pause();
    this.#playing = false;
    this.#controller.abort();
    this.#busy = false;
    this.#stopStreams();
    this.#endStall(performance.now());
    if (this.#document && this.#status !== 'empty' && this.#status !== 'error') this.#setStatus('paused', 'Paused');
  }
  #clearSurface(): void {
    this.#surfaceKey = null;
    this.#compositor.clear();
  }
  #drawFrame(frame: number): boolean {
    if (!this.#document || !this.#compositor.available) return false;
    const layers = sampleTimeline(this.#document, frame, this.#layout);
    if (layers.some((layer) => !this.#shows(this.#laneOf(layer.clipId), layer))) return false;
    const groups: CompositeGroup[] = [];
    for (const group of this.#document.layers) {
      const members = layers.filter((layer) => layer.layerId === group.id);
      if (!members.length) continue;
      groups.push({
        clips: members.map((layer) => {
          const dimensions = this.#originalDimensions(layer.mediaId);
          if (
            !dimensions ||
            !Number.isInteger(dimensions.width) ||
            dimensions.width <= 0 ||
            !Number.isInteger(dimensions.height) ||
            dimensions.height <= 0
          )
            throw new Error('Original media dimensions must be positive integers.');
          const lane = this.#laneOf(layer.clipId)!;
          return {
            slot: lane.index,
            settings: this.#ungraded ? NEUTRAL_COLOUR : layer.colour,
            aspect: lane.aspect,
            spatial: layer.spatial,
            detail: this.#ungraded ? NEUTRAL_DETAIL : layer.detail,
            originalWidth: dimensions.width,
            originalHeight: dimensions.height,
            opacity: layer.opacity,
            blendWeight: layer.blendWeight,
            brightness: layer.brightness,
          };
        }),
      });
    }
    this.#renderSurface(frame, layers, groups);
    this.#dirty = false;
    this.#frame = frame;
    if (this.#colourRequested) {
      const requested = this.#colourRequested;
      this.#colourRequested = 0;
      requestAnimationFrame(() => {
        if (!this.#disposed) {
          this.#colourLatency = performance.now() - requested;
          this.#emit(true);
        }
      });
    }
    return true;
  }
  #renderSurface(frame: number, layers: readonly PreviewLayer[], groups: readonly CompositeGroup[]): void {
    // A held source with identical evaluated appearance is the same image,
    // even at a later project frame: skip the redundant grade. Include every
    // composed value and source identity, not inverse source time.
    const surfaceKey = JSON.stringify({
      width: this.canvas.width,
      height: this.canvas.height,
      sources: layers.map(({ clipId, mediaId, sourceFrame }) => ({ clipId, mediaId, sourceFrame })),
      groups,
    });
    const redraw = this.#dirty || this.#surfaceKey !== surfaceKey;
    if (redraw) {
      this.#compositor.drawFrame(groups);
      this.#surfaceKey = surfaceKey;
    }
    if (redraw && (frame !== this.#lastDrawnFrame || this.#dirty)) {
      this.#renderedFrames++;
      if (this.#playing) {
        this.#renderTimes.push(performance.now());
        if (this.#renderTimes.length > 300) this.#renderTimes.shift();
      }
      this.#lastDrawnFrame = frame;
    }
  }
  readonly #tick = (now: number): void => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#tick);
    if (this.#playing && this.#document && !this.#busy) {
      try {
        this.#advance(now);
      } catch (error) {
        this.#handleError(error);
      }
    }
    this.#emit();
  };
  #expectedFrame(now: number): number {
    // rAF may precede a clock anchor established in this display cycle.
    const elapsed = Math.max(0, now - this.#clockTime);
    return this.#music.hasMusic
      ? this.#music.projectFrame()
      : this.#clockFrame + secondsToFrames(elapsed / 1000, this.#document!.frameRate, 'floor');
  }
  #advance(now: number): void {
    const document = this.#document!;
    const frame = this.#clockHeld ? this.#clockFrame : this.#expectedFrame(now);
    this.#operationFrame = frame;
    if (frame >= this.#layout.duration) {
      this.pause();
      void this.seek(this.#layout.duration - 1);
      return;
    }
    if (!this.#music.sync()) {
      // Music cannot follow video: restart both at the current frame.
      this.#beginStall(false, now);
      void this.#startPlayback(frame);
      return;
    }
    const layers = sampleTimeline(document, frame, this.#layout);
    this.#schedule(frame, layers);
    const waiting = layers
      .map((layer) => ({ layer, lane: this.#laneOf(layer.clipId)! }))
      .filter(({ layer, lane }) => !this.#shows(lane, layer) && !this.#present(lane, layer));
    if (waiting.length) {
      // Music cannot wait for video; the wall clock can.
      if (!this.#music.hasMusic) {
        this.#clockFrame = frame;
        this.#clockHeld = true;
      }
      this.#beginStall(
        waiting.some(({ lane }) => !lane.presented),
        now,
      );
      if (now - this.#stallStart > STALL_DEADLINE_MS) {
        const { lane, layer } = waiting[0]!;
        throw new Error(
          `Video decoder ${lane.index + 1} did not deliver source frame ${layer.sourceFrame} within 5 seconds.`,
        );
      }
      return;
    }
    if (this.#clockHeld) {
      this.#clockTime = now;
      this.#clockHeld = false;
    }
    this.#drawFrame(frame);
    this.#endStall(now);
    this.#setStatus('playing', 'Playing');
  }
  #handleError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    if (this.#disposed) return;
    this.#controller.abort();
    this.#playing = false;
    this.#busy = false;
    this.#music.pause();
    this.#stopStreams();
    this.#endStall(performance.now());
    this.#clearSurface();
    this.#setStatus('error', error instanceof Error ? error.message : 'Preview failed.');
  }
  capturePixels(): Uint8Array {
    // The presented image can be retained, but WebGL's non-preserved drawing
    // buffer may be discarded after presentation. Readback always needs a draw.
    this.#surfaceKey = null;
    if (!this.#drawFrame(this.#frame)) throw new Error('Cannot capture pixels without all required decoded frames.');
    return this.#compositor.readPixels();
  }
  readonly #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.pause();
    this.#compositor.dispose();
    this.#resizeLanes();
    this.#setStatus('error', 'WebGL context lost. Playback stopped.');
  };
  readonly #onContextRestored = (): void => {
    if (this.#disposed) return;
    try {
      this.#compositor.dispose();
      this.#compositor = new Compositor(this.canvas);
      this.#prepareDetail();
      this.#resizeLanes();
      this.#dirty = true;
      if (this.#layout.duration) void this.seek(this.#frame);
      else this.#setStatus('empty', 'Add footage to the timeline');
    } catch (error) {
      this.#handleError(error);
    }
  };
  dispose(): void {
    if (this.#disposed) return;
    this.pause();
    this.#disposed = true;
    this.#ungraded = false;
    cancelAnimationFrame(this.#raf);
    this.canvas.removeEventListener('webglcontextlost', this.#onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#compositor.dispose();
    this.#resizeLanes();
    this.#streams.dispose();
    this.#music.dispose();
    this.#status = 'disposed';
    this.#listeners.clear();
  }
}
