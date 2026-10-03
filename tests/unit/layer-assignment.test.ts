import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allocateDecoders, assignDecoders, decoderPoolSize, MAX_DECODER_SLOTS } from '../../src/preview/assignment.js';
import type { CompositeGroup } from '../../src/preview/compositor.js';
import { PreviewEngine } from '../../src/preview/engine.js';
import { gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { compositePixel } from '../../src/shared/composition.js';
import { EMPTY_KEY_VALUES, type Interpolation, type LayerKeyframe, type LayerKeyValues } from '../../src/shared/keyframes.js';
import { createClip, createProject, type MusicTrack, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { framesToSeconds } from '../../src/shared/timing.js';

interface TestSlot {
  index: number; video: HTMLVideoElement; decodedFrame: number; ready: boolean; disposed: boolean;
  playing: boolean; url: string; observedFrames: number; lateCallbacks: number; droppedFrames: number; aspect: number;
  loads: { url: string; signal: AbortSignal }[]; seeks: number[]; rates: number[]; playCalls: number;
}
interface TestCompositor {
  lost: boolean; disposed: boolean; count: number; groups: CompositeGroup[]; clears: number;
  uploads: { slot: number; video: HTMLVideoElement }[];
}
interface TestMusic {
  configured: (MusicTrack | null)[]; starts: number[]; pauses: number; resumes: number; disposed: boolean;
}

const state = vi.hoisted(() => ({
  slots: [] as TestSlot[], compositors: [] as TestCompositor[], music: [] as TestMusic[],
  now: 1000, peakSlots: 0, nextRaf: 0, raf: new Map<number, FrameRequestCallback>(),
  onLoad: null as ((url: string, signal: AbortSignal) => Promise<void>) | null,
  onResume: null as (() => Promise<void>) | null,
  onStart: null as ((signal: AbortSignal) => Promise<void>) | null,
  musicSync: true, failCompositor: false,
}));

vi.mock('../../src/preview/decoder.js', () => ({
  VideoDecoderSlot: class implements TestSlot {
    readonly video = {} as HTMLVideoElement;
    decodedFrame = -1; ready = false; disposed = false; playing = false; url = '';
    observedFrames = 0; lateCallbacks = 0; droppedFrames = 0; aspect = 16 / 9;
    readonly loads: { url: string; signal: AbortSignal }[] = [];
    readonly seeks: number[] = [];
    readonly rates: number[] = [];
    playCalls = 0;
    constructor(_container: unknown, readonly index: number) {
      state.slots.push(this);
      state.peakSlots = Math.max(state.peakSlots, state.slots.filter((slot) => !slot.disposed).length);
    }
    async load(url: string, _rate: unknown, signal: AbortSignal): Promise<void> {
      this.loads.push({ url, signal });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (this.url === url && this.ready) return;
      this.url = url; this.ready = false; this.decodedFrame = -1;
      await state.onLoad?.(url, signal);
      if (signal.aborted || this.disposed || this.url !== url) throw new DOMException('Cancelled', 'AbortError');
      this.decodedFrame = 0; this.ready = true; this.observedFrames++;
    }
    async seek(frame: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted || this.disposed) throw new DOMException('Cancelled', 'AbortError');
      this.seeks.push(frame); this.decodedFrame = frame; this.ready = true; this.observedFrames++;
    }
    setRate(rate: number): void { this.rates.push(rate); }
    async play(): Promise<void> { if (!this.disposed) { this.playCalls++; this.playing = true; } }
    pause(): void { this.playing = false; }
    dispose(): void { this.pause(); this.disposed = true; this.ready = false; }
  },
}));

vi.mock('../../src/preview/compositor.js', () => ({
  Compositor: class implements TestCompositor {
    readonly renderer = 'unit-test';
    readonly gl = { isContextLost: () => this.lost };
    lost = false; disposed = false; count = 2; groups: CompositeGroup[] = []; clears = 0;
    readonly uploads: { slot: number; video: HTMLVideoElement }[] = [];
    constructor() {
      if (state.failCompositor) throw new Error('Synthetic GPU allocation failed.');
      state.compositors.push(this);
    }
    get available(): boolean { return !this.disposed && !this.lost; }
    get gpuTextureMiB(): number { return this.lost || this.disposed ? 0 : this.count * 4 / 1024 ** 2; }
    setDecoderCount(count: number): void { this.count = count; }
    uploadVideo(slot: number, video: HTMLVideoElement): void { this.uploads.push({ slot, video }); }
    drawFrame(groups: readonly CompositeGroup[]): void { this.groups = structuredClone(groups) as CompositeGroup[]; }
    clear(): void { this.groups = []; this.clears++; }
    readPixels(): Uint8Array { return new Uint8Array([0, 0, 0, 255]); }
    dispose(): void { this.disposed = true; this.count = 0; }
  },
}));

vi.mock('../../src/preview/music.js', () => ({
  MusicPlayback: class implements TestMusic {
    readonly configured: (MusicTrack | null)[] = [];
    readonly starts: number[] = [];
    pauses = 0; resumes = 0; disposed = false; hasMusic = false; errorFrames = 0;
    clockFrame = 0; clockTime = 0;
    constructor() { state.music.push(this); }
    async configure(track: MusicTrack | null): Promise<void> { this.configured.push(track); this.hasMusic = track !== null; }
    async resumeContext(): Promise<void> { this.resumes++; await state.onResume?.(); }
    async start(frame: number, signal: AbortSignal): Promise<void> {
      await state.onStart?.(signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.starts.push(frame); this.clockFrame = frame; this.clockTime = state.now;
    }
    projectFrame(): number { return this.clockFrame + Math.floor(Math.max(0, state.now - this.clockTime) * 30000 / 1001 / 1000 + 1e-7); }
    sync(): boolean { return state.musicSync; }
    pause(): void { this.pauses++; }
    dispose(): void { this.disposed = true; }
  },
}));

const engines: PreviewEngine[] = [];
const resolver = (id: string): string => `/${id}`;
function makeEngine(): PreviewEngine {
  const engine = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
  engines.push(engine); return engine;
}
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function makeProject(layerCount = 1, dissolve = false): ProjectDocument {
  const project = createProject('layers', 'Layers');
  project.clips.push(createClip('base', 'base-media', 40, 100));
  const duration = dissolve ? 102 : 60;
  if (dissolve) {
    project.clips.push(createClip('next', 'next-media', 140, 200));
    project.transitions.push({ leftId: 'base', rightId: 'next', type: 'cross-dissolve', duration: 18 });
  }
  for (let index = 1; index < layerCount; index++) {
    const id = `video-${index + 1}`;
    project.layers.push({ id, name: `Video ${index + 1}`, enabled: true, opacity: 1, keyframes: [] });
    project.clips.push({ ...createClip(`overlay-${index}`, `overlay-media-${index}`, 200 + index * 100, 200 + index * 100 + duration), layerId: id });
  }
  return project;
}
function compositor(): TestCompositor { return state.compositors.at(-1)!; }
function liveSlots(): TestSlot[] { return state.slots.filter((slot) => !slot.disposed); }
function calls(): { loads: number; seeks: number; plays: number } {
  return {
    loads: state.slots.reduce((sum, slot) => sum + slot.loads.length, 0),
    seeks: state.slots.reduce((sum, slot) => sum + slot.seeks.length, 0),
    plays: state.slots.reduce((sum, slot) => sum + slot.playCalls, 0),
  };
}
function observeFrame(engine: PreviewEngine, project: ProjectDocument, frame: number): void {
  const assignments = engine.diagnostics().assignedClipIds;
  for (const layer of sampleTimeline(project, frame)) {
    const index = assignments.indexOf(layer.clipId);
    if (index < 0) continue;
    liveSlots()[index]!.decodedFrame = layer.sourceFrame;
  }
}
function animationFrame(now: number, timestamp = now): void {
  state.now = now;
  const pending = [...state.raf.values()]; state.raf.clear();
  pending.forEach((callback) => callback(timestamp));
}
function settle(): Promise<void> {
  return Array.from({ length: 32 }).reduce<Promise<void>>((pending) => pending.then(() => undefined), Promise.resolve());
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function expectedGroups(project: ProjectDocument, frame: number, assignments: readonly (string | null)[]): CompositeGroup[] {
  const samples = sampleTimeline(project, frame);
  return project.layers.flatMap((layer) => {
    const members = samples.filter((sample) => sample.layerId === layer.id);
    return members.length ? [{
      opacity: members[0]!.layerOpacity, clips: members.map((sample) => ({
        slot: assignments.indexOf(sample.clipId), settings: sample.colour, aspect: 16 / 9,
        opacity: sample.opacity, brightness: sample.brightness, blendWeight: sample.blendWeight,
      }))
    }] : [];
  });
}
function groupPixel(groups: readonly CompositeGroup[], source: (slot: number) => RGB): RGB {
  let result = [0, 0, 0];
  for (const group of groups) {
    const colour = [0, 0, 0]; let alpha = 0;
    for (const clip of group.clips) {
      const graded = gradePixel(source(clip.slot), clip.settings);
      const coverage = clip.opacity * clip.blendWeight; alpha += coverage;
      graded.forEach((channel, index) => { colour[index]! += channel * coverage * clip.brightness; });
    }
    result = result.map((channel, index) => colour[index]! * group.opacity + channel * (1 - alpha * group.opacity));
  }
  return result as unknown as RGB;
}

beforeEach(() => {
  state.slots.length = 0; state.compositors.length = 0; state.music.length = 0;
  state.now = 1000; state.peakSlots = 0; state.nextRaf = 0; state.raf.clear();
  state.onLoad = null; state.onResume = null; state.onStart = null; state.musicSync = true; state.failCompositor = false;
  vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  vi.stubGlobal('document', { body: {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++state.nextRaf; state.raf.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => state.raf.delete(id));
});
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('bounded layer decoder assignment', () => {
  it('retains the exact two-slot legacy helper and its over-capacity rejection', () => {
    expect(assignDecoders(['a', 'b'], ['b', 'c'])).toEqual(['c', 'b']);
    expect(() => assignDecoders([null, null], ['a', 'b', 'c'])).toThrow();
  });
  it('allocates two baseline slots and only layer count + one for multi-layer projects', () => {
    expect(decoderPoolSize(0)).toBe(0); expect(decoderPoolSize(1)).toBe(2);
    expect(decoderPoolSize(2)).toBe(3); expect(decoderPoolSize(8)).toBe(9);
    expect(() => decoderPoolSize(9)).toThrow(); expect(() => decoderPoolSize(1.5)).toThrow();
    expect(() => decoderPoolSize(-1)).toThrow(); expect(MAX_DECODER_SLOTS).toBe(16);
  });
  it('preserves all active instances and prefers a free slot over a preloaded one', () => {
    const current = ['next-base', 'overlay', 'base', null];
    expect(allocateDecoders(current, ['base', 'overlay', 'new-overlay'])).toEqual(['next-base', 'overlay', 'base', 'new-overlay']);
    expect(current).toEqual(['next-base', 'overlay', 'base', null]);
  });
  it('recycles inactive instances across a thousand boundaries without increasing capacity', () => {
    let assignments: (string | null)[] = ['base-0', 'overlay', null];
    for (let index = 1; index <= 1000; index++) {
      const overlayIndex = assignments.indexOf('overlay');
      assignments = allocateDecoders(assignments, [`base-${index}`, 'overlay']);
      expect(assignments).toHaveLength(3); expect(assignments.indexOf('overlay')).toBe(overlayIndex);
    }
  });
  it('rejects duplicate required/current instances, insufficient capacity and more than sixteen slots', () => {
    expect(() => allocateDecoders([null, null], ['a', 'a'])).toThrow(/distinct/);
    expect(() => allocateDecoders(['a', 'a'], ['a'])).toThrow(/distinct/);
    expect(() => allocateDecoders([null], ['a', 'b'])).toThrow(/bounded/);
    expect(() => allocateDecoders(Array.from({ length: 17 }, () => null), [])).toThrow(/bounded/);
    expect(allocateDecoders([], [])).toEqual([]);
  });
});

describe('layered observed-frame preview', () => {
  it('keeps exactly two reusable decoders for an arbitrary primary-only sequence', async () => {
    const project = makeProject();
    for (let index = 1; index < 40; index++) {
      const id = `clip-${index}`;
      project.transitions.push({ leftId: project.clips.at(-1)!.id, rightId: id, type: 'cut', duration: 0 });
      project.clips.push(createClip(id, `media-${index}`, 10, 70));
    }
    const engine = makeEngine(); await engine.loadProject(project, resolver);
    await engine.seek(60 * 30 + 12); await engine.seek(20);
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame: 20, decoderCount: 2 });
    expect(liveSlots()).toHaveLength(2); expect(state.peakSlots).toBe(2);
  });
  it('groups nine active clips into eight layers and applies shared project-time keys to every row member', async () => {
    const project = makeProject(8, true);
    project.layers[0]!.keyframes = [point(0, { clipOpacity: 0.2 }), point(59, { clipOpacity: 0.8 }, 'hold')];
    project.clips[1]!.opacity = 0.3;
    project.layers[1]!.keyframes = [point(0, { layerOpacity: 0, exposure: 0 }), point(102, { layerOpacity: 1, exposure: 1 }, 'hold')];
    const engine = makeEngine(); await engine.loadProject(project, resolver, 51);
    const assignments = engine.diagnostics().assignedClipIds;
    expect(engine.diagnostics().decoderCount).toBe(9);
    expect(compositor().groups).toEqual(expectedGroups(project, 51, assignments));
    expect(compositor().groups[0]!.clips).toHaveLength(2);
    for (const clip of compositor().groups[0]!.clips) expect(clip.opacity).toBeCloseTo(0.2 + 0.6 * 51 / 59);
    expect(project.clips[1]!.opacity).toBe(0.3);
    expect(compositor().groups[1]!.opacity).toBe(0.5);
    expect(compositor().groups[1]!.clips[0]!.settings.exposure).toBe(0.5);
    expect(liveSlots().map((slot) => slot.decodedFrame)).toEqual(sampleTimeline(project, 51).map((layer) => layer.sourceFrame));
    const rgb = (id: string): RGB => id === 'base' ? [0.8, 0.1, 0.2] : [0.1, 0.5, 0.9];
    const expected = compositePixel(sampleTimeline(project, 51), (layer) => rgb(layer.clipId));
    expect(groupPixel(compositor().groups, (slot) => rgb(assignments[slot]!))).toEqual(expected);
    await engine.play(); expect(engine.diagnostics().activeDecoders).toBe(9); expect(state.peakSlots).toBe(9);
  });
  it('keeps black fade brightness independent of clip and layer alpha', async () => {
    const project = makeProject(2); project.openingFade = 5;
    project.clips[0]!.opacity = 0.3; project.layers[0]!.opacity = 0.7;
    const engine = makeEngine(); await engine.loadProject(project, resolver, 0);
    expect(compositor().groups[0]).toMatchObject({ opacity: 0.7, clips: [{ opacity: 0.3, blendWeight: 1, brightness: 0 }] });
    await engine.seek(2);
    expect(compositor().groups[0]!.clips[0]).toMatchObject({ opacity: 0.3, blendWeight: 1, brightness: 0.5 });
  });
  it('observes enabled zero-opacity clips but never loads disabled layers', async () => {
    const project = makeProject(3); project.layers[1]!.opacity = 0; project.layers[2]!.enabled = false;
    const engine = makeEngine(); await engine.loadProject(project, resolver);
    expect(compositor().groups).toHaveLength(2); expect(compositor().groups[1]!.opacity).toBe(0);
    expect(state.slots.flatMap((slot) => slot.loads.map((load) => load.url))).not.toContain('/overlay-media-2');
    expect(engine.diagnostics().assignedClipIds).toContain('overlay-1');
  });
  it('plays black gaps and an overlay-only tail through the full max-end duration', async () => {
    const project = makeProject(2);
    project.clips[0]!.sourceOut = 50;
    project.clips[1]!.start = 30; project.clips[1]!.sourceOut = project.clips[1]!.sourceIn + 20;
    const engine = makeEngine(); await engine.loadProject(project, resolver, 20);
    expect(calculateLayout(project)).toMatchObject({ baseDuration: 10, duration: 50 });
    expect(compositor().groups).toEqual([]); expect(engine.capturePixels()).toEqual(new Uint8Array([0, 0, 0, 255]));
    await engine.play(); animationFrame(1000 + framesToSeconds(5) * 1000 + 0.001);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 25, activeDecoders: 0 });
    animationFrame(1000 + framesToSeconds(12) * 1000 + 0.001); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 32, activeDecoders: 1, duration: 50 });
    expect(compositor().groups).toHaveLength(1);
    await engine.seek(49); expect(() => engine.capturePixels()).not.toThrow();
  });
  it('preloads upcoming overlays and the primary source only in spare slots', async () => {
    const project = makeProject(2, true);
    const overlay = project.clips[2]!; overlay.sourceOut = overlay.sourceIn + 15;
    project.clips.push({ ...createClip('overlay-next', 'overlay-next-media', 500, 530), layerId: 'video-2', start: 20 });
    const engine = makeEngine(); await engine.loadProject(project, resolver, 5); await settle();
    const before = engine.diagnostics().assignedClipIds;
    expect(before).toContain('overlay-next'); expect(before).not.toContain('next');
    const baseSlot = liveSlots()[before.indexOf('base')]!;
    const overlaySlot = liveSlots()[before.indexOf('overlay-1')]!;
    await engine.play(); observeFrame(engine, project, 16);
    animationFrame(1000 + framesToSeconds(11) * 1000 + 0.001); await settle();
    const after = engine.diagnostics().assignedClipIds;
    expect(liveSlots()[after.indexOf('base')]).toBe(baseSlot); expect(baseSlot.playing).toBe(true);
    expect(after).toContain('overlay-next'); expect(after).toContain('next'); expect(overlaySlot.playing).toBe(false);
    expect(state.peakSlots).toBe(3);
  });
  it('does not report a speculative missing source as an error on the current clip', async () => {
    const project = makeProject(1, true);
    state.onLoad = async (url) => { if (url === '/next-media') throw new Error('Missing future media'); };
    const engine = makeEngine(); await engine.loadProject(project, resolver, 5); await settle();
    expect(engine.diagnostics().status).toBe('paused'); expect(() => engine.capturePixels()).not.toThrow();
    await engine.seek(51);
    expect(engine.diagnostics()).toMatchObject({ status: 'error', message: 'Missing future media' });
  });
  it('discards obsolete seeks and refuses capture/upload of stale observed frames', async () => {
    const project = makeProject(2, true); const blocked = deferred();
    state.onLoad = (url) => url === '/next-media' ? blocked.promise : Promise.resolve();
    const engine = makeEngine(); await engine.loadProject(project, resolver, 5);
    const obsolete = engine.seek(51); await settle();
    state.onLoad = null;
    await engine.seek(80); blocked.resolve(); await obsolete; await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame: 80 });
    const assignments = engine.diagnostics().assignedClipIds;
    const current = liveSlots()[assignments.indexOf('next')]!;
    const uploads = compositor().uploads.length;
    current.decodedFrame--;
    expect(() => engine.capturePixels()).toThrow(/required decoded frames/);
    expect(compositor().uploads).toHaveLength(uploads);
  });
  it('uses keyframed speed for decoder rates and keeps frame-zero rAF clamping', async () => {
    const project = makeProject();
    project.layers[0]!.keyframes = [point(0, { speed: 0.5 }, 'smooth'), point(59, { speed: 2 }, 'hold')];
    const engine = makeEngine(); await engine.loadProject(project, resolver); await engine.play();
    animationFrame(1000, 999);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 0 });
    observeFrame(engine, project, 7); animationFrame(1000 + framesToSeconds(7) * 1000 + 0.001);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 7 });
    expect(liveSlots()[0]!.rates.at(-1)).toBe(calculateLayout(project).clips[0]!.retiming.rateAt(7));
  });
});

