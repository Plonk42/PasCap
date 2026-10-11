import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CompositeGroup } from '../../src/preview/compositor.js';
import { PreviewEngine } from '../../src/preview/engine.js';
import { gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { compositePixel } from '../../src/shared/composition.js';
import { NEUTRAL_DETAIL } from '../../src/shared/detail.js';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import {
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { evaluateSpatial } from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { framesToSeconds } from '../../src/shared/timing.js';

// Browser boundaries are doubles: WebCodecs decoding (frames delivered when a
// test decides), WebGL textures/draws and the music clock. The timeline itself
// is the real layout and sampler.
interface FakeFrame {
  readonly sourceFrame: number;
  readonly url: string;
  readonly displayWidth: number;
  readonly displayHeight: number;
  closed: boolean;
  close(): void;
}
interface LaneDouble {
  generation: number;
  url: string;
  pending: number[];
  complete: boolean;
  queue: FakeFrame[];
  error: Error | null;
  listeners: Set<() => void>;
}
interface StreamsDouble {
  lanes: LaneDouble[];
  starts: { lane: number; url: string; frames: number[]; complete: boolean }[];
  extensions: { lane: number; frames: number[]; complete: boolean }[];
  stops: number[];
  open: Set<FakeFrame>;
  decodedFrames: number;
  droppedFrames: number;
  disposed: boolean;
  decode(lane: number, count?: number): void;
  fail(lane: number, message: string): void;
}
interface CompositorDouble {
  lost: boolean;
  disposed: boolean;
  count: number;
  visible: (CompositeGroup['clips'][number] & { sourceFrame: number; url: string })[][] | null;
  textures: Map<number, { sourceFrame: number; url: string }>;
  setDecoderCount: Mock<(count: number) => void>;
  prepareDetail: Mock<() => void>;
  uploadFrame: Mock<(slot: number, frame: FakeFrame) => void>;
  drawFrame: Mock<(groups: readonly CompositeGroup[]) => void>;
  clear: Mock<() => void>;
}
interface MusicDouble {
  hasMusic: boolean;
  running: boolean;
  clockFrame: number;
  clockTime: number;
  disposed: boolean;
  configure: Mock<(tracks: readonly MusicTrack[], signal: AbortSignal) => Promise<void>>;
  resumeContext: Mock<() => Promise<void>>;
  start: Mock<(frame: number, signal: AbortSignal) => Promise<void>>;
  sync: Mock<() => boolean>;
  pause: Mock<() => void>;
  dispose: Mock<() => void>;
}

const state = vi.hoisted(() => ({
  now: 1000,
  nextRaf: 0,
  raf: new Map<number, FrameRequestCallback>(),
  streams: [] as StreamsDouble[],
  compositors: [] as CompositorDouble[],
  music: [] as MusicDouble[],
  autoDecode: true,
  failing: new Map<string, string>(),
  musicSync: true,
  onResume: null as (() => Promise<void>) | null,
  onStart: null as ((signal: AbortSignal) => Promise<void>) | null,
  failCompositor: false,
}));

vi.mock('../../src/preview/video-streams.js', () => {
  const budget = 6;
  const cancelled = (): DOMException => new DOMException('Cancelled', 'AbortError');
  return {
    VideoStreams: class implements StreamsDouble {
      readonly lanes: LaneDouble[];
      readonly starts: StreamsDouble['starts'] = [];
      readonly extensions: StreamsDouble['extensions'] = [];
      readonly stops: number[] = [];
      readonly open = new Set<FakeFrame>();
      decodedFrames = 0;
      droppedFrames = 0;
      disposed = false;
      constructor(count: number) {
        this.lanes = Array.from({ length: count }, () => ({
          generation: 0,
          url: '',
          pending: [],
          complete: true,
          queue: [],
          error: null,
          listeners: new Set(),
        }));
        state.streams.push(this);
      }
      #reset(lane: LaneDouble): void {
        lane.queue.forEach((frame) => frame.close());
        lane.queue = [];
        lane.pending = [];
        lane.error = null;
        lane.generation++;
        lane.listeners.forEach((listener) => listener());
      }
      decode(index: number, count = Infinity): void {
        const lane = this.lanes[index]!;
        let delivered = 0;
        while (delivered < count && lane.queue.length < budget && lane.pending.length) {
          const open = this.open;
          const frame: FakeFrame = {
            sourceFrame: lane.pending.shift()!,
            url: lane.url,
            displayWidth: 1280,
            displayHeight: 720,
            closed: false,
            close() {
              this.closed = true;
              open.delete(this);
            },
          };
          open.add(frame);
          lane.queue.push(frame);
          this.decodedFrames++;
          delivered++;
        }
        lane.listeners.forEach((listener) => listener());
      }
      fail(index: number, message: string): void {
        const lane = this.lanes[index]!;
        lane.error = new Error(message);
        lane.listeners.forEach((listener) => listener());
      }
      #auto(index: number): void {
        const lane = this.lanes[index]!;
        const failure = state.failing.get(lane.url);
        if (failure) this.fail(index, failure);
        else if (state.autoDecode) this.decode(index);
      }
      start(index: number, url: string, frames: number[], complete: boolean): void {
        const lane = this.lanes[index]!;
        this.#reset(lane);
        this.starts.push({ lane: index, url, frames: [...frames], complete });
        lane.url = url;
        lane.pending = [...frames];
        lane.complete = complete;
        this.#auto(index);
      }
      extend(index: number, frames: number[], complete: boolean): void {
        const lane = this.lanes[index]!;
        this.extensions.push({ lane: index, frames: [...frames], complete });
        expect(lane.complete).toBe(false);
        lane.pending.push(...frames);
        lane.complete = complete;
        this.#auto(index);
      }
      stop(index: number): void {
        this.stops.push(index);
        this.#reset(this.lanes[index]!);
      }
      queued(index: number): number {
        return this.lanes[index]!.queue.length;
      }
      #advance(index: number, sourceFrame: number, take: boolean): FakeFrame | null {
        const lane = this.lanes[index]!;
        if (lane.error) throw lane.error;
        let credits = 0;
        while (lane.queue.length && lane.queue[0]!.sourceFrame < sourceFrame) {
          lane.queue.shift()!.close();
          this.droppedFrames++;
          credits++;
        }
        if (lane.queue.length && lane.queue[0]!.sourceFrame !== sourceFrame)
          throw new Error(`Video decoder ${index + 1} skipped source frame ${sourceFrame}.`);
        const frame = take ? (lane.queue.shift() ?? null) : null;
        // Like the worker, learn the clock's minimum only with returned credits.
        if (credits || frame) lane.pending = lane.pending.filter((pending) => pending >= sourceFrame);
        return frame;
      }
      take(index: number, sourceFrame: number): FakeFrame | null {
        const frame = this.#advance(index, sourceFrame, true);
        if (frame) this.#auto(index);
        return frame;
      }
      ready(index: number, sourceFrame: number, count: number, signal: AbortSignal): Promise<void> {
        const lane = this.lanes[index]!;
        const generation = lane.generation;
        return new Promise((resolve, reject) => {
          const finish = (error?: unknown): void => {
            lane.listeners.delete(check);
            if (error === undefined) resolve();
            else reject(error);
          };
          const check = (): void => {
            if (signal.aborted || lane.generation !== generation) return finish(cancelled());
            try {
              this.#advance(index, sourceFrame, false);
            } catch (error) {
              finish(error);
              return;
            }
            if (lane.queue.length >= count) finish();
          };
          lane.listeners.add(check);
          signal.addEventListener('abort', check, { once: true });
          check();
        });
      }
      dispose(): void {
        this.lanes.forEach((lane) => this.#reset(lane));
        this.disposed = true;
      }
    },
  };
});

