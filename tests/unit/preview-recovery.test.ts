import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CompositeGroup } from '../../src/preview/compositor.js';
import { PreviewEngine } from '../../src/preview/engine.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import {
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type MusicTrack,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { framesToSeconds, type FrameRate } from '../../src/shared/timing.js';

// Desired recovery regressions, not assertions accepting the existing flicker.
// Only browser/native boundaries are mocked; schema, layout and source maps stay real.
interface DecoderDouble {
  index: number;
  video: HTMLVideoElement;
  decodedFrame: number;
  ready: boolean;
  observedFrames: number;
  lateCallbacks: number;
  droppedFrames: number;
  aspect: number;
  observe: (frame: number) => void;
  load: Mock<(url: string, rate: FrameRate, signal: AbortSignal) => Promise<void>>;
  seek: Mock<(frame: number, signal: AbortSignal) => Promise<void>>;
  play: Mock<() => Promise<void>>;
  pause: Mock<() => void>;
  setRate: Mock<(rate: number) => void>;
  dispose: Mock<() => void>;
}
type Texture = { sourceFrame: number; url: string };
type Surface = { clips: (CompositeGroup['clips'][number] & Texture)[] }[];
interface CompositorDouble {
  visible: Surface | null;
  setDecoderCount: Mock<(count: number) => void>;
  clear: Mock<() => void>;
  uploadVideo: Mock<(index: number, video: HTMLVideoElement) => void>;
  drawFrame: Mock<(groups: readonly CompositeGroup[]) => void>;
}
interface MusicDouble {
  clockFrame: number;
  clockTime: number;
  running: boolean;
  configure: Mock<(tracks: readonly MusicTrack[], signal: AbortSignal) => Promise<void>>;
  resumeContext: Mock<() => Promise<void>>;
  start: Mock<(frame: number, signal: AbortSignal) => Promise<void>>;
  sync: Mock<() => boolean>;
  pause: Mock<() => void>;
}
const doubles = vi.hoisted(() => ({
  now: 1_000,
  slots: [] as DecoderDouble[],
  compositors: [] as CompositorDouble[],
  music: [] as MusicDouble[],
}));

vi.mock('../../src/preview/decoder.js', () => ({
  VideoDecoderSlot: class {
    readonly video = {
      src: '',
      currentTime: 0,
      readyState: 0,
      seeking: false,
      paused: true,
      playbackRate: 1,
      videoWidth: 1280,
      videoHeight: 720,
      error: null,
    } as HTMLVideoElement;
    decodedFrame = -1;
    observedFrames = 0;
    lateCallbacks = 0;
    droppedFrames = 0;
    readonly aspect = 16 / 9;
    rate: FrameRate = { numerator: 30_000, denominator: 1_001 };
    constructor(
      _container: HTMLElement,
      readonly index: number,
      readonly onFrame?: () => void,
    ) {
      doubles.slots.push(this);
    }
    get ready(): boolean {
      return !this.video.seeking && this.video.readyState >= 2 && this.decodedFrame >= 0;
    }
    observe(frame: number): void {
      this.decodedFrame = frame;
      this.observedFrames++;
      this.video.currentTime = (frame * this.rate.denominator) / this.rate.numerator;
      Object.assign(this.video, { readyState: 2, seeking: false });
      this.onFrame?.();
    }
    load = vi.fn(async (url: string, rate: FrameRate, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Cancelled load', 'AbortError');
      this.rate = rate;
      if (this.video.src === url && this.ready) return;
      this.pause();
      this.video.src = url;
      this.observe(0);
    });
    seek = vi.fn(async (frame: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Cancelled seek', 'AbortError');
      this.pause();
      this.observe(frame);
    });
    play = vi.fn(async (): Promise<void> => {
      Object.assign(this.video, { paused: false });
    });
    pause = vi.fn((): void => {
      Object.assign(this.video, { paused: true });
    });
    setRate = vi.fn((rate: number): void => {
      this.video.playbackRate = Math.max(0.1, Math.min(8, rate));
    });
    dispose = vi.fn((): void => {
      this.pause();
      Object.assign(this.video, { readyState: 0 });
    });
  },
}));

vi.mock('../../src/preview/compositor.js', () => ({
  Compositor: class {
    available = true;
    readonly renderer = 'mock observed-frame compositor';
    readonly gpuTextureMiB = 0;
    readonly textures = new Map<number, Texture>();
    visible: Surface | null = null;
    constructor(_canvas: HTMLCanvasElement) {
      doubles.compositors.push(this);
    }
    setDecoderCount = vi.fn((_count: number): void => {});
    uploadVideo = vi.fn((index: number, video: HTMLVideoElement): void => {
      const slot = doubles.slots.find((item) => item.video === video);
      if (!slot?.ready) throw new Error('Cannot upload an unavailable decoded frame');
      this.textures.set(index, { sourceFrame: slot.decodedFrame, url: video.src });
    });
    drawFrame = vi.fn((groups: readonly CompositeGroup[]): void => {
      // Real drawFrame clears internally as part of a completed replacement draw.
      // This spy models standalone engine clears, which leave no accepted image.
      this.visible = groups.map((group) => ({
        clips: group.clips.map((clip) => {
          const texture = this.textures.get(clip.slot);
          if (!texture) throw new Error('Cannot draw an unuploaded source');
          return { ...clip, settings: { ...clip.settings }, ...texture };
        }),
      }));
    });
    clear = vi.fn((): void => {
      this.visible = null;
    });
    readPixels = vi.fn(() => new Uint8Array([0, 0, 0, 255]));
    dispose = vi.fn((): void => {
      this.available = false;
    });
  },
}));

vi.mock('../../src/preview/music.js', () => ({
  MusicPlayback: class {
    tracks: readonly MusicTrack[] = [];
    clockFrame = 0;
    clockTime = 0;
    running = false;
    readonly errorFrames = 0;
    constructor() {
      doubles.music.push(this);
    }
    get hasMusic(): boolean {
      return this.tracks.length > 0;
    }
    get clockSeconds(): number {
      return doubles.now / 1000;
    }
    configure = vi.fn(async (tracks: readonly MusicTrack[], signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Cancelled music configuration', 'AbortError');
      this.pause();
      this.tracks = tracks;
    });
    resumeContext = vi.fn(async (): Promise<void> => {});
    start = vi.fn(async (frame: number, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) throw new DOMException('Cancelled music start', 'AbortError');
      this.clockFrame = frame;
      this.clockTime = doubles.now;
      this.running = true;
    });
    projectFrame = vi.fn(
      () => this.clockFrame + Math.floor((Math.max(0, doubles.now - this.clockTime) * 30_000) / 1_001_000 + 1e-7),
    );
    sync = vi.fn(() => true);
    pause = vi.fn((): void => {
      this.running = false;
    });
    dispose = vi.fn((): void => {
      this.pause();
      this.tracks = [];
    });
  },
}));

const callbacks = new Map<number, FrameRequestCallback>();
const engines: PreviewEngine[] = [];
let nextCallback = 0;
beforeEach(() => {
  doubles.now = 1_000;
  doubles.slots.length = 0;
  doubles.compositors.length = 0;
  doubles.music.length = 0;
  callbacks.clear();
  nextCallback = 0;
  vi.stubGlobal('document', { body: { append: vi.fn() } });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++nextCallback, callback);
      return nextCallback;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  );
  vi.spyOn(performance, 'now').mockImplementation(() => doubles.now);
});
afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  callbacks.clear();
});