describe('live appearance updates and lifecycle', () => {
  it('updates keys, opacity, colour and stacking while playing without timing/media/music reload', async () => {
    const project = makeProject(3);
    project.music = { mediaId: 'music', sourceIn: 0, sourceOut: 60, start: 0, duration: 60, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false };
    const engine = makeEngine(); await engine.loadProject(project, resolver, 15); await engine.play();
    const before = calls(); const music = state.music[0]!; const starts = [...music.starts]; const pauses = music.pauses;
    const appearance = structuredClone(project);
    appearance.layers[0]!.keyframes = [point(0, { layerOpacity: 0, clipOpacity: 0, exposure: 0.7 }), point(30, { layerOpacity: 1, clipOpacity: 1 }, 'hold')];
    appearance.layers = [appearance.layers[0]!, appearance.layers[2]!, appearance.layers[1]!];
    engine.updateProjectAppearance(appearance);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 15, activeDecoders: 3 });
    expect(calls()).toEqual(before); expect(music.configured).toHaveLength(1); expect(music.starts).toEqual(starts); expect(music.pauses).toBe(pauses);
    expect(compositor().groups).toEqual(expectedGroups(appearance, 15, engine.diagnostics().assignedClipIds));
    appearance.layers[0]!.keyframes[0]!.values.exposure = -2;
    engine.capturePixels(); expect(compositor().groups[0]!.clips[0]!.settings.exposure).toBe(0.7);
    const sampled = structuredClone(project);
    observeFrame(engine, sampled, 16); animationFrame(1000 + framesToSeconds(1) * 1000 + 0.001);
    expect(engine.diagnostics().frame).toBe(16); expect(music.starts).toEqual(starts);
  });
  it('retains updateColour and redraws appearance immediately when paused', async () => {
    const project = makeProject(2); const engine = makeEngine(); await engine.loadProject(project, resolver, 10);
    const before = calls(); const uploads = compositor().uploads.length;
    engine.updateColour('base', { ...NEUTRAL_COLOUR, saturation: 0.4 });
    expect(compositor().groups[0]!.clips[0]!.settings.saturation).toBe(0.4);
    project.clips[0]!.opacity = 0.25; engine.updateProjectAppearance(project);
    expect(compositor().groups[0]!.clips[0]!.opacity).toBe(0.25);
    expect(calls()).toEqual(before); expect(compositor().uploads).toHaveLength(uploads);
  });
  it('rejects source, speed, placement, music and project changes rather than silently keeping old timing', async () => {
    const project = makeProject(2); const engine = makeEngine(); await engine.loadProject(project, resolver);
    const changes: ((document: ProjectDocument) => void)[] = [
      (document) => { document.clips[0]!.sourceIn++; },
      (document) => { document.clips[0]!.mediaId = 'another-media'; },
      (document) => { document.clips[0]!.speed = { mode: 'constant', rate: 2 }; },
      (document) => { document.layers[0]!.keyframes = [point(0, { speed: 2 })]; },
      (document) => { document.clips[1]!.start++; },
      (document) => { document.music = { mediaId: 'music', sourceIn: 0, sourceOut: 60, start: 0, duration: 60, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false }; },
      (document) => { document.id = 'another-project'; },
    ];
    changes.forEach((change) => {
      const next = structuredClone(project); change(next);
      expect(() => engine.updateProjectAppearance(next)).toThrow(/preserve project timing/);
    });
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', duration: 60, frame: 0 });
  });
  it('rejects participating speed-point edits but permits unrelated colour points without rebuilding the captured map', async () => {
    const project = makeProject(2);
    project.layers[0]!.keyframes = [point(0, { speed: 0.5 }, 'smooth'), point(59, { speed: 2 }, 'hold')];
    const engine = makeEngine(); await engine.loadProject(project, resolver, 15);
    const before = calls(); const duration = engine.diagnostics().duration;
    const appearance = structuredClone(project); appearance.layers[0]!.keyframes.splice(1, 0, point(25, { exposure: 0.7 }, 'hold'));
    expect(() => engine.updateProjectAppearance(appearance)).not.toThrow();
    expect(calls()).toEqual(before); expect(compositor().groups[0]!.clips[0]!.settings.exposure).toBe(0.7);
    for (const change of [
      (document: ProjectDocument) => { document.layers[0]!.keyframes[0]!.values.speed = 1; },
      (document: ProjectDocument) => { document.layers[0]!.keyframes[0]!.frame = 1; },
      (document: ProjectDocument) => { document.layers[0]!.keyframes[0]!.interpolation = 'hold'; },
      (document: ProjectDocument) => { document.layers[0]!.keyframes = []; },
    ]) {
      const next = structuredClone(appearance); change(next);
      expect(() => engine.updateProjectAppearance(next)).toThrow(/preserve project timing/);
    }
    expect(calls()).toEqual(before); expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame: 15, duration });
  });
  it('hides all groups without stopping playback and observes fresh frames when re-enabled', async () => {
    const project = makeProject(2); const engine = makeEngine(); await engine.loadProject(project, resolver, 10); await engine.play();
    const hidden = structuredClone(project); hidden.layers.forEach((layer) => { layer.enabled = false; });
    const before = calls(); engine.updateProjectAppearance(hidden);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', activeDecoders: 0 });
    expect(compositor().groups).toEqual([]); expect(calls()).toEqual(before);
    animationFrame(1000 + framesToSeconds(3) * 1000 + 0.001);
    expect(engine.diagnostics().frame).toBe(13);
    engine.updateProjectAppearance(project); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 13, activeDecoders: 2 });
    expect(compositor().groups).toEqual(expectedGroups(project, 13, engine.diagnostics().assignedClipIds));
  });
  it('updates colour during a pending load and restarts a visibility-changing alignment safely', async () => {
    const project = makeProject(2); const blocked = deferred();
    state.onLoad = (url) => url === '/overlay-media-1' ? blocked.promise : Promise.resolve();
    const engine = makeEngine(); const loading = engine.loadProject(project, resolver, 10); await settle();
    const appearance = structuredClone(project); appearance.clips[0]!.colour.exposure = 0.6;
    engine.updateProjectAppearance(appearance);
    appearance.layers[1]!.enabled = false; engine.updateProjectAppearance(appearance); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame: 10 });
    expect(compositor().groups[0]!.clips[0]!.settings.exposure).toBe(0.6);
    blocked.resolve(); await loading; await settle();
    expect(compositor().groups).toHaveLength(1); expect(engine.diagnostics().status).toBe('paused');
  });
  it('aborts a buffering visibility change and reanchors music even when the new frame is black', async () => {
    const project = makeProject(2); const engine = makeEngine(); await engine.loadProject(project, resolver, 10); await engine.play();
    const blocked = deferred(); state.onStart = () => blocked.promise; state.musicSync = false;
    animationFrame(1000 + framesToSeconds(1) * 1000 + 0.001); await settle();
    expect(engine.diagnostics().status).toBe('buffering');
    const hidden = structuredClone(project); hidden.layers.forEach((layer) => { layer.enabled = false; });
    state.onStart = null; state.musicSync = true; engine.updateProjectAppearance(hidden); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 11, activeDecoders: 0 });
    expect(compositor().groups).toEqual([]); expect(state.music[0]!.starts.at(-1)).toBe(11);
    blocked.resolve(); await settle(); expect(engine.diagnostics().status).toBe('playing');
  });
  it('does not resurrect playback after pause during an asynchronous audio-context resume', async () => {
    const project = makeProject(); const engine = makeEngine(); await engine.loadProject(project, resolver);
    const blocked = deferred(); state.onResume = () => blocked.promise;
    const playing = engine.play(); engine.pause(); blocked.resolve(); await playing;
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, activeDecoders: 0 });
    expect(liveSlots().every((slot) => !slot.playing)).toBe(true);
  });
  it('does not restart an obsolete play request when its end-of-timeline reset seek is cancelled', async () => {
    const project = makeProject(); const engine = makeEngine(); await engine.loadProject(project, resolver, 59);
    const playing = engine.play(); engine.pause(); await playing;
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, activeDecoders: 0 });
    expect(calls().plays).toBe(0);
  });
  it('preserves active decoder objects when empty layers are removed and recycles extra resources', async () => {
    const project = makeProject(3); project.clips.splice(1, 1);
    const engine = makeEngine(); await engine.loadProject(project, resolver); await engine.play();
    const active = engine.diagnostics().assignedClipIds.map((id, index) => id ? liveSlots()[index]! : null).filter((slot) => slot !== null);
    const smaller = structuredClone(project); smaller.layers.splice(1, 1); engine.updateProjectAppearance(smaller);
    expect(engine.diagnostics()).toMatchObject({ decoderCount: 3, activeDecoders: 2, playing: true });
    active.forEach((slot) => { expect(liveSlots()).toContain(slot); expect(slot.disposed).toBe(false); expect(slot.playing).toBe(true); });
    await engine.loadProject(makeProject(), resolver); expect(liveSlots()).toHaveLength(2);
    await engine.loadProject(createProject('empty', 'Empty'), resolver);
    expect(engine.diagnostics()).toMatchObject({ status: 'empty', decoderCount: 0, assignedClipIds: [] });
    expect(liveSlots()).toHaveLength(0); expect(compositor().count).toBe(0);
    engine.dispose(); expect(state.music).toHaveLength(1); expect(state.music[0]!.disposed).toBe(true);
  });
  it('releases every decoder on context loss and restores a bounded paused pool without leaks', async () => {
    const project = makeProject(8, true); const engine = makeEngine(); await engine.loadProject(project, resolver, 51); await engine.play();
    compositor().lost = true;
    const lost = new Event('webglcontextlost', { cancelable: true }); engine.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(engine.diagnostics()).toMatchObject({ status: 'error', playing: false, decoderCount: 0, activeDecoders: 0, assignedClipIds: [], gpuTextureMiB: 0 });
    expect(compositor().disposed).toBe(true);
    expect(liveSlots()).toHaveLength(0);
    engine.canvas.dispatchEvent(new Event('webglcontextrestored')); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', decoderCount: 9, frame: 51 });
    expect(() => engine.capturePixels()).not.toThrow(); expect(liveSlots()).toHaveLength(9); expect(state.peakSlots).toBe(9);
    engine.dispose(); engine.dispose(); expect(liveSlots()).toHaveLength(0);
    expect(engine.diagnostics()).toMatchObject({ status: 'disposed', decoderCount: 0, assignedClipIds: [] });
    expect(state.compositors.every((renderer) => renderer.disposed)).toBe(true);
  });
  it('restores an empty canvas without recreating decoder textures or video elements', async () => {
    const engine = makeEngine(); await engine.loadProject(createProject('empty', 'Empty'), resolver);
    compositor().lost = true; engine.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    engine.canvas.dispatchEvent(new Event('webglcontextrestored')); await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'empty', decoderCount: 0, gpuTextureMiB: 0 });
    expect(compositor().count).toBe(0); expect(liveSlots()).toHaveLength(0);
  });
  it('reports GPU restoration failure without leaking or throwing out of the context event', async () => {
    const project = makeProject(2); const engine = makeEngine(); await engine.loadProject(project, resolver);
    compositor().lost = true; engine.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    state.failCompositor = true;
    expect(() => engine.canvas.dispatchEvent(new Event('webglcontextrestored'))).not.toThrow();
    expect(engine.diagnostics()).toMatchObject({ status: 'error', message: 'Synthetic GPU allocation failed.', decoderCount: 0 });
    compositor().lost = false;
    project.clips[0]!.opacity = 0.2;
    expect(() => engine.updateProjectAppearance(project)).not.toThrow();
    expect(() => engine.capturePixels()).toThrow(/required decoded frames/);
    expect(liveSlots()).toHaveLength(0);
  });
});