vi.mock('../../src/preview/compositor.js', () => ({
  MAX_VIDEO_DECODERS: 16,
  Compositor: class {
    readonly renderer = 'unit-test';
    lost = false;
    disposed = false;
    count = 2;
    visible: CompositorDouble['visible'] = null;
    readonly textures = new Map<number, { sourceFrame: number; url: string }>();
    constructor() {
      if (state.failCompositor) throw new Error('Synthetic GPU allocation failed.');
      state.compositors.push(this as unknown as CompositorDouble);
    }
    get available(): boolean {
      return !this.disposed && !this.lost;
    }
    get gpuTextureMiB(): number {
      return this.available ? (this.count * 4) / 1024 ** 2 : 0;
    }
    setDecoderCount = vi.fn((count: number): void => {
      if (!this.available) throw new Error('Invalid compositor decoder count.');
      this.count = count;
    });
    prepareDetail = vi.fn();
    uploadFrame = vi.fn((slot: number, frame: FakeFrame): void => {
      if (frame.closed || slot >= this.count) throw new Error('Cannot upload a closed or unassigned frame.');
      this.textures.set(slot, { sourceFrame: frame.sourceFrame, url: frame.url });
    });
    drawFrame = vi.fn((groups: readonly CompositeGroup[]): void => {
      this.visible = groups.map((group) =>
        group.clips.map((clip) => {
          const texture = this.textures.get(clip.slot);
          if (!texture) throw new Error('Cannot draw an unuploaded source');
          return { ...structuredClone(clip), ...texture };
        }),
      );
    });
    clear = vi.fn((): void => {
      this.visible = null;
    });
    readPixels = vi.fn(() => new Uint8Array([0, 0, 0, 255]));
    dispose = vi.fn((): void => {
      this.disposed = true;
      this.count = 0;
    });
  },
}));