// Drain only bounded promise continuations; neither RAF nor a media clock advances.
async function settle(): Promise<void> {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}
const proxyUrl = (id: string): string => `https://preview.invalid/proxy/${id}`;
function singleProject(withMusic = false): ProjectDocument {
  const project = createProject('recovery', 'Observed frame recovery');
  project.clips = [createClip('clip', 'video', 0, 60)];
  project.media.videoIds = ['video'];
  if (withMusic) {
    project.media.audioIds = ['song'];
    project.music = [
      {
        id: 'song-instance',
        mediaId: 'song',
        sourceIn: 0,
        sourceOut: 600,
        start: 0,
        duration: 600,
        gainDb: 0,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
      },
    ];
  }
  return project;
}
function gradedProject(withMusic = false): ProjectDocument {
  const project = singleProject(withMusic);
  project.clips[0]!.colour = {
    exposure: 0.7,
    brightness: 0.1,
    contrast: 1.2,
    hue: 20,
    saturation: 0.8,
    highlights: -0.2,
    shadows: 0.3,
  };
  return project;
}
function gradedLayersProject(): ProjectDocument {
  const project = gradedProject(true);
  const lower = project.layers[0]!;
  const left = project.clips[0]!;
  left.speed = { mode: 'constant', rate: 2 };
  const right = createClip('right', 'other-video', 100, 115, lower.id);
  right.start = 20;
  right.speed = { mode: 'constant', rate: 0.5 };
  right.colour = { ...left.colour, hue: -40, saturation: 1.4 };
  lower.opacity = 0.55;
  lower.openingFade = 6;
  lower.closingFade = 8;
  lower.transitions = [{ leftId: left.id, rightId: right.id, type: 'cross-dissolve', duration: 10 }];
  lower.keyframes = [
    { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, exposure: -1, opacity: 0.6 } },
    { frame: 50, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, exposure: 1, opacity: 0.3 } },
  ];
  const upper = createLayer('upper', 'Upper');
  upper.opacity = 0.75;
  upper.openingFade = 35;
  upper.closingFade = 10;
  upper.keyframes = [
    {
      frame: 0,
      interpolation: 'smooth',
      values: { ...EMPTY_KEY_VALUES, ...left.colour, opacity: 0.35 },
    },
    {
      frame: 60,
      interpolation: 'hold',
      values: {
        ...EMPTY_KEY_VALUES,
        exposure: -0.8,
        brightness: -0.1,
        contrast: 0.6,
        hue: -75,
        saturation: 1.7,
        highlights: 0.4,
        shadows: -0.5,
        opacity: 0.7,
      },
    },
  ];
  const top = createClip('upper-clip', 'upper-video', 200, 275, upper.id);
  top.speed = { mode: 'constant', rate: 1.25 };
  project.layers.push(upper);
  project.clips.push(right, top);
  project.media.videoIds.push('other-video', 'upper-video');
  return project;
}
interface RunningPreview {
  project: ProjectDocument;
  engine: PreviewEngine;
  compositor: CompositorDouble;
  music: MusicDouble;
  initialFrame: number;
  anchor: number;
  initialStalls: number;
}
async function paused(project: ProjectDocument, initialFrame = 8): Promise<RunningPreview> {
  const snapshot = projectSchema.parse(project);
  const engine = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
  engines.push(engine);
  await engine.loadProject(snapshot, proxyUrl, initialFrame);
  await settle();
  const preview = {
    project: snapshot,
    engine,
    compositor: doubles.compositors[0]!,
    music: doubles.music[0]!,
    initialFrame,
    anchor: doubles.now,
    initialStalls: engine.diagnostics().stalls,
  };
  expect(engine.diagnostics()).toMatchObject({
    status: 'paused',
    playing: false,
    frame: initialFrame,
    ungraded: false,
  });
  expectSurface(preview, initialFrame);
  vi.clearAllMocks();
  return preview;
}
async function running(project: ProjectDocument, initialFrame = 8): Promise<RunningPreview> {
  const snapshot = projectSchema.parse(project);
  const engine = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
  engines.push(engine);
  await engine.loadProject(snapshot, proxyUrl, initialFrame);
  await engine.play();
  await settle();
  const preview = {
    project: snapshot,
    engine,
    compositor: doubles.compositors[0]!,
    music: doubles.music[0]!,
    initialFrame,
    anchor: doubles.now,
    initialStalls: engine.diagnostics().stalls,
  };
  expect(engine.diagnostics()).toMatchObject({ status: 'playing', playing: true, frame: initialFrame });
  expectSurface(preview, initialFrame);
  vi.clearAllMocks();
  return preview;
}
function slotFor(preview: RunningPreview, clipId = 'clip'): DecoderDouble {
  const index = preview.engine.diagnostics().assignedClipIds.indexOf(clipId);
  expect(index).toBeGreaterThanOrEqual(0);
  return doubles.slots[index]!;
}
function tick(preview: RunningPreview, expected: number, fraction = 0.1): void {
  doubles.now = preview.anchor + framesToSeconds(expected - preview.initialFrame + fraction) * 1000;
  const pending = [...callbacks.values()];
  callbacks.clear();
  expect(pending).toHaveLength(1);
  pending[0]!(doubles.now);
}
function observeAt(preview: RunningPreview, frame: number): void {
  for (const layer of sampleTimeline(preview.project, frame)) slotFor(preview, layer.clipId).observe(layer.sourceFrame);
}
function expectSurface(preview: RunningPreview, frame: number, ungraded = false): void {
  const layers = sampleTimeline(preview.project, frame, calculateLayout(preview.project));
  expect(preview.compositor.visible).toEqual(
    preview.project.layers.flatMap((group) => {
      const members = layers.filter((layer) => layer.layerId === group.id);
      return members.length
        ? [
            {
              clips: members.map((layer) => ({
                slot: preview.engine.diagnostics().assignedClipIds.indexOf(layer.clipId),
                sourceFrame: layer.sourceFrame,
                url: proxyUrl(layer.mediaId),
                settings: ungraded ? NEUTRAL_COLOUR : layer.colour,
                aspect: 16 / 9,
                opacity: layer.opacity,
                blendWeight: layer.blendWeight,
                brightness: layer.brightness,
              })),
            },
          ]
        : [];
    }),
  );
}
function expectNoMediaOperations(preview: RunningPreview): void {
  expect(preview.compositor.setDecoderCount).not.toHaveBeenCalled();
  expect(preview.music.configure).not.toHaveBeenCalled();
  expect(preview.music.resumeContext).not.toHaveBeenCalled();
  expect(preview.music.start).not.toHaveBeenCalled();
  expect(preview.music.pause).not.toHaveBeenCalled();
  for (const slot of doubles.slots) {
    expect(slot.load).not.toHaveBeenCalled();
    expect(slot.seek).not.toHaveBeenCalled();
    expect(slot.play).not.toHaveBeenCalled();
    expect(slot.pause).not.toHaveBeenCalled();
    expect(slot.setRate).not.toHaveBeenCalled();
    expect(slot.dispose).not.toHaveBeenCalled();
  }
}
function expectUninterrupted(preview: RunningPreview): void {
  expect(preview.engine.diagnostics()).toMatchObject({
    status: 'playing',
    playing: true,
    stalls: preview.initialStalls,
  });
  expect(preview.compositor.clear).not.toHaveBeenCalled();
  expect(preview.music.pause).not.toHaveBeenCalled();
  expect(preview.music.start).not.toHaveBeenCalled();
  for (const slot of doubles.slots) expect(slot.seek).not.toHaveBeenCalled();
}

function holdNextLoad(slot: DecoderDouble, completeAfterAbort = false) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = slot.load.getMockImplementation()!;
  slot.load.mockImplementationOnce(async (...args) => {
    // Keep a real boundary promise pending even after cancellation, to check
    // that late completion cannot draw or restore an obsolete project mode.
    await gate;
    if (completeAfterAbort && args[2].aborted) return;
    await load(...args);
  });
  return { release };
}
function holdNextSeek(slot: DecoderDouble) {
  let release!: () => void;
  let fail!: (error: Error) => void;
  let request: { frame: number; signal: AbortSignal } | null = null;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  slot.seek.mockImplementationOnce(async (frame, signal) => {
    request = { frame, signal };
    slot.pause();
    Object.assign(slot.video, { seeking: true });
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(new DOMException('Cancelled pending seek', 'AbortError'));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void gate.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
    if (signal.aborted) throw new DOMException('Cancelled pending seek', 'AbortError');
    slot.observe(frame);
  });
  return {
    release,
    fail,
    started: () => request !== null,
    request: () => {
      expect(request).not.toBeNull();
      return request!;
    },
  };
}
async function pendingRecovery(unavailable = false) {
  const preview = await running(singleProject(true));
  const slot = slotFor(preview);
  const pending = holdNextSeek(slot);
  if (unavailable) {
    slot.decodedFrame = -1;
    Object.assign(slot.video, { readyState: 1 });
  } else slot.observe(12); // Two frames ahead of expected 10, not an exact neighbour.
  slot.video.currentTime = framesToSeconds(10); // currentTime is not decoded identity.
  tick(preview, 10);
  await settle();
  expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true, frame: 8 });
  expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
  let recoveryFrame = 10;
  // Permit immediate recovery or the existing one-frame mismatch grace period.
  // In either case its seek must deliver the exact frame it is recovering to.
  if (!pending.started()) {
    if (!unavailable) slot.observe(13);
    tick(preview, 11, 0.25);
    await settle();
    recoveryFrame = 11;
  }
  expect(pending.request().frame).toBe(recoveryFrame);
  expect(pending.request().signal.aborted).toBe(false);
  expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true });
  expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
  expect(preview.music.start).not.toHaveBeenCalled();
  return { preview, slot, pending, recoveryFrame };
}

