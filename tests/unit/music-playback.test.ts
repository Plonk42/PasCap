import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicPlayback } from '../../src/preview/music.js';
import { musicSchema, type MusicTrack } from '../../src/shared/model.js';
import { MUSIC_BYTES_PER_SAMPLE, MUSIC_CHANNELS, MUSIC_CHUNK_SAMPLES, MUSIC_QUEUE_CHUNKS, MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME, type MusicChunk } from '../../src/shared/music-stream.js';
import type { SerialOperation } from '../../src/shared/serial.js';

const boundary = vi.hoisted(() => ({ prefill: null as (() => void) | null }));
vi.mock('../../src/shared/serial.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/serial.js')>();
  return {
    ...actual,
    async forEachSerial<T>(items: Iterable<T>, operation: SerialOperation<T>): Promise<void> {
      await actual.forEachSerial(items, operation);
      boundary.prefill?.();
    },
  };
});

class ContextDouble {
  currentTime = 10;
  state = 'running';
  getOutputTimestamp = vi.fn(() => ({ contextTime: this.currentTime, performanceTime: 1 }));
  readonly destination = {};
  readonly audioWorklet = { addModule: vi.fn(async () => { }) };
  resume = vi.fn(async () => { });
  close = vi.fn(async () => { });
  createBuffer = vi.fn(() => { throw new Error('Whole-file audio buffers are forbidden.'); });
  decodeAudioData = vi.fn(() => { throw new Error('Whole-file audio decoding is forbidden.'); });
  constructor(readonly options: AudioContextOptions) { contexts.push(this); }
}
interface Command { kind: string; generation: number; frame: number; chunks: MusicChunk[]; chunk: MusicChunk }
class WorkletDouble {
  readonly commands: Command[] = [];
  readonly port = {
    onmessage: null as ((message: MessageEvent) => void) | null,
    postMessage: vi.fn((command: Command) => {
      this.commands.push(command);
      if (command.kind === 'start' && !holdStart) this.emit({ kind: 'started', generation: command.generation, contextStart: this.context.currentTime * MUSIC_SAMPLE_RATE });
    }),
    close: vi.fn(),
  };
  connect = vi.fn(); disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  constructor(readonly context: ContextDouble, readonly name: string, readonly options: AudioWorkletNodeOptions) { nodes.push(this); }
  emit(data: object): void { this.port.onmessage?.({ data } as MessageEvent); }
  startCommand(): Command { return this.commands.filter(command => command.kind === 'start').at(-1)!; }
  receipt(samples: number, contextFrame: number): void {
    this.emit({ kind: 'rendered', generation: this.startCommand().generation, startFrame: this.startCommand().frame, samples, contextFrame });
  }
}
const contexts: ContextDouble[] = [];
const nodes: WorkletDouble[] = [];
let playback: MusicPlayback;
let holdStart = false;
const totalSamples = 480_000;
const requests: RequestInit[] = [];
const fetchPcm = vi.fn<typeof fetch>(async (_url, init) => {
  requests.push(init!);
  const common = { 'content-type': 'application/octet-stream' };
  if (init?.method === 'HEAD') return new Response(null, { headers: { ...common, 'content-length': String(totalSamples * MUSIC_BYTES_PER_SAMPLE) } });
  const range = new Headers(init?.headers).get('Range')!;
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
  const begin = Number(match[1]); const end = Number(match[2]);
  expect(end - begin + 1).toBeLessThanOrEqual(MUSIC_CHUNK_SAMPLES * MUSIC_BYTES_PER_SAMPLE);
  expect(begin % MUSIC_BYTES_PER_SAMPLE).toBe(0);
  const bytes = new Uint8Array(end - begin + 1); const data = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 4) { data.setInt16(offset, 8192, true); data.setInt16(offset + 2, -8192, true); }
  return new Response(bytes, { status: 206, headers: { ...common, 'content-length': String(bytes.length), 'content-range': `bytes ${begin}-${end}/${totalSamples * MUSIC_BYTES_PER_SAMPLE}` } });
});
function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return musicSchema.parse({ mediaId: 'song', sourceIn: 10, sourceOut: 130, start: 0, duration: 120, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false, ...overrides });
}
async function configured(music = track()): Promise<void> { await playback.configure(music, new AbortController().signal); }
async function started(frame = 20): Promise<WorkletDouble> { await playback.start(frame, new AbortController().signal); return nodes[0]!; }
function advance(samples: number, drift = 0): void {
  const node = nodes[0]!; const contextStart = 10 * MUSIC_SAMPLE_RATE;
  node.context.currentTime = (contextStart + samples) / MUSIC_SAMPLE_RATE;
  node.receipt(samples + drift, contextStart + samples);
}
beforeEach(() => {
  contexts.length = 0; nodes.length = 0; requests.length = 0; holdStart = false;
  boundary.prefill = null;
  fetchPcm.mockClear();
  vi.stubGlobal('location', { href: 'http://127.0.0.1:4318/' });
  vi.stubGlobal('AudioContext', ContextDouble); vi.stubGlobal('AudioWorkletNode', WorkletDouble); vi.stubGlobal('fetch', fetchPcm);
  vi.stubGlobal('requestAnimationFrame', vi.fn()); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  playback = new MusicPlayback();
});
afterEach(() => { playback.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('sample-owned bounded streaming music', () => {
  it('configures by read-only metadata and lazily allocates one 48 kHz context/worklet, without an audio element or whole-file decoding', async () => {
    await configured(); expect(requests).toHaveLength(1); expect(requests[0]!.method).toBe('HEAD'); expect(contexts).toHaveLength(0);
    const node = await started();
    expect(contexts).toHaveLength(1); expect(nodes).toHaveLength(1);
    expect(node.context.options).toEqual({ sampleRate: 48000 });
    expect(node.name).toBe('pascap-streaming-music'); expect(node.options.outputChannelCount).toEqual([2]);
    expect(node.startCommand().chunks).toHaveLength(MUSIC_QUEUE_CHUNKS);
    expect(node.startCommand().chunks.every(chunk => chunk.data.length === MUSIC_CHUNK_SAMPLES * MUSIC_CHANNELS)).toBe(true);
    expect(node.context.createBuffer).not.toHaveBeenCalled(); expect(node.context.decodeAudioData).not.toHaveBeenCalled();
    expect(playback.projectFrame()).toBe(20); expect(playback.sync()).toBe(true);
  });
  it.each([0, 1920, 4800])('preserves %s real samples rendered before startup acknowledgement', async delay => {
    await configured(); await playback.resumeContext(); holdStart = true;
    const pending = playback.start(20, new AbortController().signal);
    await vi.waitFor(() => expect(nodes[0]!.commands.some(command => command.kind === 'start')).toBe(true));
    const node = nodes[0]!; const command = node.startCommand();
    node.context.currentTime += delay / MUSIC_SAMPLE_RATE;
    node.emit({ kind: 'started', generation: command.generation, contextStart: 10 * MUSIC_SAMPLE_RATE });
    await pending; expect(playback.projectFrame()).toBe(20 + Math.floor(delay / MUSIC_SAMPLES_PER_FRAME));
    advance(delay + 3600); expect(playback.projectFrame()).toBe(20 + Math.floor((delay + 3600) / MUSIC_SAMPLES_PER_FRAME));
    expect(playback.errorFrames).toBeCloseTo(0); expect(playback.sync()).toBe(true);
  });
  it.each([-1.1, 1.1, -2, 2])('rejects genuine rendered-source drift of %s frames without reanchoring', async drift => {
    await configured(); await started(); advance(6400, drift * MUSIC_SAMPLES_PER_FRAME);
    expect(playback.projectFrame()).toBe(23); expect(playback.sync()).toBe(false);
    expect(playback.errorFrames).toBeCloseTo(Math.abs(drift));
    expect(nodes[0]!.commands.filter(command => command.kind === 'start')).toHaveLength(1);
  });
  it('does not add video quantisation to sub-frame rendered audio drift', async () => {
    await configured(); await started(); advance(Math.round(1.75 * MUSIC_SAMPLES_PER_FRAME), 0.5 * MUSIC_SAMPLES_PER_FRAME);
    expect(playback.projectFrame()).toBe(21); expect(playback.sync()).toBe(true); expect(playback.errorFrames).toBeCloseTo(0.5);
    advance(3000, 1.01 * MUSIC_SAMPLES_PER_FRAME); expect(playback.sync()).toBe(false);
  });
  it.each(['pause', 'dispose', 'abort'] as const)('invalidates a pending first-sample acknowledgement on %s', async action => {
    await configured(); await playback.resumeContext(); holdStart = true;
    const controller = new AbortController(); const pending = playback.start(20, controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(nodes[0]!.commands.some(command => command.kind === 'start')).toBe(true));
    const node = nodes[0]!; const command = node.startCommand();
    if (action === 'abort') controller.abort(); else playback[action]();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    node.emit({ kind: 'started', generation: command.generation, contextStart: 0 });
    expect(playback.projectFrame()).toBe(0); expect(playback.sync()).toBe(true);
    expect(node.commands.filter(item => item.kind === 'stop')).toHaveLength(1);
  });
  it('ignores old acknowledgements and receipts after a warm seek/restart', async () => {
    await configured(); const node = await started(); const previous = node.startCommand(); playback.pause();
    node.context.currentTime = 11; await started(40); const current = node.startCommand();
    node.emit({ kind: 'started', generation: previous.generation, contextStart: 0 });
    node.emit({ kind: 'rendered', generation: previous.generation, samples: 0, contextFrame: 99 });
    expect(playback.projectFrame()).toBe(40); expect(playback.sync()).toBe(true); expect(current.generation).not.toBe(previous.generation);
    expect(contexts).toHaveLength(1); expect(nodes).toHaveLength(1);
  });
  it('cannot submit a stale start when pause occurs at the completed-prefill continuation boundary', async () => {
    await configured();
    boundary.prefill = () => playback.pause();
    await expect(started()).rejects.toMatchObject({ name: 'AbortError' });
    expect(nodes[0]!.commands.filter(command => command.kind === 'start')).toHaveLength(0);
    expect(playback.sync()).toBe(true);
  });
  it('uses exactly released credits for serial bounded refill and exposes real underruns', async () => {
    await configured(); const node = await started(); const generation = node.startCommand().generation;
    const before = requests.length;
    node.emit({ kind: 'credit', generation, count: 1 });
    await vi.waitFor(() => expect(node.commands.filter(command => command.kind === 'chunk')).toHaveLength(1));
    expect(requests.length - before).toBe(1);
    node.emit({ kind: 'underrun', generation }); expect(playback.sync()).toBe(false);
    playback.pause(); expect(playback.sync()).toBe(true);
  });
  it('reads a short selected loop only once per bounded block, with a fresh guarded range on each refill', async () => {
    await configured(track({ sourceIn: 10, sourceOut: 11, loop: true }));
    const node = await started();
    const reads = requests.filter(request => request.method !== 'HEAD');
    expect(reads).toHaveLength(4);
    expect(reads.every(request => new Headers(request.headers).get('Range') === 'bytes=64064-70471')).toBe(true);
    node.emit({ kind: 'credit', generation: node.startCommand().generation, count: 1 });
    await vi.waitFor(() => expect(node.commands.filter(command => command.kind === 'chunk')).toHaveLength(1));
    expect(requests.filter(request => request.method !== 'HEAD')).toHaveLength(5);
  });
  it('cancels a pending shared worklet load without allowing its late completion to start audio', async () => {
    await configured(); const gate = new Promise<void>(() => { });
    const context = new ContextDouble({ sampleRate: MUSIC_SAMPLE_RATE });
    context.audioWorklet.addModule.mockReturnValue(gate);
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    const started = playback.start(20, new AbortController().signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(context.audioWorklet.addModule).toHaveBeenCalled());
    playback.pause(); expect(await started).toMatchObject({ name: 'AbortError' });
    expect(nodes).toHaveLength(0);
  });
  it('reports preparation/read errors and rejects an ignored Range response instead of decoding a whole file', async () => {
    await configured();
    fetchPcm.mockImplementationOnce(async () => new Response(new Uint8Array(400), { headers: { 'content-type': 'application/octet-stream', 'content-length': '400' } }));
    await expect(started()).rejects.toThrow('exact bounded PCM16 range');
    expect(nodes[0]!.commands.filter(command => command.kind === 'start')).toHaveLength(0);
    expect(playback.sync()).toBe(true);
  });
  it('reports a genuine processor exception after a good receipt instead of advancing silently', async () => {
    await configured(); const node = await started(); advance(128);
    node.onprocessorerror!();
    expect(() => playback.sync()).toThrow('audio processor failed');
    playback.pause(); await expect(started(40)).rejects.toThrow('audio processor failed');
    await playback.configure(null, new AbortController().signal);
    await expect(started(40)).resolves.toBe(node); expect(playback.hasMusic).toBe(false);
  });
  it('cancels the initial engine-facing context/module resume without waiting for a blocked shared load', async () => {
    await configured(); const context = new ContextDouble({ sampleRate: MUSIC_SAMPLE_RATE });
    context.audioWorklet.addModule.mockReturnValue(new Promise<void>(() => { }));
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    const controller = new AbortController();
    const resumed = playback.resumeContext(controller.signal).catch((error: unknown) => error);
    controller.abort(); expect(await resumed).toMatchObject({ name: 'AbortError' }); expect(nodes).toHaveLength(0);
  });
  it('rejects startup immediately with an actual worklet failure, not a delayed generic timeout', async () => {
    await configured(); await playback.resumeContext(); holdStart = true;
    const pending = playback.start(20, new AbortController().signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(nodes[0]!.commands.some(command => command.kind === 'start')).toBe(true));
    const node = nodes[0]!;
    node.emit({ kind: 'failed', generation: node.startCommand().generation, message: 'Malformed PCM block' });
    expect(await pending).toMatchObject({ message: 'Malformed PCM block' });
    expect(playback.sync()).toBe(true);
  });
  it.each(['suspended', 'closed'])('reports an unexpectedly %s context rather than accepting a stale receipt', async state => {
    await configured(); await started(); contexts[0]!.state = state;
    expect(() => playback.sync()).toThrow('stopped unexpectedly');
  });
  it('reports an invalid output timestamp while still allowing idempotent source cancellation and disposal', async () => {
    await configured(); const node = await started(); advance(6400); expect(playback.projectFrame()).toBe(23);
    node.context.getOutputTimestamp.mockReturnValue({ contextTime: NaN, performanceTime: 1 });
    expect(() => playback.projectFrame()).toThrow('invalid presentation clock');
    expect(() => playback.pause()).not.toThrow(); expect(playback.projectFrame()).toBe(23);
    playback.dispose(); playback.dispose();
    expect(node.port.close).toHaveBeenCalledOnce(); expect(node.context.close).toHaveBeenCalledOnce();
  });
  it('freezes the paused clock and releases the source/port/context', async () => {
    await configured(); const node = await started(); advance(4800); playback.pause();
    const frame = playback.projectFrame(); node.context.currentTime += 2; expect(playback.projectFrame()).toBe(frame);
    playback.dispose(); expect(playback.hasMusic).toBe(false); expect(node.port.close).toHaveBeenCalledOnce();
    expect(node.disconnect).toHaveBeenCalledOnce(); expect(node.context.close).toHaveBeenCalledOnce();
    await started(); expect(nodes).toHaveLength(1);
  });
});