vi.mock('../../src/preview/music.js', () => ({
  MusicPlayback: class {
    hasMusic = false;
    running = false;
    clockFrame = 0;
    clockTime = 0;
    disposed = false;
    readonly errorFrames = 0;
    constructor() {
      state.music.push(this as unknown as MusicDouble);
    }
    configure = vi.fn(async (tracks: readonly MusicTrack[], signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.pause();
      this.hasMusic = tracks.length > 0;
    });
    resumeContext = vi.fn(async (): Promise<void> => {
      await state.onResume?.();
    });
    start = vi.fn(async (frame: number, signal: AbortSignal): Promise<void> => {
      await state.onStart?.(signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      this.clockFrame = frame;
      this.clockTime = state.now;
      this.running = true;
    });
    projectFrame = vi.fn(
      () => this.clockFrame + Math.floor((Math.max(0, state.now - this.clockTime) * 30_000) / 1_001_000 + 1e-7),
    );
    sync = vi.fn(() => state.musicSync);
    pause = vi.fn((): void => {
      this.running = false;
    });
    dispose = vi.fn((): void => {
      this.disposed = true;
    });
  },
}));

const engines: PreviewEngine[] = [];
const proxyUrl = (id: string): string => `/proxy/${id}`;
const originalDimensions = (_id: string) => ({ width: 1920, height: 1080 });

beforeEach(() => {
  Object.assign(state, {
    now: 1000,
    nextRaf: 0,
    autoDecode: true,
    musicSync: true,
    onResume: null,
    onStart: null,
    failCompositor: false,
  });
  state.raf.clear();
  state.streams.length = 0;
  state.compositors.length = 0;
  state.music.length = 0;
  state.failing.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => state.now);
  vi.stubGlobal('VideoDecoder', class {});
  vi.stubGlobal('VideoFrame', class {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    state.raf.set(++state.nextRaf, callback);
    return state.nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => state.raf.delete(id));
});
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  for (const streams of state.streams) expect(streams.open.size, 'every decoded frame is closed').toBe(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function settle(): Promise<void> {
  return Array.from({ length: 32 }).reduce<Promise<void>>(
    (pending) => pending.then(() => undefined),
    Promise.resolve(),
  );
}
function makeEngine(): PreviewEngine {
  const engine = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
  engines.push(engine);
  return engine;
}
function streams(): StreamsDouble {
  return state.streams.at(-1)!;
}
function compositor(): CompositorDouble {
  return state.compositors.at(-1)!;
}
function music(): MusicDouble {
  return state.music.at(-1)!;
}
/** Run the pending display callbacks with the clock at `frame` frames (plus a fraction) after `anchor`. */
function tick(anchor: number, frames: number, fraction = 0.1): void {
  state.now = anchor + framesToSeconds(frames + fraction) * 1000;
  const pending = [...state.raf.values()];
  state.raf.clear();
  pending.forEach((callback) => callback(state.now));
}
function laneOf(engine: PreviewEngine, clipId: string): number {
  const lane = engine.diagnostics().assignedClipIds.indexOf(clipId);
  expect(lane, `${clipId} has a decoder`).toBeGreaterThanOrEqual(0);
  return lane;
}
function expectSurface(engine: PreviewEngine, project: ProjectDocument, frame: number, ungraded = false): void {
  const layers = sampleTimeline(project, frame, calculateLayout(project));
  const lanes = engine.diagnostics().assignedClipIds;
  expect(compositor().visible).toEqual(
    project.layers.flatMap((group) => {
      const members = layers.filter((layer) => layer.layerId === group.id);
      return members.length
        ? [
            members.map((layer) => ({
              slot: lanes.indexOf(layer.clipId),
              sourceFrame: layer.sourceFrame,
              url: proxyUrl(layer.mediaId),
              settings: ungraded ? NEUTRAL_COLOUR : layer.colour,
              aspect: 16 / 9,
              spatial: layer.spatial,
              detail: ungraded ? NEUTRAL_DETAIL : layer.detail,
              originalWidth: 1920,
              originalHeight: 1080,
              opacity: layer.opacity,
              blendWeight: layer.blendWeight,
              brightness: layer.brightness,
            })),
          ]
        : [];
    }),
  );
}
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function musicTrack(duration = 600): MusicTrack {
  return {
    id: 'song-instance',
    mediaId: 'song',
    sourceIn: 0,
    sourceOut: duration,
    start: 0,
    duration,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
  };
}
function singleProject(withMusic = false): ProjectDocument {
  const project = createProject('single', 'Single clip');
  project.clips = [createClip('clip', 'video', 0, 60)];
  project.media.videoIds = ['video'];
  if (withMusic) {
    project.media.audioIds = ['song'];
    project.music = [musicTrack()];
  }
  return project;
}
/** A first clip, optionally dissolving into a second, and one clip on every further track. */
function layeredProject(layerCount = 1, dissolve = false): ProjectDocument {
  const project = createProject('layers', 'Layers');
  project.clips.push(createClip('base', 'base-media', 40, 100));
  const duration = dissolve ? 102 : 60;
  if (dissolve) {
    project.clips.push(createClip('next', 'next-media', 140, 200));
    project.layers[0]!.transitions.push({ leftId: 'base', rightId: 'next', type: 'cross-dissolve', duration: 18 });
  }
  for (let index = 1; index < layerCount; index++) {
    const id = `video-${index + 1}`;
    project.layers.push(createLayer(id, `Video track ${index + 1}`, false));
    project.clips.push({
      ...createClip(`overlay-${index}`, `overlay-media-${index}`, 200 + index * 100, 200 + index * 100 + duration),
      layerId: id,
    });
  }
  return project;
}
/** Two cut clips on one track. */
function cutProject(withMusic = false): ProjectDocument {
  const project = singleProject(withMusic);
  project.clips[0]!.sourceOut = 20;
  project.clips.push(createClip('second', 'second-video', 300, 340));
  project.media.videoIds.push('second-video');
  project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'second', type: 'cut', duration: 0 }];
  return project;
}
function gradedLayersProject(): ProjectDocument {
  const project = singleProject(true);
  const lower = project.layers[0]!;
  const left = project.clips[0]!;
  lower.colour = { ...NEUTRAL_COLOUR, hue: 15, saturation: 0.8 };
  left.speed = { mode: 'constant', rate: 2 };
  const right = createClip('right', 'other-video', 100, 115, lower.id);
  right.start = 20;
  right.speed = { mode: 'constant', rate: 0.5 };
  lower.opacity = 0.55;
  lower.openingFade = 6;
  lower.closingFade = 8;
  lower.transitions = [{ leftId: left.id, rightId: right.id, type: 'cross-dissolve', duration: 10 }];
  lower.keyframes = [point(0, { exposure: -1, opacity: 0.6 }), point(50, { exposure: 1, opacity: 0.3 }, 'hold')];
  const upper = createLayer('upper', 'Upper');
  upper.opacity = 0.75;
  upper.keyframes = [
    point(0, { exposure: 0.7, hue: 20, opacity: 0.35 }, 'smooth'),
    point(60, { opacity: 0.7 }, 'hold'),
  ];
  const top = createClip('upper-clip', 'upper-video', 200, 275, upper.id);
  top.speed = { mode: 'constant', rate: 1.25 };
  project.layers.push(upper);
  project.clips.push(right, top);
  project.media.videoIds.push('other-video', 'upper-video');
  return project;
}
async function paused(project: ProjectDocument, frame = 8): Promise<PreviewEngine> {
  const engine = makeEngine();
  await engine.loadProject(project, proxyUrl, originalDimensions, frame);
  expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame, playing: false, activeDecoders: 0 });
  expectSurface(engine, project, frame);
  return engine;
}
async function playing(project: ProjectDocument, frame = 8): Promise<{ engine: PreviewEngine; anchor: number }> {
  const engine = await paused(project, frame);
  await engine.play();
  expect(engine.diagnostics()).toMatchObject({ status: 'playing', playing: true, frame });
  return { engine, anchor: state.now };
}