describe('PreviewEngine final publication boundary', () => {
  async function publicationPreview(initialFrame = 65): Promise<RunningPreview> {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 90;
    return running(project, initialFrame);
  }
  function advanceAudio(preview: RunningPreview, frame: number): void {
    doubles.now = preview.anchor + framesToSeconds(frame - preview.initialFrame + 0.1) * 1000;
  }
  function expectVideoOnlyBuffer(preview: RunningPreview): void {
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'buffering',
      playing: true,
      frame: 69,
      requestedFrame: 71,
      decodedSourceFrames: [69, -1],
      decoderReady: [true, false],
    });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.running).toBe(true);
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(preview.music.pause).not.toHaveBeenCalled();
    for (const slot of doubles.slots) expect(slot.seek).not.toHaveBeenCalled();
  }

  it.each(['before snapshot', 'after snapshot'] as const)(
    'rejects accepted 69 when diagnostics construction advances audio 70 to 71 (%s)',
    async (phase) => {
      const preview = await publicationPreview();
      slotFor(preview).observe(69);
      const published: string[] = [];
      preview.engine.subscribe((state) => {
        published.push(state.status);
        if (state.status === 'buffering') expect(preview.compositor.visible).toBeNull();
      });
      published.length = 0;
      const diagnostics = preview.engine.diagnostics.bind(preview.engine);
      vi.spyOn(preview.engine, 'diagnostics').mockImplementationOnce(() => {
        if (phase === 'before snapshot') advanceAudio(preview, 71);
        const snapshot = diagnostics();
        if (phase === 'after snapshot') advanceAudio(preview, 71);
        return snapshot;
      });
      tick(preview, 70);
      expect(published).toEqual(['buffering']);
      expectVideoOnlyBuffer(preview);
      slotFor(preview).observe(71);
      expectSurface(preview, 71);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 71 });
      expect(preview.music.start).not.toHaveBeenCalled();
    },
  );

  it('protects the actual surface after diagnostics work even without subscribers', async () => {
    const preview = await publicationPreview();
    slotFor(preview).observe(69);
    const diagnostics = preview.engine.diagnostics.bind(preview.engine);
    vi.spyOn(preview.engine, 'diagnostics').mockImplementationOnce(() => {
      const snapshot = diagnostics();
      advanceAudio(preview, 71);
      return snapshot;
    });
    tick(preview, 70);
    expectVideoOnlyBuffer(preview);
  });

  it('rejects a one-frame-old source set when diagnostics work crosses a clip boundary', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 70;
    const right = createClip('right', 'next-video', 100, 120);
    right.start = 70;
    project.clips.push(right);
    project.media.videoIds.push('next-video');
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cut', duration: 0 }];
    const preview = await running(project, 65);
    slotFor(preview).observe(69);
    const published: string[] = [];
    preview.engine.subscribe((state) => published.push(state.status));
    published.length = 0;
    const diagnostics = preview.engine.diagnostics.bind(preview.engine);
    vi.spyOn(preview.engine, 'diagnostics').mockImplementationOnce(() => {
      const snapshot = diagnostics();
      advanceAudio(preview, 70);
      return snapshot;
    });
    tick(preview, 69);
    expect(published).toEqual(['buffering']);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 69, requestedFrame: 70 });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    for (const slot of doubles.slots) expect(slot.seek).not.toHaveBeenCalled();
  });

  it('validates initial subscription after diagnostics work advances the output clock', async () => {
    const preview = await publicationPreview(69);
    advanceAudio(preview, 70);
    const diagnostics = preview.engine.diagnostics.bind(preview.engine);
    vi.spyOn(preview.engine, 'diagnostics').mockImplementationOnce(() => {
      const snapshot = diagnostics();
      advanceAudio(preview, 71);
      return snapshot;
    });
    const published: string[] = [];
    preview.engine.subscribe((state) => published.push(state.status));
    expect(published).toEqual(['buffering']);
    expectVideoOnlyBuffer(preview);
  });

  it('rechecks the current clock immediately before each listener', async () => {
    const preview = await publicationPreview();
    slotFor(preview).observe(69);
    let armed = false;
    preview.engine.subscribe((state) => {
      if (armed && state.status === 'playing') {
        armed = false;
        expect(state).toMatchObject({ frame: 69, requestedFrame: 70 });
        expectSurface(preview, 69);
        advanceAudio(preview, 71);
      }
    });
    const published: string[] = [];
    preview.engine.subscribe((state) => published.push(state.status));
    published.length = 0;
    armed = true;
    tick(preview, 70);
    expect(published).toEqual(['buffering']);
    expectVideoOnlyBuffer(preview);
  });

  it.each(['pause', 'seek', 'nested emit'] as const)(
    'cancels the remaining obsolete Playing dispatch after an earlier listener causes %s',
    async (action) => {
      const preview = await publicationPreview();
      slotFor(preview).observe(69);
      let armed = false;
      preview.engine.subscribe((state) => {
        if (!armed || state.status !== 'playing') return;
        armed = false;
        if (action === 'pause') preview.engine.pause();
        else if (action === 'seek') void preview.engine.seek(20);
        else preview.engine.setUngraded(true);
      });
      const published: string[] = [];
      preview.engine.subscribe((state) => published.push(state.status));
      published.length = 0;
      armed = true;
      tick(preview, 70);
      expect(published).toEqual(
        action === 'seek' ? ['paused', 'seeking'] : [action === 'pause' ? 'paused' : 'buffering'],
      );
      if (action === 'pause') {
        expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false });
        expectSurface(preview, 69);
      } else if (action === 'seek') {
        expect(preview.compositor.visible).toBeNull();
        await settle();
        expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, frame: 20 });
        expectSurface(preview, 20);
      } else {
        expect(preview.compositor.visible).toBeNull();
        expect(preview.music.pause).not.toHaveBeenCalled();
      }
      expect(preview.music.start).not.toHaveBeenCalled();
    },
  );

  it('rejects stale appearance dirtied by an earlier listener without a nested emit', async () => {
    const preview = await publicationPreview();
    slotFor(preview).observe(69);
    let armed = false;
    preview.engine.subscribe((state) => {
      if (!armed || state.status !== 'playing') return;
      armed = false;
      preview.engine.updateColour('clip', { ...NEUTRAL_COLOUR, exposure: 1 });
    });
    const published: string[] = [];
    preview.engine.subscribe((state) => published.push(state.status));
    published.length = 0;
    armed = true;
    tick(preview, 70);
    expect(published).toEqual(['buffering']);
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it.each([70, 71])(
    'advances an empty composition to exact black/end at audio %i after diagnostics work',
    async (audio) => {
      const project = singleProject(true);
      project.clips[0]!.sourceOut = 70;
      project.music[0]!.duration = 71;
      const preview = await running(project, 65);
      slotFor(preview).observe(69);
      const published: string[] = [];
      preview.engine.subscribe((state) => published.push(state.status));
      published.length = 0;
      const diagnostics = preview.engine.diagnostics.bind(preview.engine);
      vi.spyOn(preview.engine, 'diagnostics').mockImplementationOnce(() => {
        const snapshot = diagnostics();
        advanceAudio(preview, audio);
        return snapshot;
      });
      tick(preview, 69);
      await settle();
      expect(published).not.toContain('playing');
      expectSurface(preview, 70);
      expect(preview.compositor.visible).toEqual([]);
      expect(preview.engine.diagnostics()).toMatchObject({ status: audio === 70 ? 'playing' : 'paused', frame: 70 });
      expect(preview.music.running).toBe(audio === 70);
      if (audio === 70) expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      for (const slot of doubles.slots) expect(slot.seek).not.toHaveBeenCalled();
    },
  );
});