describe('exact paused frames', () => {
  it('decodes exactly the source frame of every active clip and stops its decoders', async () => {
    const project = gradedLayersProject();
    const engine = await paused(project, 25);
    const layers = sampleTimeline(project, 25);
    expect(layers.map((layer) => layer.clipId)).toEqual(['clip', 'right', 'upper-clip']);
    expect(streams().starts).toEqual(
      layers.map((layer) => ({
        lane: laneOf(engine, layer.clipId),
        url: proxyUrl(layer.mediaId),
        frames: [layer.sourceFrame],
        complete: true,
      })),
    );
    expect(engine.diagnostics()).toMatchObject({
      decoderCount: 4,
      decodedSourceFrames: expect.arrayContaining(layers.map((layer) => layer.sourceFrame)),
      queuedFrames: [0, 0, 0, 0],
    });
    expect(music().start).not.toHaveBeenCalled();
  });

  it('reuses textures already showing a frame, even for another clip of the same recording', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    await engine.seek(8);
    expect(streams().starts).toHaveLength(1);
    const split = structuredClone(project);
    split.clips[0]!.id = 'recreated';
    await engine.loadProject(split, proxyUrl, originalDimensions, 8);
    expect(streams().starts).toHaveLength(1);
    expect(engine.diagnostics().assignedClipIds).toEqual(['recreated', null]);
    expectSurface(engine, split, 8);
    await engine.seek(9);
    expect(streams().starts.at(-1)).toMatchObject({ frames: [9], complete: true });
    expectSurface(engine, split, 9);
  });

  it('discards an obsolete seek and its late frame', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    state.autoDecode = false;
    const obsolete = engine.seek(20);
    const lane = laneOf(engine, 'clip');
    expect(engine.diagnostics()).toMatchObject({ status: 'seeking', requestedFrame: 20, frame: 8 });
    const current = engine.seek(30);
    streams().decode(lane);
    await Promise.all([obsolete, current]);
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', frame: 30 });
    expectSurface(engine, project, 30);
    expect(compositor().uploadFrame.mock.calls.map(([, frame]) => frame.sourceFrame)).toEqual([8, 30]);
  });

  it('keeps the image while seeking and reports a decoder failure', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    state.failing.set(proxyUrl('video'), 'Unsupported editing proxy: it is not H.264. Prepare the recording again.');
    await engine.seek(9);
    expect(engine.diagnostics()).toMatchObject({
      status: 'error',
      message: 'Unsupported editing proxy: it is not H.264. Prepare the recording again.',
      activeDecoders: 0,
    });
    expect(compositor().visible).toBeNull();
  });

  it('uses original metadata independently of the decoded size and rejects invalid dimensions', async () => {
    const project = singleProject();
    const engine = makeEngine();
    const dimensions = vi.fn((_id: string) => ({ width: 4031, height: 3017 }));
    await engine.loadProject(project, proxyUrl, dimensions, 8);
    expect(dimensions).toHaveBeenCalledWith('video');
    expect(compositor().visible![0]![0]).toMatchObject({
      aspect: 16 / 9,
      originalWidth: 4031,
      originalHeight: 3017,
      spatial: project.clips[0]!.spatial.base,
    });
    await engine.loadProject(project, proxyUrl, () => ({ width: 0, height: 3017 }));
    expect(engine.diagnostics()).toMatchObject({
      status: 'error',
      message: 'Original media dimensions must be positive integers.',
    });
  });

  it('always redraws diagnostic readback, which needs every exact texture', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    compositor().visible = null;
    engine.capturePixels();
    expectSurface(engine, project, 8);
    expect(compositor().drawFrame).toHaveBeenCalledTimes(2);
    const hidden = structuredClone(project);
    hidden.layers.push(createLayer('upper', 'Upper'));
    hidden.clips.push(createClip('upper-clip', 'upper-video', 0, 60, 'upper'));
    state.autoDecode = false;
    void engine.loadProject(hidden, proxyUrl, originalDimensions, 8);
    await settle();
    expect(() => engine.capturePixels()).toThrow(/required decoded frames/);
  });
});

describe('playback on one clock', () => {
  it('prefills every active source before starting the clock, then presents each exact frame', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    state.autoDecode = false;
    const started = engine.play();
    await settle();
    const lane = laneOf(engine, 'clip');
    expect(streams().starts.at(-1)).toEqual({
      lane,
      url: proxyUrl('video'),
      frames: Array.from({ length: 51 }, (_value, index) => 9 + index),
      complete: true,
    });
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', message: 'Starting playback', stalls: 0 });
    streams().decode(lane, 2);
    await settle();
    expect(music().start).not.toHaveBeenCalled();
    streams().decode(lane, 1);
    await started;
    expect(music().start).toHaveBeenCalledExactlyOnceWith(8, expect.any(AbortSignal));
    const anchor = state.now;
    for (const frame of [9, 10, 11]) {
      tick(anchor, frame - 8);
      expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame, requestedFrame: frame });
      expectSurface(engine, project, frame);
    }
    expect(compositor().uploadFrame.mock.calls.map(([, frame]) => frame.sourceFrame)).toEqual([8, 9, 10, 11]);
    expect(engine.diagnostics()).toMatchObject({ stalls: 0, droppedDecodedFrames: 0, activeDecoders: 1 });
  });

  it.each([0.5, 2])('requests each distinct source frame once at %s×', async (rate) => {
    const project = singleProject();
    project.clips[0]!.speed = { mode: 'constant', rate };
    const { engine, anchor } = await playing(project, 8);
    const placed = calculateLayout(project).clips[0]!;
    const shown = placed.retiming.sourceAt(8);
    const expected = [
      ...new Set(Array.from({ length: Math.min(60, placed.duration - 8) }, (_v, i) => placed.retiming.sourceAt(8 + i))),
    ].filter((frame) => frame !== shown);
    expect(streams().starts.at(-1)!.frames).toEqual(expected);
    for (let frame = 9; frame < 14; frame++) {
      tick(anchor, frame - 8);
      expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame });
      expect(compositor().visible![0]![0]!.sourceFrame).toBe(placed.retiming.sourceAt(frame));
    }
    expect(engine.diagnostics().droppedDecodedFrames).toBe(0);
  });

  it('extends the requested window as playback advances, completing at the clip end', async () => {
    const project = singleProject();
    project.clips[0]!.sourceOut = 200;
    const { engine, anchor } = await playing(project, 0);
    const lane = laneOf(engine, 'clip');
    expect(streams().starts.at(-1)).toMatchObject({ lane, complete: false });
    expect(streams().starts.at(-1)!.frames).toEqual(Array.from({ length: 59 }, (_value, index) => 1 + index));
    for (let frame = 1; frame <= 30; frame++) tick(anchor, frame);
    expect(streams().extensions).toEqual([
      { lane, frames: Array.from({ length: 30 }, (_value, index) => 60 + index), complete: false },
    ]);
    for (let frame = 31; frame <= 150; frame++) tick(anchor, frame);
    expect(streams().extensions.at(-1)!.complete).toBe(true);
    expect(
      streams()
        .extensions.flatMap((item) => item.frames)
        .at(-1),
    ).toBe(199);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 150, stalls: 0 });
  });

  it('holds the image and the wall clock while a frame is not decoded, without dropping a frame', async () => {
    const project = singleProject();
    const { engine, anchor } = await playing(project, 8);
    const lane = laneOf(engine, 'clip');
    state.autoDecode = false;
    for (let frame = 9; frame <= 14; frame++) tick(anchor, frame - 8);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 14 });
    tick(anchor, 7);
    expect(engine.diagnostics()).toMatchObject({
      status: 'buffering',
      message: 'Waiting for decoded frames',
      frame: 14,
      requestedFrame: 15,
      stalls: 1,
      boundaryStalls: 0,
    });
    expect(compositor().clear).not.toHaveBeenCalled();
    expectSurface(engine, project, 14);
    tick(state.now, 30);
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', requestedFrame: 15 });
    streams().decode(lane);
    tick(state.now, 0);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 15, stalls: 1 });
    expect(engine.diagnostics().stallMilliseconds).toBeGreaterThanOrEqual(1_000);
    expect(engine.diagnostics().droppedDecodedFrames).toBe(0);
  });

  it('reports a decoder that delivers nothing for five seconds', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 300;
    const { engine, anchor } = await playing(project, 8);
    state.autoDecode = false;
    streams()
      .lanes[laneOf(engine, 'clip')]!.queue.splice(0)
      .forEach((frame) => frame.close());
    tick(anchor, 1);
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true });
    tick(anchor, 140);
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true });
    tick(anchor, 155);
    expect(engine.diagnostics()).toMatchObject({
      status: 'error',
      playing: false,
      message: 'Video decoder 1 did not deliver source frame 163 within 5 seconds.',
      activeDecoders: 0,
    });
  });

  it('keeps music running while video waits, dropping the frames its clock has passed', async () => {
    const project = singleProject(true);
    const { engine, anchor } = await playing(project, 8);
    const lane = laneOf(engine, 'clip');
    const pauses = music().pause.mock.calls.length;
    state.autoDecode = false;
    for (const frame of [9, 10, 11, 12, 13, 14]) tick(anchor, frame - 8);
    tick(anchor, 10);
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 14, requestedFrame: 18 });
    // Late frames reach the page, which drops them and returns the clock's minimum.
    streams().decode(lane);
    tick(anchor, 13);
    expect(engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 14, requestedFrame: 21 });
    expect(engine.diagnostics().droppedDecodedFrames).toBe(6);
    streams().decode(lane);
    tick(anchor, 13, 0.5);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 21, requestedFrame: 21 });
    expectSurface(engine, project, 21);
    expect(music().start).toHaveBeenCalledOnce();
    expect(music().pause).toHaveBeenCalledTimes(pauses);
  });

  it('reports a draw that outlasts the clock as catching up, never as Playing', async () => {
    const project = singleProject(true);
    const { engine, anchor } = await playing(project, 8);
    const draw = compositor().drawFrame.getMockImplementation()!;
    compositor().drawFrame.mockImplementation((groups) => {
      draw(groups);
      state.now += framesToSeconds(2) * 1000;
    });
    tick(anchor, 1);
    expect(engine.diagnostics()).toMatchObject({
      status: 'buffering',
      message: 'Catching up with the clock',
      frame: 9,
    });
    expect(engine.diagnostics().stalls).toBe(0);
    compositor().drawFrame.mockImplementation(draw);
    tick(anchor, 4);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 12 });
    expect(music().start).toHaveBeenCalledOnce();
  });

  it('preloads the next clip so a cut presents without waiting, and names a late boundary', async () => {
    const project = cutProject(true);
    const { engine, anchor } = await playing(project, 15);
    expect(engine.diagnostics().assignedClipIds).toEqual(['clip', 'second']);
    expect(streams().starts.at(-1)).toMatchObject({ lane: 1, url: proxyUrl('second-video'), complete: true });
    expect(streams().starts.at(-1)!.frames.slice(0, 2)).toEqual([300, 301]);
    for (let frame = 16; frame < 24; frame++) {
      tick(anchor, frame - 15);
      expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame });
    }
    expectSurface(engine, project, 23);
    expect(engine.diagnostics()).toMatchObject({ stalls: 0, boundaryStalls: 0 });
    expect(music().start).toHaveBeenCalledOnce();

    const late = await playing(cutProject(true), 15);
    state.autoDecode = false;
    streams()
      .lanes[1]!.queue.splice(0)
      .forEach((frame) => frame.close());
    for (let frame = 16; frame <= 20; frame++) tick(late.anchor, frame - 15);
    expect(late.engine.diagnostics()).toMatchObject({
      status: 'buffering',
      message: 'Loading next clip',
      frame: 19,
      stalls: 1,
      boundaryStalls: 1,
    });
  });

  it('keeps at most two decoders per track: none spare for the next clip during a dissolve', async () => {
    const project = layeredProject(8, true);
    for (let index = 1; index < 8; index++) {
      const layer = project.layers[index]!;
      const left = project.clips.find((clip) => clip.layerId === layer.id)!;
      left.sourceOut = left.sourceIn + 60;
      project.clips.push({
        ...createClip(`upper-right-${index}`, `upper-right-media-${index}`, 700, 760, layer.id),
        start: 42,
      });
      layer.transitions = [{ leftId: left.id, rightId: `upper-right-${index}`, type: 'cross-dissolve', duration: 18 }];
      layer.opacity = 0.2 + index / 10;
    }
    const { engine } = await playing(project, 51);
    expect(sampleTimeline(project, 51)).toHaveLength(16);
    expect(engine.diagnostics()).toMatchObject({ decoderCount: 16, activeDecoders: 16 });
    expect(new Set(engine.diagnostics().assignedClipIds).size).toBe(16);
    const lanes = engine.diagnostics().assignedClipIds;
    const rgb = (id: string): RGB => (id.includes('right') || id === 'next' ? [0.1, 0.6, 0.8] : [0.8, 0.2, 0.1]);
    const groups = compositor().visible!;
    let pixel = [0, 0, 0];
    for (const group of groups) {
      const colour = [0, 0, 0];
      let alpha = 0;
      for (const clip of group) {
        const coverage = clip.opacity * clip.blendWeight;
        alpha += coverage;
        gradePixel(rgb(lanes[clip.slot]!), clip.settings).forEach((channel, index) => {
          colour[index]! += channel * coverage * clip.brightness;
        });
      }
      pixel = pixel.map((channel, index) => colour[index]! + channel * (1 - alpha));
    }
    expect(pixel).toEqual(compositePixel(sampleTimeline(project, 51), (layer) => rgb(layer.clipId)));
    await engine.seek(70);
    expect(compositor().visible!.map((group) => group.length)).toEqual(Array(8).fill(1));
  });

  it('never decodes disabled tracks but composes enabled zero-opacity ones', async () => {
    const project = layeredProject(3);
    project.layers[1]!.opacity = 0;
    project.layers[2]!.enabled = false;
    const { engine } = await playing(project, 0);
    expect(compositor().visible).toHaveLength(2);
    expect(compositor().visible![1]![0]!.opacity).toBe(0);
    expect(streams().starts.map((start) => start.url)).not.toContain(proxyUrl('overlay-media-2'));
    expect(engine.diagnostics().assignedClipIds).not.toContain('overlay-2');
  });

  it('plays black gaps and a music tail, then pauses on the final frame', async () => {
    const project = layeredProject(2);
    project.clips[0]!.sourceOut = 50;
    project.clips[1]!.start = 30;
    project.clips[1]!.sourceOut = project.clips[1]!.sourceIn + 20;
    project.music = [musicTrack(70)];
    const { engine, anchor } = await playing(project, 20);
    expect(compositor().visible).toEqual([]);
    expect(engine.diagnostics()).toMatchObject({ activeDecoders: 1, assignedClipIds: ['overlay-1', null, null, null] });
    tick(anchor, 5);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 25 });
    tick(anchor, 12);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 32, activeDecoders: 1 });
    expect(compositor().visible).toHaveLength(1);
    tick(anchor, 40);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 60, activeDecoders: 0 });
    expect(compositor().visible).toEqual([]);
    tick(anchor, 50);
    await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, frame: 69 });
    expect(music().start).toHaveBeenCalledOnce();
  });

  it('restarts music and video together when music loses synchronisation', async () => {
    const project = singleProject(true);
    const { engine, anchor } = await playing(project, 8);
    state.musicSync = false;
    tick(anchor, 3);
    state.musicSync = true;
    await settle();
    expect(music().start.mock.calls.map(([frame]) => frame)).toEqual([8, 11]);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 11, stalls: 1 });
  });

  it('reports a failing source only once it is required, not while it is preloaded', async () => {
    const project = cutProject();
    state.failing.set(proxyUrl('second-video'), 'Missing future media');
    const { engine, anchor } = await playing(project, 15);
    for (let frame = 16; frame < 20; frame++) {
      tick(anchor, frame - 15);
      expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame });
    }
    tick(anchor, 5);
    expect(engine.diagnostics()).toMatchObject({ status: 'error', message: 'Missing future media', playing: false });
    expect(music().pause).toHaveBeenCalled();
  });

  it('does not resurrect playback after pause during an asynchronous audio-context resume', async () => {
    const engine = await paused(singleProject(true), 8);
    let resume!: () => void;
    state.onResume = () =>
      new Promise((resolve) => {
        resume = resolve;
      });
    const started = engine.play();
    engine.pause();
    resume();
    await started;
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, activeDecoders: 0 });
    expect(music().start).not.toHaveBeenCalled();
  });

  it('restarts from the first frame at the end, but not after a cancelled reset', async () => {
    const project = singleProject();
    const engine = await paused(project, 59);
    const cancelled = engine.play();
    engine.pause();
    await cancelled;
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, frame: 59 });
    await engine.play();
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 0 });
  });
});