describe('PreviewEngine observed-frame tolerance and recovery', () => {
  it.each([42, 46])(
    'rejects a stale post-render image from frame %i even between throttled notifications',
    async (initialFrame) => {
      const preview = await running(singleProject(true), initialFrame);
      slotFor(preview).observe(46);
      const published: { frame: number; audioFrame: number }[] = [];
      const unsubscribe = preview.engine.subscribe((state) => {
        if (state.status === 'playing')
          published.push({
            frame: state.frame,
            audioFrame: preview.initialFrame + Math.floor(((doubles.now - preview.anchor) * 30_000) / 1_001_000 + 1e-7),
          });
      });
      published.length = 0;
      const draw = preview.compositor.drawFrame.getMockImplementation()!;
      preview.compositor.drawFrame.mockImplementationOnce((groups) => {
        draw(groups);
        // Recorded witness: request 47 accepts neighbour 46; by publication
        // the independently rendered audio has reached 48. Model elapsed
        // render/upload work, not a false audio receipt or changed tolerance.
        doubles.now = preview.anchor + framesToSeconds(48 - preview.initialFrame + 0.1) * 1000;
      });
      tick(preview, 47);
      expect(
        published.every(({ frame, audioFrame }) => Math.abs(frame - audioFrame) <= 1),
        JSON.stringify(published),
      ).toBe(true);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 46, requestedFrame: 48 });
      expect(preview.compositor.visible).toBeNull();
      expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      slotFor(preview).observe(48);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 48 });
      expectSurface(preview, 48);
      unsubscribe();
    },
  );

  it('still publishes a real accepted image within one frame after rendering work', async () => {
    const preview = await running(singleProject(true), 42);
    slotFor(preview).observe(46);
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      doubles.now = preview.anchor + framesToSeconds(47 - preview.initialFrame + 0.9) * 1000;
    });
    tick(preview, 47);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 46, requestedFrame: 47 });
    expectSurface(preview, 46);
    expectUninterrupted(preview);
  });

  it('rejects an exact pre-render frame when output advances beyond its eligibility', async () => {
    const preview = await running(singleProject(true), 42);
    slotFor(preview).observe(47);
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      doubles.now = preview.anchor + framesToSeconds(49 - preview.initialFrame + 0.1) * 1000;
    });
    tick(preview, 47);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 47, requestedFrame: 49 });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it('does not retain a one-frame-old image after rendering crosses an active-clip boundary', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 48;
    const right = createClip('right', 'next-video', 100, 120);
    right.start = 48;
    project.clips.push(right);
    project.media.videoIds.push('next-video');
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cut', duration: 0 }];
    const preview = await running(project, 42);
    slotFor(preview).observe(47);
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      doubles.now = preview.anchor + framesToSeconds(48 - preview.initialFrame + 0.1) * 1000;
    });
    tick(preview, 47);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 47, requestedFrame: 48 });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it('reports an output-clock failure discovered at publication instead of emitting an invalid Playing state', async () => {
    const preview = await running(singleProject(true), 42);
    slotFor(preview).observe(46);
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    const music = preview.music as MusicDouble & { projectFrame: Mock<() => number> };
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      music.projectFrame.mockImplementationOnce(() => {
        throw new Error('Music output has an invalid presentation clock.');
      });
    });
    tick(preview, 47);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'error',
      playing: false,
      message: 'Music output has an invalid presentation clock.',
    });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it.each([
    { observed: 4, requested: 7, delivered: 14 },
    { observed: 9, requested: 12, delivered: 11 },
    { observed: 9, requested: 12, delivered: 12 },
  ])(
    'requires owned current-source delivery for replay $observed/$requested/$delivered without restarting music',
    async ({ observed, requested, delivered }) => {
      const preview = await running(singleProject(true), observed);
      const slot = slotFor(preview);
      const pending = holdNextSeek(slot);
      tick(preview, requested - 1);
      await settle();
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: observed });
      tick(preview, requested, 0.25);
      await settle();
      expect(pending.request().frame).toBe(requested);
      // Replay metadata captured by the test before that seek. Even eligible
      // metadata cannot publish Playing while the owned seek is incomplete;
      // future metadata (the 4/7/14 CI case) must not satisfy exact readiness.
      slot.observe(delivered);
      expect(preview.engine.diagnostics()).toMatchObject({
        status: 'buffering',
        frame: observed,
        requestedFrame: requested,
      });
      expect(preview.compositor.visible).toBeNull();
      expect(slot.play).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      pending.release();
      await settle();
      expect(slot.decodedFrame).toBe(requested);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: requested });
      expectSurface(preview, requested);
      expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'accepts a genuinely delivered frame between display ticks before stale mismatch time restarts playback (music=%s)',
    async (withMusic) => {
      const preview = await running(singleProject(withMusic));
      const slot = slotFor(preview);
      slot.observe(9);
      tick(preview, 11);
      await settle();
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 8, requestedFrame: 11 });
      expect(preview.compositor.visible).toBeNull();
      // rVFC is delivered after this display tick. The image is genuinely
      // ready/exact now; do not wait for a later tick's different clock frame.
      slot.observe(11);
      const delivered = preview.engine.diagnostics();
      vi.clearAllMocks();
      // The next display callback skips one tick. Its new mismatch must not
      // inherit the earlier, already-resolved mismatch's grace period.
      tick(preview, 13);
      await settle();
      expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      expect(slot.seek).not.toHaveBeenCalled();
      expect(delivered).toMatchObject({ status: 'playing', frame: 11, requestedFrame: 11 });
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 11, requestedFrame: 13 });
      slot.observe(13);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 13 });
      expectSurface(preview, 13);
    },
  );

  it('does not accept a delivered frame against an obsolete display tick instead of the current audio clock', async () => {
    const preview = await running(singleProject(true));
    const slot = slotFor(preview);
    slot.observe(9);
    tick(preview, 11);
    doubles.now = preview.anchor + framesToSeconds(13 - preview.initialFrame + 0.1) * 1000;
    slot.observe(11);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 8, requestedFrame: 13 });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.start).not.toHaveBeenCalled();
    slot.observe(13);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 13 });
    expectSurface(preview, 13);
  });

  it('keeps failed music synchronization explicit when a decoded callback arrives', async () => {
    const preview = await running(singleProject(true));
    const slot = slotFor(preview);
    slot.observe(9);
    tick(preview, 11);
    preview.music.sync.mockReturnValueOnce(false);
    slot.observe(11);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 8 });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.start).not.toHaveBeenCalled();
    slot.observe(11);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 11 });
    expectSurface(preview, 11);
  });

  it('does not let a delivered callback bypass a pending owned seek or deliberate pause', async () => {
    const { preview, slot, pending } = await pendingRecovery();
    const requested = pending.request();
    slot.observe(requested.frame);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true });
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.start).not.toHaveBeenCalled();
    preview.engine.pause();
    vi.clearAllMocks();
    slot.observe(requested.frame);
    pending.release();
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false });
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it('does not retain stale appearance when the accepted texture needs an updated grade', async () => {
    const preview = await running(singleProject(true));
    Object.assign(slotFor(preview).video, { readyState: 1 });
    preview.engine.updateColour('clip', { ...preview.project.clips[0]!.colour, exposure: 1 });
    tick(preview, 9);
    expect(preview.engine.diagnostics().status).toBe('buffering');
    expect(preview.compositor.visible).toBeNull();
    // The delivered source now redraws the evaluated grade immediately.
    slotFor(preview).observe(9);
    expect(preview.compositor.visible![0]!.clips[0]!.settings.exposure).toBe(1);
  });

  it('still realigns failed music synchronization even when the accepted image is within one frame', async () => {
    const preview = await running(singleProject(true));
    preview.music.sync.mockReturnValueOnce(false);
    tick(preview, 9);
    await settle();
    expect(preview.music.pause).toHaveBeenCalled();
    expect(preview.music.start).toHaveBeenCalledTimes(1);
    expectSurface(preview, 9);
  });

  it.each(['dissolve', 'upper track'] as const)('does not retain an ended participant from a %s', async (topology) => {
    const project = singleProject();
    project.clips[0]!.sourceOut = 30;
    const right = createClip(
      'right',
      'other-video',
      100,
      130,
      topology === 'upper track' ? 'upper' : project.layers[0]!.id,
    );
    if (topology === 'upper track') {
      project.layers.push(createLayer('upper', 'Upper'));
      project.clips[0]!.sourceOut = 60;
    } else {
      right.start = 10;
      project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cross-dissolve', duration: 20 }];
    }
    project.clips.push(right);
    project.media.videoIds.push('other-video');
    const preview = await running(project, 29);
    // Every slot still shows the preceding valid frame, but one participant has ended.
    tick(preview, 30);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', frame: 29 });
    expect(preview.compositor.visible).toBeNull();
    observeAt(preview, 30);
    tick(preview, 30, 0.5);
    expectSurface(preview, 30);
  });

  it.each([false, true])(
    'retains the last accepted image for one unavailable callback (music=%s)',
    async (withMusic) => {
      const preview = await running(singleProject(withMusic));
      const accepted = structuredClone(preview.compositor.visible);
      const slot = slotFor(preview);
      // The previously uploaded frame is valid, although this slot cannot upload now.
      Object.assign(slot.video, { readyState: 1 });
      slot.video.currentTime = framesToSeconds(9);
      tick(preview, 9);
      expect(preview.engine.diagnostics()).toMatchObject({
        requestedFrame: 9,
        decodedSourceFrames: [8, -1],
        decoderReady: [false, false],
      });
      expect(preview.compositor.visible).toEqual(accepted);
      expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
      expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
      expect(preview.engine.diagnostics().frame).toBe(8);
      expectUninterrupted(preview);
      slot.observe(9);
      tick(preview, 9, 0.5);
      await settle();
      expectSurface(preview, 9);
      expect(preview.engine.diagnostics().frame).toBe(9);
      expectUninterrupted(preview);
    },
  );

  it.each(['clip', 'row'] as const)(
    'finds expected-1 for a held 0.1x source despite its early inverse (%s speed)',
    async (mode) => {
      const project = singleProject(true);
      project.clips[0]!.sourceOut = 6;
      project.layers[0]!.keyframes = [
        {
          frame: 0,
          interpolation: 'linear',
          values: { ...EMPTY_KEY_VALUES, exposure: 0, speed: mode === 'row' ? 0.1 : null },
        },
        {
          frame: 50,
          interpolation: 'hold',
          values: { ...EMPTY_KEY_VALUES, exposure: 1, speed: mode === 'row' ? 0.1 : null },
        },
      ];
      if (mode === 'clip') project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
      const map = calculateLayout(project).clips[0]!.retiming;
      expect([map.sourceAt(9), map.sourceAt(10), map.outputAt(0)]).toEqual([0, 1, 0]);
      const preview = await running(project);
      slotFor(preview).observe(0);
      tick(preview, 10);
      // Frame 8 is now too old to retain. Frame 9 is an exact, fully graded redraw.
      expect(preview.engine.diagnostics().frame).toBe(9);
      expect(preview.compositor.drawFrame).toHaveBeenCalledTimes(1);
      expectSurface(preview, 9);
      expectUninterrupted(preview);
    },
  );

  it('also accepts expected+1 when every source exactly maps to that neighbour', async () => {
    const project = singleProject(true);
    project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
    project.layers.push(createLayer('upper', 'Upper'));
    project.clips.push(createClip('upper-clip', 'upper-video', 100, 700, 'upper'));
    project.media.videoIds.push('upper-video');
    const map = calculateLayout(project).clips[0]!.retiming;
    expect([map.sourceAt(9), map.sourceAt(10), map.outputAt(1)]).toEqual([0, 1, 10]);
    const preview = await running(project);
    observeAt(preview, 10);
    tick(preview, 9);
    expect(preview.engine.diagnostics().frame).toBe(10);
    expectSurface(preview, 10);
    expectUninterrupted(preview);
  });

  it.each(['layers', 'dissolve'] as const)(
    'rejects mixed neighbour source maps across all %s participants',
    async (topology) => {
      const project = singleProject();
      project.clips[0]!.sourceOut = 30;
      const right = createClip(
        'right',
        'other-video',
        100,
        130,
        topology === 'layers' ? 'upper' : project.layers[0]!.id,
      );
      if (topology === 'layers') project.layers.push(createLayer('upper', 'Upper'));
      else {
        right.start = 10;
        project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cross-dissolve', duration: 20 }];
      }
      project.clips.push(right);
      project.media.videoIds.push('other-video');
      const preview = await running(project, 13);
      const earlier = sampleTimeline(project, 14);
      const later = sampleTimeline(project, 16);
      slotFor(preview).observe(earlier.find((layer) => layer.clipId === 'clip')!.sourceFrame);
      slotFor(preview, 'right').observe(later.find((layer) => layer.clipId === 'right')!.sourceFrame);
      for (const candidate of [14, 15, 16]) {
        expect(
          sampleTimeline(project, candidate).every(
            (layer) => slotFor(preview, layer.clipId).decodedFrame === layer.sourceFrame,
          ),
        ).toBe(false);
      }
      tick(preview, 15);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true, frame: 13 });
      expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
      expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
      observeAt(preview, 15);
      tick(preview, 15, 0.5);
      await settle();
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 15 });
      expectSurface(preview, 15);
    },
  );

  it.each([false, true])(
    'buffers beyond one frame and seeks an exact source before recovery (unavailable=%s)',
    async (unavailable) => {
      const { preview, slot, pending, recoveryFrame } = await pendingRecovery(unavailable);
      pending.release();
      await settle();
      expect(slot.decodedFrame).toBe(recoveryFrame);
      expect(slot.ready).toBe(true);
      expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', playing: true, frame: recoveryFrame });
      expectSurface(preview, recoveryFrame);
      expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
    },
  );

  it('catches up to the current audio frame after a delayed video seek without reanchoring healthy music', async () => {
    const { preview, slot, pending, recoveryFrame } = await pendingRecovery();
    doubles.now = preview.anchor + framesToSeconds(14 - preview.initialFrame + 0.1) * 1000;
    pending.release();
    await settle();
    expect(slot.seek.mock.calls.map(([frame]) => frame)).toEqual([recoveryFrame, 14]);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', playing: true, frame: 14 });
    expectSurface(preview, 14);
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it('retains one catch-up deadline and reports failure when the current audio frame never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Deadline reached', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    try {
      const { preview, slot, pending } = await pendingRecovery();
      expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(preview.engine.diagnostics()).toMatchObject({
        status: 'error',
        playing: false,
        message: 'Video catch-up did not deliver the current audio frame within 5 seconds.',
      });
      expect(pending.request().signal.aborted).toBe(true);
      expect(preview.compositor.visible).toBeNull();
      expect(preview.music.pause).toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      pending.release();
      await settle();
      expect(slot.play).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks delayed video play against the live audio clock within the same catch-up budget', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { preview, slot, pending, recoveryFrame } = await pendingRecovery();
    slot.play.mockImplementationOnce(async () => {
      Object.assign(slot.video, { paused: false });
      doubles.now = preview.anchor + framesToSeconds(14 - preview.initialFrame + 0.1) * 1000;
    });
    pending.release();
    await settle();
    expect(slot.seek.mock.calls.map(([frame]) => frame)).toEqual([recoveryFrame, 14]);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 14 });
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it('fully realigns a genuine music sync failure encountered during video catch-up', async () => {
    const { preview, pending } = await pendingRecovery();
    preview.music.sync.mockReturnValueOnce(false).mockReturnValueOnce(false);
    pending.release();
    await settle();
    expect(preview.music.pause).toHaveBeenCalled();
    expect(preview.music.start).toHaveBeenCalledTimes(1);
    expect(preview.engine.diagnostics().status).toBe('playing');
  });

  it('does not resume cancelled catch-up while a genuine video play promise is still pending', async () => {
    const { preview, slot, pending } = await pendingRecovery();
    let release!: () => void;
    const play = new Promise<void>((resolve) => {
      release = resolve;
    });
    slot.play.mockImplementationOnce(async () => {
      await play;
    });
    pending.release();
    await settle();
    expect(slot.play).toHaveBeenCalledOnce();
    expect(preview.engine.diagnostics().status).toBe('buffering');
    preview.engine.pause();
    vi.clearAllMocks();
    release();
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false });
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
  });

  it('reports a required recovery seek failure instead of restarting with a wrong source', async () => {
    const { preview, slot, pending } = await pendingRecovery();
    pending.fail(new Error('Required source is unavailable'));
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'error',
      playing: false,
      message: 'Required source is unavailable',
    });
    expect(pending.request().signal.aborted).toBe(true);
    expect(preview.compositor.visible).toBeNull();
    expect(preview.music.pause).toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(slot.play).not.toHaveBeenCalled();
  });

  it.each(['pause', 'dispose'] as const)('does not let an obsolete seek restart playback after %s', async (action) => {
    const { preview, slot, pending } = await pendingRecovery();
    preview.engine[action]();
    expect(pending.request().signal.aborted).toBe(true);
    vi.clearAllMocks();
    pending.release();
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({
      status: action === 'pause' ? 'paused' : 'disposed',
      playing: false,
    });
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(slot.play).not.toHaveBeenCalled();
  });

  it('keeps a genuinely new clip boundary explicit until its exact required source arrives', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 10;
    const right = createClip('right', 'next-video', 100, 120);
    right.start = 10;
    project.clips.push(right);
    project.media.videoIds.push('next-video');
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cut', duration: 0 }];
    const preview = await running(project, 9);
    const slot = slotFor(preview, 'right');
    slot.observe(99);
    const pending = holdNextSeek(slot);
    tick(preview, 10);
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true, boundaryStalls: 1 });
    expect(pending.request().frame).toBe(100);
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    pending.release();
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 10 });
    expectSurface(preview, 10);
  });

  it('renders a deliberate empty project-frame gap as black without decoded-frame recovery', async () => {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 10;
    project.layers[0]!.ripple = false;
    const right = createClip('right', 'next-video', 100, 110);
    right.start = 20;
    project.clips.push(right);
    project.media.videoIds.push('next-video');
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'cut', duration: 0 }];
    const preview = await running(project, 9);
    tick(preview, 10);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 10, activeDecoders: 0 });
    expectSurface(preview, 10);
    expect(preview.compositor.visible).toEqual([]);
    expectUninterrupted(preview);
  });
});