describe('appearance without reloading timing', () => {
  it('redraws held frames only when appearance changes: project-time animation and Compare', async () => {
    const project = singleProject(true);
    project.clips[0]!.speed = { mode: 'constant', rate: 0.25 };
    const { engine, anchor } = await playing(project, 0);
    const rendered = engine.diagnostics().renderedFrames;
    for (const frame of [1, 2, 3]) {
      tick(anchor, frame);
      expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame, renderedFrames: rendered });
    }
    expect(compositor().drawFrame).toHaveBeenCalledOnce();
    tick(anchor, 4);
    expect(compositor().drawFrame).toHaveBeenCalledTimes(2);
    engine.setUngraded(true);
    tick(anchor, 5);
    expectSurface(engine, project, 5, true);
    expect(compositor().drawFrame).toHaveBeenCalledTimes(3);

    const animated = singleProject(true);
    animated.clips[0]!.speed = { mode: 'constant', rate: 0.25 };
    animated.layers[0]!.keyframes = [point(0, { opacity: 0 }), point(4, { opacity: 1 }, 'hold')];
    const keyed = await playing(animated, 0);
    for (const frame of [1, 2, 3]) {
      tick(keyed.anchor, frame);
      expectSurface(keyed.engine, animated, frame);
    }
    expect(compositor().drawFrame).toHaveBeenCalledTimes(4);
    expect(compositor().uploadFrame).toHaveBeenCalledOnce();
  });

  it('samples continuous spatial animation on held decoded frames', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 6;
    project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
    const spatial = project.clips[0]!.spatial;
    spatial.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...spatial.base } },
      { frame: 6, interpolation: 'hold', values: { ...spatial.base, translateX: 0.6, rotation: 60 } },
    ];
    const { engine, anchor } = await playing(project, 2);
    tick(anchor, 1);
    const map = calculateLayout(project).clips[0]!.retiming;
    expect(map.sourceAt(2)).toBe(map.sourceAt(3));
    expect(compositor().visible![0]![0]!.spatial).toEqual(evaluateSpatial(spatial, map.sourcePositionAt(3)));
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 3 });
    expect(compositor().uploadFrame).toHaveBeenCalledOnce();
  });

  it('updates keys, opacity, colour and stacking while playing without restarting decoders or music', async () => {
    const project = layeredProject(3);
    project.music = [musicTrack(60)];
    const { engine, anchor } = await playing(project, 15);
    const starts = streams().starts.length;
    const stops = streams().stops.length;
    const appearance = structuredClone(project);
    appearance.layers[0]!.keyframes = [point(0, { opacity: 0, exposure: 0.7 }), point(30, { opacity: 1 }, 'hold')];
    appearance.layers = [appearance.layers[0]!, appearance.layers[2]!, appearance.layers[1]!];
    engine.updateProjectAppearance(appearance);
    tick(anchor, 1);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 16, activeDecoders: 3 });
    expectSurface(engine, appearance, 16);
    expect(streams().starts).toHaveLength(starts);
    expect(streams().stops).toHaveLength(stops);
    expect(music().configure).toHaveBeenCalledOnce();
    expect(music().start).toHaveBeenCalledOnce();
  });

  it('redraws paused colour and appearance edits from the same textures', async () => {
    const project = layeredProject(2);
    const engine = await paused(project, 10);
    const starts = streams().starts.length;
    expect(() => engine.updateColour('missing-track', NEUTRAL_COLOUR)).toThrow('The graded track does not exist.');
    engine.updateColour(project.layers[0]!.id, { ...NEUTRAL_COLOUR, saturation: 0.4 });
    expect(compositor().visible![0]![0]!.settings.saturation).toBe(0.4);
    project.layers[0]!.opacity = 0.25;
    project.clips[0]!.detail = { sharpen: 0.6, clarity: -0.3, denoise: 0.2 };
    engine.updateProjectAppearance(project);
    expect(compositor().prepareDetail).toHaveBeenCalledOnce();
    expect(compositor().visible![0]![0]).toMatchObject({ opacity: 0.25, detail: project.clips[0]!.detail });
    expect(streams().starts).toHaveLength(starts);
    expect(compositor().uploadFrame).toHaveBeenCalledTimes(2);
  });

  it('prepares the detail programs for a live track HDR draft', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    const layer = project.layers[0]!;
    engine.updateColour(layer.id, { ...layer.colour, hdr: 0 });
    expect(compositor().prepareDetail).not.toHaveBeenCalled();
    engine.updateColour(layer.id, { ...layer.colour, hdr: 0.7 });
    expect(compositor().prepareDetail).toHaveBeenCalledOnce();
    expect(compositor().visible![0]![0]!.settings.hdr).toBe(0.7);
  });

  it('rejects timing changes rather than silently keeping old timing', async () => {
    const project = layeredProject(2);
    const engine = await paused(project, 0);
    const changes: ((document: ProjectDocument) => void)[] = [
      (document) => {
        document.clips[0]!.sourceIn++;
      },
      (document) => {
        document.clips[0]!.mediaId = 'another-media';
      },
      (document) => {
        document.clips[0]!.speed = { mode: 'constant', rate: 2 };
      },
      (document) => {
        document.layers[1]!.ripple = true;
      },
      (document) => {
        document.layers[1]!.openingFade = 3;
      },
      (document) => {
        document.clips[1]!.start++;
      },
      (document) => {
        document.music = [musicTrack(60)];
      },
      (document) => {
        document.id = 'another-project';
      },
    ];
    for (const change of changes) {
      const next = structuredClone(project);
      change(next);
      expect(() => engine.updateProjectAppearance(next)).toThrow(/preserve project timing/);
    }
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', duration: 60, frame: 0 });
  });

  it('hides every track while playing, then decodes newly visible sources at the clock', async () => {
    const project = layeredProject(2);
    const { engine, anchor } = await playing(project, 10);
    const hidden = structuredClone(project);
    hidden.layers.forEach((layer) => {
      layer.enabled = false;
    });
    engine.updateProjectAppearance(hidden);
    tick(anchor, 3);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 13, activeDecoders: 0 });
    expect(compositor().visible).toEqual([]);
    engine.updateProjectAppearance(project);
    tick(anchor, 4);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 14, activeDecoders: 2 });
    expectSurface(engine, project, 14);
  });

  it('resizes decoders with the track count, keeping the active ones', async () => {
    const project = layeredProject(3);
    project.clips.splice(1, 1);
    const { engine } = await playing(project, 0);
    const stops = streams().stops.length;
    const smaller = structuredClone(project);
    smaller.layers.splice(1, 1);
    engine.updateProjectAppearance(smaller);
    expect(engine.diagnostics()).toMatchObject({ decoderCount: 4, activeDecoders: 2, playing: true });
    expect(streams().stops).toHaveLength(stops);
    await engine.loadProject(createProject('empty', 'Empty'), proxyUrl, originalDimensions);
    expect(engine.diagnostics()).toMatchObject({ status: 'empty', decoderCount: 0, assignedClipIds: [] });
    expect(compositor().count).toBe(0);
  });
});

describe('editor-only ungraded comparison', () => {
  it('starts graded and ignores mode requests without a loaded document', () => {
    const engine = makeEngine();
    const listener = vi.fn();
    engine.subscribe(listener);
    listener.mockClear();
    engine.setUngraded(true);
    expect(engine.diagnostics().ungraded).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(compositor().drawFrame).not.toHaveBeenCalled();
  });

  it.each([3, 25, 47])('neutralizes every source grade and detail but not composition at frame %i', async (frame) => {
    const project = gradedLayersProject();
    project.clips[0]!.detail = { sharpen: 0.5, clarity: 0, denoise: 0 };
    const engine = await paused(project, frame);
    const graded = structuredClone(compositor().visible)!;
    const starts = streams().starts.length;
    engine.setUngraded(true);
    expectSurface(engine, project, frame, true);
    expect(compositor().visible).toEqual(
      graded.map((group) => group.map((clip) => ({ ...clip, settings: NEUTRAL_COLOUR, detail: NEUTRAL_DETAIL }))),
    );
    engine.setUngraded(false);
    expect(compositor().visible).toEqual(graded);
    expect(streams().starts).toHaveLength(starts);
    expect(music().start).not.toHaveBeenCalled();
  });

  it('keeps the mode through a same-project reload and resets it for another project', async () => {
    const project = singleProject(true);
    const engine = await paused(project, 8);
    engine.setUngraded(true);
    const reloaded = structuredClone(project);
    reloaded.clips[0]!.speed = { mode: 'constant', rate: 2 };
    await engine.loadProject(reloaded, proxyUrl, originalDimensions, 12);
    expect(engine.diagnostics()).toMatchObject({ ungraded: true, status: 'paused', frame: 12 });
    expectSurface(engine, reloaded, 12, true);
    const next = singleProject();
    next.id = 'next-project';
    await engine.loadProject(next, proxyUrl, originalDimensions, 8);
    expect(engine.diagnostics()).toMatchObject({ ungraded: false, status: 'paused' });
    expectSurface(engine, next, 8);
  });

  it('switches modes while playing without new clocks, music epochs or decoders', async () => {
    const project = singleProject(true);
    const { engine, anchor } = await playing(project, 8);
    const starts = streams().starts.length;
    const pauses = music().pause.mock.calls.length;
    engine.setUngraded(true);
    tick(anchor, 2);
    expectSurface(engine, project, 10, true);
    engine.setUngraded(false);
    tick(anchor, 4);
    expectSurface(engine, project, 12);
    expect(streams().starts).toHaveLength(starts);
    expect(music().start).toHaveBeenCalledOnce();
    expect(music().pause).toHaveBeenCalledTimes(pauses);
  });

  it('publishes playback snapshots only from the tick that draws at the clock', async () => {
    const project = singleProject(true);
    const { engine, anchor } = await playing(project, 8);
    tick(anchor, 1);
    const seen: { frame: number; ungraded: boolean; status: string }[] = [];
    engine.subscribe(({ frame, ungraded, status }) => seen.push({ frame, ungraded, status }));
    state.now = anchor + framesToSeconds(5) * 1000;
    engine.setUngraded(true);
    expect(seen).toEqual([]);
    tick(anchor, 5);
    expect(seen).toEqual([{ frame: 13, ungraded: true, status: 'playing' }]);
    engine.pause();
    expect(seen.at(-1)).toMatchObject({ status: 'paused', frame: 13 });
  });
});