describe('PreviewEngine music-owned black conclusions', () => {
  function conclusion(): ProjectDocument {
    const project = singleProject(true);
    project.clips[0]!.sourceOut = 10;
    project.layers[0]!.closingFade = 3;
    project.music = [
      { ...project.music[0]!, id: 'longest', duration: 18, fadeOut: 4 },
      { ...project.music[0]!, id: 'shorter-last', start: 6, duration: 6 },
    ];
    return project;
  }

  it('keeps one music epoch through every black frame, then pauses on the final music frame', async () => {
    const preview = await running(conclusion(), 8);
    const slot = slotFor(preview);
    expect(preview.engine.diagnostics().duration).toBe(18);
    expect(preview.compositor.visible![0]!.clips[0]!.brightness).toBe(0.5);
    slot.observe(9);
    tick(preview, 9);
    expect(preview.compositor.visible![0]!.clips[0]!.brightness).toBe(0);
    for (let frame = 10; frame < 18; frame++) {
      tick(preview, frame);
      expect(preview.engine.diagnostics()).toMatchObject({
        status: 'playing',
        frame,
        activeDecoders: 0,
        audioClock: true,
      });
      expectSurface(preview, frame);
      expect(preview.engine.capturePixels()).toEqual(new Uint8Array([0, 0, 0, 255]));
      expect(preview.music.running).toBe(true);
      expectUninterrupted(preview);
    }
    expect(slot.play).not.toHaveBeenCalled();
    expect(slot.pause).toHaveBeenCalledOnce();
    tick(preview, 18);
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, frame: 17, duration: 18 });
    expectSurface(preview, 17);
    expect(preview.music.running).toBe(false);
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(slot.seek).not.toHaveBeenCalled();
  });

  it('seeks and restarts within a black conclusion without asking for an ended video source', async () => {
    const preview = await paused(conclusion(), 8);
    await preview.engine.seek(14);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', frame: 14 });
    expectSurface(preview, 14);
    for (const slot of doubles.slots) {
      expect(slot.load).not.toHaveBeenCalled();
      expect(slot.seek).not.toHaveBeenCalled();
    }
    await preview.engine.play();
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 14, activeDecoders: 0 });
    expect(preview.music.start).toHaveBeenCalledExactlyOnceWith(14, expect.any(AbortSignal));
    expectSurface(preview, 14);
  });

  it('replaces footage with current black when the real output clock crosses video OUT during a draw', async () => {
    const preview = await running(conclusion(), 8);
    slotFor(preview).observe(9);
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      doubles.now = preview.anchor + framesToSeconds(10 - preview.initialFrame + 0.1) * 1000;
    });
    tick(preview, 9);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'playing',
      frame: 10,
      requestedFrame: 10,
      activeDecoders: 0,
    });
    expectSurface(preview, 10);
    expectUninterrupted(preview);
  });

  it('cancels only a withheld video catch-up at video OUT and ignores its late source without restarting music', async () => {
    const project = conclusion();
    project.clips[0]!.sourceOut = 14;
    const preview = await running(project, 8);
    const slot = slotFor(preview);
    const pending = holdNextSeek(slot);
    tick(preview, 11);
    tick(preview, 12, 0.25);
    await settle();
    expect(pending.request().frame).toBe(12);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true });
    const stalls = preview.engine.diagnostics().stalls;
    tick(preview, 14);
    await settle();
    expect(pending.request().signal.aborted).toBe(true);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 14, activeDecoders: 0, stalls });
    expectSurface(preview, 14);
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(preview.music.running).toBe(true);
    slot.observe(12);
    pending.release();
    await settle();
    expectSurface(preview, 14);
    expect(slot.play).not.toHaveBeenCalled();
    tick(preview, 17);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 17 });
    expectSurface(preview, 17);
    tick(preview, 18);
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', playing: false, frame: 17 });
  });

  it('does not treat an empty video composition as permission to ignore a real music failure', async () => {
    const preview = await running(conclusion(), 8);
    preview.music.sync.mockImplementationOnce(() => {
      throw new Error('Required music range failed');
    });
    tick(preview, 10);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'error',
      playing: false,
      message: 'Required music range failed',
    });
    expect(preview.music.pause).toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });
});

describe('PreviewEngine editor-only ungraded comparison', () => {
  it('starts graded and ignores mode requests without a loaded document', () => {
    const engine = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
    engines.push(engine);
    const listener = vi.fn();
    engine.subscribe(listener);
    const before = engine.diagnostics();
    vi.clearAllMocks();
    engine.setUngraded(true);
    engine.setUngraded(false);
    expect(engine.diagnostics()).toEqual(before);
    expect(engine.diagnostics().ungraded).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(doubles.compositors[0]!.drawFrame).not.toHaveBeenCalled();
    expect(doubles.compositors[0]!.clear).not.toHaveBeenCalled();
    expect(doubles.compositors[0]!.setDecoderCount).not.toHaveBeenCalled();
    expect(doubles.slots).toHaveLength(2);
    for (const slot of doubles.slots) {
      expect(slot.load).not.toHaveBeenCalled();
      expect(slot.seek).not.toHaveBeenCalled();
      expect(slot.pause).not.toHaveBeenCalled();
      expect(slot.play).not.toHaveBeenCalled();
      expect(slot.setRate).not.toHaveBeenCalled();
    }
    expect(doubles.music[0]!.configure).not.toHaveBeenCalled();
    expect(doubles.music[0]!.start).not.toHaveBeenCalled();
    expect(doubles.music[0]!.pause).not.toHaveBeenCalled();
  });

  it.each([false, true])('redraws the same paused textures without touching media (music=%s)', async (withMusic) => {
    const preview = await paused(gradedProject(withMusic), 13);
    const document = structuredClone(preview.project);
    const graded = structuredClone(preview.compositor.visible);
    const slots = [...doubles.slots];
    const before = preview.engine.diagnostics();
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();

    preview.engine.setUngraded(true);
    expectSurface(preview, 13, true);
    expect(preview.engine.diagnostics()).toEqual({
      ...before,
      ungraded: true,
      renderedFrames: before.renderedFrames + 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.lastCall![0]).toMatchObject({ ungraded: true, status: 'paused', frame: 13 });

    preview.engine.setUngraded(false);
    expect(preview.compositor.visible).toEqual(graded);
    expect(preview.engine.diagnostics()).toEqual({ ...before, renderedFrames: before.renderedFrames + 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall![0].ungraded).toBe(false);
    expect(preview.compositor.drawFrame).toHaveBeenCalledTimes(2);
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expect(preview.compositor.clear).not.toHaveBeenCalled();
    expect(doubles.slots).toEqual(slots);
    expect(preview.project).toEqual(document);
    expect(projectSchema.parse(preview.project)).toEqual(document);
    expectNoMediaOperations(preview);
  });

  it('preserves a non-widescreen source aspect and uses the current mode for pixel capture', async () => {
    const preview = await paused(gradedProject(true));
    slotFor(preview).aspect = 4 / 3;
    preview.engine.capturePixels();
    const graded = structuredClone(preview.compositor.visible)!;
    expect(graded[0]!.clips[0]!.aspect).toBe(4 / 3);
    vi.clearAllMocks();
    preview.engine.setUngraded(true);
    preview.engine.capturePixels();
    expect(preview.compositor.visible).toEqual(
      graded.map((group) => ({
        ...group,
        clips: group.clips.map((clip) => ({ ...clip, settings: NEUTRAL_COLOUR })),
      })),
    );
    preview.engine.setUngraded(false);
    preview.engine.capturePixels();
    expect(preview.compositor.visible).toEqual(graded);
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it.each([3, 25, 47])('neutralizes every evaluated source grade but not composition at frame %i', async (frame) => {
    const preview = await paused(gradedLayersProject(), frame);
    const document = structuredClone(preview.project);
    const graded = structuredClone(preview.compositor.visible)!;
    const before = preview.engine.diagnostics();
    expect(graded).toHaveLength(2);
    for (const clip of graded.flatMap((group) => group.clips)) expect(clip.settings).not.toEqual(NEUTRAL_COLOUR);
    expect(graded.flatMap((group) => group.clips).some((clip) => clip.brightness < 1)).toBe(true);
    expect(graded.flatMap((group) => group.clips).every((clip) => clip.opacity > 0 && clip.opacity < 1)).toBe(true);
    if (frame === 25) {
      expect(graded[0]!.clips).toHaveLength(2);
      expect(graded[0]!.clips.map((clip) => clip.blendWeight)).toEqual([0.5, 0.5]);
      expect(graded[0]!.clips.map((clip) => clip.sourceFrame)).toEqual([50, 102]);
      for (const clip of graded[0]!.clips) expect(clip.opacity).toBeCloseTo(0.45, 12);
      expect(graded[1]!.clips[0]!.settings).not.toEqual(preview.project.clips[2]!.colour);
    }

    preview.engine.setUngraded(true);
    expectSurface(preview, frame, true);
    expect(preview.compositor.visible).toEqual(
      graded.map((group) => ({
        ...group,
        clips: group.clips.map((clip) => ({ ...clip, settings: NEUTRAL_COLOUR })),
      })),
    );
    expect(preview.engine.diagnostics()).toMatchObject({
      ungraded: true,
      frame,
      duration: before.duration,
      requestedFrame: before.requestedFrame,
      decodedSourceFrames: before.decodedSourceFrames,
      assignedClipIds: before.assignedClipIds,
      decoderCount: 4,
    });
    preview.engine.setUngraded(false);
    expect(preview.compositor.visible).toEqual(graded);
    expect(preview.project).toEqual(document);
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it.each([17, 22])('preserves fade-through-black brightness while bypassing colour at frame %i', async (frame) => {
    const project = gradedProject();
    project.clips[0]!.sourceOut = 20;
    const right = createClip('right', 'other-video', 100, 120);
    right.start = 20;
    right.colour = { ...project.clips[0]!.colour, hue: -40 };
    project.clips.push(right);
    project.media.videoIds.push('other-video');
    project.layers[0]!.opacity = 0.7;
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'right', type: 'fade-through-black', duration: 10 }];
    const preview = await paused(project, frame);
    const graded = structuredClone(preview.compositor.visible)!;
    expect(graded[0]!.clips[0]!.brightness).toBe(0.5);
    preview.engine.setUngraded(true);
    expectSurface(preview, frame, true);
    expect(preview.compositor.visible![0]!.clips[0]!.brightness).toBe(0.5);
    expect(preview.compositor.visible![0]!.clips[0]!.opacity).toBe(0.7);
    preview.engine.setUngraded(false);
    expect(preview.compositor.visible).toEqual(graded);
    expectNoMediaOperations(preview);
  });

  it.each([true, false])('waits for exact paused readiness without seeking when ungraded=%s', async (enabled) => {
    const preview = await paused(gradedProject(true));
    if (!enabled) preview.engine.setUngraded(true);
    const slot = slotFor(preview);
    const before = preview.engine.diagnostics();
    Object.assign(slot.video, { readyState: 1 });
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();

    preview.engine.setUngraded(enabled);
    expect(preview.engine.diagnostics()).toMatchObject({ ungraded: enabled, status: 'paused', frame: 8 });
    expect(preview.engine.diagnostics().renderedFrames).toBe(before.renderedFrames);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.lastCall![0].ungraded).toBe(enabled);
    expect(preview.compositor.clear).toHaveBeenCalledOnce();
    expect(preview.compositor.visible).toBeNull();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);

    slot.observe(10); // A real callback for the wrong source is not paused readiness.
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.compositor.visible).toBeNull();
    slot.observe(8);
    expectSurface(preview, 8, enabled);
    expect(preview.compositor.drawFrame).toHaveBeenCalledOnce();
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(2);
    expectNoMediaOperations(preview);
  });

  it('requires all dissolve and layer sources before redrawing a paused bypass', async () => {
    const preview = await paused(gradedLayersProject(), 25);
    const right = slotFor(preview, 'right');
    const upper = slotFor(preview, 'upper-clip');
    Object.assign(right.video, { readyState: 1 });
    Object.assign(upper.video, { readyState: 1 });
    preview.engine.setUngraded(true);
    expect(preview.compositor.visible).toBeNull();
    right.observe(102);
    expect(preview.compositor.visible).toBeNull();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    upper.observe(sampleTimeline(preview.project, 25).find((layer) => layer.clipId === 'upper-clip')!.sourceFrame);
    expectSurface(preview, 25, true);
    expect(preview.compositor.drawFrame).toHaveBeenCalledOnce();
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it.each([false, true])('treats an unchanged loaded mode as a complete no-op (ungraded=%s)', async (enabled) => {
    const preview = await paused(gradedProject(true));
    preview.engine.setUngraded(enabled);
    const before = preview.engine.diagnostics();
    const surface = structuredClone(preview.compositor.visible);
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();
    preview.engine.setUngraded(enabled);
    preview.engine.setUngraded(enabled);
    expect(preview.engine.diagnostics()).toEqual(before);
    expect(preview.compositor.visible).toEqual(surface);
    expect(listener).not.toHaveBeenCalled();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expect(preview.compositor.clear).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it('resets on disposal, ignores disposed requests and leaves a fresh engine graded', async () => {
    const preview = await paused(gradedProject(true));
    preview.engine.setUngraded(true);
    preview.engine.dispose();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'disposed', playing: false, ungraded: false });
    const before = preview.engine.diagnostics();
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();
    preview.engine.setUngraded(true);
    preview.engine.setUngraded(false);
    expect(preview.engine.diagnostics()).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.compositor.clear).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
    const fresh = new PreviewEngine(new EventTarget() as HTMLCanvasElement);
    engines.push(fresh);
    expect(fresh.diagnostics()).toMatchObject({ status: 'empty', ungraded: false });
  });

  it('retains all static grade edits made during bypass and reveals them when disabled', async () => {
    const preview = await paused(gradedProject(true));
    const document = structuredClone(preview.project);
    preview.engine.setUngraded(true);
    vi.clearAllMocks();
    const edited = {
      exposure: -1.25,
      brightness: -0.2,
      contrast: 0.7,
      hue: -110,
      saturation: 1.6,
      highlights: 0.5,
      shadows: -0.4,
    };
    preview.engine.updateColour('clip', edited);
    expectSurface(preview, 8, true);
    expect(preview.engine.diagnostics().ungraded).toBe(true);
    expect(preview.project).toEqual(document);
    expect(edited.exposure).toBe(-1.25);
    preview.engine.setUngraded(false);
    expect(preview.compositor.visible![0]!.clips[0]!.settings).toEqual(edited);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', ungraded: false, frame: 8 });
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it('reveals the latest evaluated row and static grades after appearance edits during bypass', async () => {
    const preview = await paused(gradedLayersProject(), 25);
    const original = structuredClone(preview.project);
    preview.engine.setUngraded(true);
    const edited = structuredClone(preview.project);
    edited.clips[0]!.colour.hue = 90;
    edited.clips[1]!.colour.saturation = 0.2;
    edited.layers[0]!.keyframes[0]!.values.exposure = 2;
    edited.layers[0]!.keyframes[1]!.values.exposure = -2;
    edited.layers[1]!.keyframes[0]!.values.hue = 120;
    const submitted = structuredClone(edited);
    vi.clearAllMocks();
    preview.engine.updateProjectAppearance(edited);
    expectSurface(preview, 25, true);
    expect(preview.project).toEqual(original);
    expect(edited).toEqual(submitted);
    preview.project = submitted;
    preview.engine.setUngraded(false);
    expectSurface(preview, 25);
    expect(preview.compositor.visible![0]!.clips[0]!.settings).toMatchObject({ exposure: 0, hue: 90 });
    expect(preview.compositor.visible![0]!.clips[1]!.settings.saturation).toBe(0.2);
    expect(preview.compositor.visible![1]!.clips[0]!.settings).not.toEqual(NEUTRAL_COLOUR);
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it('preserves bypass through a same-project timing reload without persisting it', async () => {
    const preview = await paused(gradedProject(true));
    preview.engine.setUngraded(true);
    const reloaded = structuredClone(preview.project);
    reloaded.clips[0]!.speed = { mode: 'constant', rate: 2 };
    const submitted = structuredClone(reloaded);
    const modes: boolean[] = [];
    preview.engine.subscribe((state) => modes.push(state.ungraded));
    await preview.engine.loadProject(reloaded, proxyUrl, 12);
    preview.project = submitted;
    expect(preview.engine.diagnostics()).toMatchObject({ ungraded: true, status: 'paused', frame: 12, duration: 600 });
    expect(modes.length).toBeGreaterThan(1);
    expect(modes.every(Boolean)).toBe(true);
    expectSurface(preview, 12, true);
    expect(reloaded).toEqual(submitted);
    expect(projectSchema.parse(reloaded)).toEqual(submitted);
    preview.engine.setUngraded(false);
    expectSurface(preview, 12);
  });

  it.each([false, true])('resets mode for a new project ID (empty=%s)', async (empty) => {
    const preview = await paused(gradedProject(true));
    preview.engine.setUngraded(true);
    const next = empty ? createProject('next-project', 'Empty') : gradedProject(true);
    next.id = 'next-project';
    const submitted = structuredClone(next);
    await preview.engine.loadProject(next, proxyUrl, empty ? 0 : 8);
    preview.project = submitted;
    expect(preview.engine.diagnostics()).toMatchObject({ ungraded: false, status: empty ? 'empty' : 'paused' });
    if (empty) expect(preview.compositor.visible).toBeNull();
    else expectSurface(preview, 8);
    expect(next).toEqual(submitted);
    expect(projectSchema.parse(next)).toEqual(submitted);
  });

  it.each([
    { operation: 'load', enabled: true },
    { operation: 'load', enabled: false },
    { operation: 'seek', enabled: true },
    { operation: 'seek', enabled: false },
  ] as const)('uses the latest mode after busy $operation (ungraded=$enabled)', async ({ operation, enabled }) => {
    const preview = await paused(gradedProject(true));
    const slot = slotFor(preview);
    const pending = operation === 'load' ? holdNextLoad(slot) : holdNextSeek(slot);
    const completion =
      operation === 'load' ? preview.engine.loadProject(preview.project, proxyUrl, 12) : preview.engine.seek(12);
    await settle();
    expect(slot.load).toHaveBeenCalledOnce();
    const signal = operation === 'load' ? slot.load.mock.calls[0]![2] : slot.seek.mock.calls[0]![1];
    const before = preview.engine.diagnostics();
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();
    preview.engine.setUngraded(true);
    preview.engine.setUngraded(false);
    if (enabled) preview.engine.setUngraded(true);
    expect(signal.aborted).toBe(false);
    expect(preview.engine.diagnostics()).toMatchObject({
      ungraded: enabled,
      status: operation === 'load' ? 'loading' : 'seeking',
      frame: before.frame,
      requestedFrame: 12,
      renderedFrames: before.renderedFrames,
    });
    expect(listener).toHaveBeenCalledTimes(enabled ? 3 : 2);
    expect(listener.mock.lastCall![0].ungraded).toBe(enabled);
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.compositor.clear).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
    pending.release();
    await completion;
    await settle();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'paused', frame: 12, ungraded: enabled });
    expectSurface(preview, 12, enabled);
  });

  it.each([false, true])('ignores late successful loads after cancellation (ungraded=%s)', async (enabled) => {
    const preview = await paused(gradedProject(true));
    preview.engine.setUngraded(!enabled);
    const slot = slotFor(preview);
    const pending = holdNextLoad(slot, true);
    const obsolete = preview.engine.loadProject(preview.project, proxyUrl, 12);
    await settle();
    const signal = slot.load.mock.calls[0]![2];
    const next = gradedProject(true);
    next.id = 'next-project';
    next.clips[0]!.mediaId = 'next-video';
    next.clips[0]!.sourceIn = 20;
    next.clips[0]!.sourceOut = 80;
    next.media.videoIds = ['next-video'];
    const submitted = structuredClone(next);
    await preview.engine.loadProject(next, proxyUrl, 4);
    preview.project = submitted;
    expect(signal.aborted).toBe(true);
    expect(preview.engine.diagnostics().ungraded).toBe(false);
    preview.engine.setUngraded(enabled);
    const before = preview.engine.diagnostics();
    const listener = vi.fn();
    preview.engine.subscribe(listener);
    vi.clearAllMocks();
    pending.release();
    await obsolete;
    await settle();
    expect(preview.engine.diagnostics()).toEqual(before);
    expectSurface(preview, 4, enabled);
    expect(slot.decodedFrame).toBe(24);
    expect(next).toEqual(submitted);
    expect(listener).not.toHaveBeenCalled();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
  });

  it.each([false, true])('schedules modes without new clocks or music epochs (music=%s)', async (withMusic) => {
    const preview = await running(gradedProject(withMusic));
    const epoch = { clockFrame: preview.music.clockFrame, clockTime: preview.music.clockTime };
    const document = structuredClone(preview.project);
    for (const [enabled, frame] of [
      [true, 10],
      [false, 12],
    ] as const) {
      observeAt(preview, frame);
      doubles.now = preview.anchor + framesToSeconds(frame - preview.initialFrame + 0.1) * 1000;
      const before = preview.engine.diagnostics();
      const listener = vi.fn();
      const unsubscribe = preview.engine.subscribe(listener);
      vi.clearAllMocks();
      preview.engine.setUngraded(enabled);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.lastCall![0]).toMatchObject({ ungraded: enabled, playing: true });
      expect(preview.engine.diagnostics()).toMatchObject({
        ungraded: enabled,
        frame: before.frame,
        renderedFrames: before.renderedFrames,
      });
      expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
      expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
      expectNoMediaOperations(preview);
      tick(preview, frame);
      expectSurface(preview, frame, enabled);
      expect(preview.engine.diagnostics()).toMatchObject({
        status: 'playing',
        playing: true,
        frame,
        ungraded: enabled,
      });
      expect(preview.music).toMatchObject({ ...epoch, running: true });
      expect(preview.music.configure).not.toHaveBeenCalled();
      expect(preview.music.pause).not.toHaveBeenCalled();
      expect(preview.music.start).not.toHaveBeenCalled();
      for (const slot of doubles.slots) {
        expect(slot.load).not.toHaveBeenCalled();
        expect(slot.seek).not.toHaveBeenCalled();
        expect(slot.play).not.toHaveBeenCalled();
      }
      unsubscribe();
    }
    expect(preview.project).toEqual(document);
  });

  it.each(['clip', 'row'] as const)('preserves held-source neighbour mapping (%s speed)', async (mode) => {
    const project = gradedProject(true);
    project.clips[0]!.sourceOut = 6;
    project.layers[0]!.keyframes = [
      {
        frame: 0,
        interpolation: 'linear',
        values: { ...EMPTY_KEY_VALUES, exposure: -1, speed: mode === 'row' ? 0.1 : null },
      },
      {
        frame: 50,
        interpolation: 'hold',
        values: { ...EMPTY_KEY_VALUES, exposure: 1, speed: mode === 'row' ? 0.1 : null },
      },
    ];
    if (mode === 'clip') project.clips[0]!.speed = { mode: 'constant', rate: 0.1 };
    const map = calculateLayout(project).clips[0]!.retiming;
    expect([map.sourceAt(9), map.sourceAt(10), map.outputAt(0)]).toEqual([0, 1, 0]);
    const preview = await running(project);
    const document = structuredClone(preview.project);
    const slot = slotFor(preview);
    slot.observe(0);
    preview.engine.setUngraded(true);
    expectNoMediaOperations(preview);
    tick(preview, 10);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'playing',
      frame: 9,
      requestedFrame: 10,
      ungraded: true,
    });
    expectSurface(preview, 9, true);
    expect(preview.compositor.uploadVideo).not.toHaveBeenCalled();
    slot.observe(1);
    vi.clearAllMocks();
    preview.engine.setUngraded(false);
    expectNoMediaOperations(preview);
    tick(preview, 11);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'playing',
      frame: 11,
      requestedFrame: 11,
      ungraded: false,
    });
    expectSurface(preview, 11);
    expect(preview.project).toEqual(document);
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(slot.seek).not.toHaveBeenCalled();
  });

  it.each([true, false])('rejects stale retained appearance (ungraded=%s)', async (enabled) => {
    const preview = await running(gradedProject(true));
    if (!enabled) {
      preview.engine.setUngraded(true);
      tick(preview, 8);
    }
    Object.assign(slotFor(preview).video, { readyState: 1 });
    vi.clearAllMocks();
    preview.engine.setUngraded(enabled);
    expect(preview.compositor.visible).toBeNull();
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true, ungraded: enabled });
    expectNoMediaOperations(preview);
    tick(preview, 8, 0.5);
    expect(preview.compositor.visible).toBeNull();
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    slotFor(preview).observe(8);
    expectSurface(preview, 8, enabled);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 8, ungraded: enabled });
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    expect(slotFor(preview).seek).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps exact post-render A/V rejection (ungraded=%s)', async (enabled) => {
    const preview = await running(gradedProject(true), 42);
    if (!enabled) {
      preview.engine.setUngraded(true);
      tick(preview, 42);
    }
    const published: { frame: number; audioFrame: number }[] = [];
    preview.engine.subscribe((state) => {
      if (state.status === 'playing')
        published.push({
          frame: state.frame,
          audioFrame: preview.initialFrame + Math.floor(((doubles.now - preview.anchor) * 30_000) / 1_001_000 + 1e-7),
        });
    });
    published.length = 0;
    slotFor(preview).observe(47);
    vi.clearAllMocks();
    preview.engine.setUngraded(enabled);
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    const draw = preview.compositor.drawFrame.getMockImplementation()!;
    preview.compositor.drawFrame.mockImplementationOnce((groups) => {
      draw(groups);
      doubles.now = preview.anchor + framesToSeconds(49 - preview.initialFrame + 0.1) * 1000;
    });
    tick(preview, 47);
    expect(preview.engine.diagnostics()).toMatchObject({
      status: 'buffering',
      frame: 47,
      requestedFrame: 49,
      ungraded: enabled,
    });
    expect(preview.compositor.visible).toBeNull();
    expect(
      published.every(({ frame, audioFrame }) => Math.abs(frame - audioFrame) <= 1),
      JSON.stringify(published),
    ).toBe(true);
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
    slotFor(preview).observe(49);
    expectSurface(preview, 49, enabled);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: 49, ungraded: enabled });
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({ frame: 49, audioFrame: 49 });
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps the latest mode after video catch-up (ungraded=%s)', async (enabled) => {
    const { preview, slot, pending, recoveryFrame } = await pendingRecovery();
    const epoch = { clockFrame: preview.music.clockFrame, clockTime: preview.music.clockTime };
    const edited = structuredClone(preview.project);
    edited.clips[0]!.colour = { ...gradedProject().clips[0]!.colour };
    preview.engine.updateProjectAppearance(edited);
    preview.project = edited;
    vi.clearAllMocks();
    preview.engine.setUngraded(true);
    preview.engine.setUngraded(false);
    if (enabled) preview.engine.setUngraded(true);
    expect(pending.request().signal.aborted).toBe(false);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'buffering', playing: true, ungraded: enabled });
    expect(preview.compositor.drawFrame).not.toHaveBeenCalled();
    expectNoMediaOperations(preview);
    pending.release();
    await settle();
    expect(slot.decodedFrame).toBe(recoveryFrame);
    expectSurface(preview, recoveryFrame, enabled);
    expect(preview.engine.diagnostics()).toMatchObject({ status: 'playing', frame: recoveryFrame, ungraded: enabled });
    expect(preview.music).toMatchObject({ ...epoch, running: true });
    expect(preview.music.configure).not.toHaveBeenCalled();
    expect(preview.music.pause).not.toHaveBeenCalled();
    expect(preview.music.start).not.toHaveBeenCalled();
  });
});