describe('lifecycle', () => {
  it('configures every music instance and previews a music-only project as black', async () => {
    const project = layeredProject();
    project.music = Array.from({ length: 8 }, (_value, index) => ({
      ...musicTrack(600),
      id: `music-${index}`,
      mediaId: `source-${index}`,
      sourceOut: 60,
      start: index * 20,
      loop: true,
    }));
    const engine = makeEngine();
    await engine.loadProject(project, proxyUrl, originalDimensions, 15);
    expect(music().configure).toHaveBeenCalledWith(project.music, expect.any(AbortSignal));
    expect(engine.diagnostics()).toMatchObject({ duration: 740, frame: 15 });
    await engine.loadProject({ ...project, clips: [] }, proxyUrl, originalDimensions);
    expect(engine.diagnostics()).toMatchObject({ duration: 740, frame: 0, status: 'paused', decoderCount: 0 });
    expect(compositor().visible).toEqual([]);
    expect(engine.capturePixels()).toEqual(new Uint8Array([0, 0, 0, 255]));
    await engine.play();
    tick(state.now, 739);
    expect(engine.diagnostics()).toMatchObject({ status: 'playing', frame: 739, activeDecoders: 0, audioClock: true });
  });

  it('releases every decoder on context loss and restores a paused frame', async () => {
    const project = layeredProject(8, true);
    const { engine } = await playing(project, 51);
    compositor().lost = true;
    const lost = new Event('webglcontextlost', { cancelable: true });
    engine.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(engine.diagnostics()).toMatchObject({
      status: 'error',
      playing: false,
      decoderCount: 0,
      activeDecoders: 0,
      assignedClipIds: [],
      gpuTextureMiB: 0,
    });
    engine.canvas.dispatchEvent(new Event('webglcontextrestored'));
    await settle();
    expect(engine.diagnostics()).toMatchObject({ status: 'paused', decoderCount: 16, frame: 51 });
    expectSurface(engine, project, 51);
    engine.dispose();
    expect(engine.diagnostics()).toMatchObject({ status: 'disposed', decoderCount: 0, assignedClipIds: [] });
    expect(streams().disposed).toBe(true);
    expect(music().dispose).toHaveBeenCalled();
    expect(state.compositors.every((renderer) => renderer.disposed)).toBe(true);
  });

  it('reports GPU restoration failure without throwing out of the context event', async () => {
    const project = layeredProject(2);
    const engine = await paused(project, 0);
    compositor().lost = true;
    engine.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    state.failCompositor = true;
    expect(() => engine.canvas.dispatchEvent(new Event('webglcontextrestored'))).not.toThrow();
    expect(engine.diagnostics()).toMatchObject({
      status: 'error',
      message: 'Synthetic GPU allocation failed.',
      decoderCount: 0,
    });
    project.layers[0]!.opacity = 0.2;
    expect(() => engine.updateProjectAppearance(project)).not.toThrow();
    expect(() => engine.capturePixels()).toThrow(/required decoded frames/);
  });

  it('parses a snapshot so later caller edits cannot change the loaded project', async () => {
    const project = singleProject();
    const engine = await paused(project, 8);
    const before = structuredClone(compositor().visible);
    project.layers[0]!.colour.exposure = 2;
    engine.capturePixels();
    expect(compositor().visible).toEqual(before);
    expect(projectSchema.parse(project).layers[0]!.colour.exposure).toBe(2);
  });
});
