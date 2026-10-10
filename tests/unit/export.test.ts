import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../../src/server/config.js';
import { startExport, validateExport, validateExportAudio } from '../../src/server/export.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { retimeRawVideo } from '../../src/server/retime-process.js';
import { audioAssetSchema, musicGainAt } from '../../src/shared/audio.js';
import {
  EXPORT_PROFILES,
  exportAudioSample,
  exportRequestSchema,
  needsLayeredExport,
  planExport,
  planExportMusic,
  planLayeredExport,
} from '../../src/shared/export.js';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';
import { unsupportedProject } from './project-fixtures.js';

const temporary: string[] = [];
const queues: JobQueue[] = [];
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-export-unit-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function documentWithClips(count = 1): ProjectDocument {
  const document = createProject('export-unit', 'Export unit');
  document.clips = Array.from({ length: count }, (_, index) => createClip(`clip-${index}`, 'video', 7, 37));
  document.layers[0]!.transitions = document.clips.slice(1).map((clip, index) => ({
    type: 'cut' as const,
    leftId: document.clips[index]!.id,
    rightId: clip.id,
    duration: 0 as const,
  }));
  return projectSchema.parse(document);
}
const fingerprint = {
  algorithm: 'sampled-sha256-v1' as const,
  digest: 'a'.repeat(64),
  size: 10,
  mtimeMs: 0,
  device: 1,
  inode: 1,
};
function videoAsset(overrides: Partial<MediaAsset['metadata']> = {}): MediaAsset {
  return mediaAssetSchema.parse({
    id: 'video',
    name: 'original.mp4',
    sourcePath: '/unread-original.mp4',
    fingerprint,
    status: 'registered',
    error: null,
    prepared: null,
    metadata: {
      width: 320,
      height: 180,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      frameRate: { ...PROJECT_FPS },
      frameCount: 60,
      durationSeconds: framesToSeconds(60),
      colourPrimaries: 'bt709',
      colourTransfer: 'bt709',
      colourSpace: 'bt709',
      colourRange: 'tv',
      hasAudio: true,
      ...overrides,
    },
  });
}
function fakeLibrary(asset = videoAsset()): MediaLibrary {
  const jobs = new JobQueue();
  queues.push(jobs);
  const library = new MediaLibrary(createConfig({ dataDir: '/unused-export-unit-cache' }), jobs);
  vi.spyOn(library, 'get').mockReturnValue(asset);
  return library;
}
function audioAsset() {
  return audioAssetSchema.parse({
    id: 'music',
    name: 'sine.wav',
    sourcePath: '/unread-sine.wav',
    fingerprint,
    metadata: {
      codec: 'pcm_s16le',
      sampleRate: 48000,
      channels: 1,
      durationSeconds: framesToSeconds(60),
      frameCount: 60,
    },
    status: 'registered',
    error: null,
    waveform: [],
  });
}

describe('strict production export request and immutable validation', () => {
  it('offers exactly 720p and UHD profiles, accepts no-music v15 and rejects empty/legacy/unknown requests', () => {
    expect(EXPORT_PROFILES.draft720).toMatchObject({ width: 1280, height: 720 });
    expect(EXPORT_PROFILES.final4k).toMatchObject({ width: 3840, height: 2160 });
    const document = documentWithClips();
    expect(exportRequestSchema.parse({ document, profile: 'draft720' }).document.music).toEqual([]);
    expect(exportRequestSchema.parse({ document, profile: 'draft720' }).document.schemaVersion).toBe(15);
    for (const request of [
      { document: createProject('empty', 'Empty'), profile: 'draft720' },
      {
        document: {
          ...createProject('music-only', 'Music only'),
          music: [
            {
              id: 'audio-only',
              mediaId: 'music',
              sourceIn: 0,
              sourceOut: 30,
              start: 0,
              duration: 30,
              gainDb: 0,
              fadeIn: 0,
              fadeOut: 0,
              loop: false,
            },
          ],
        },
        profile: 'draft720',
      },
      { document, profile: 'reference' },
      { document, profile: 'draft720', normalize: true },
      { document: { ...document, schemaVersion: 1 }, profile: 'draft720' },
      { document: { ...document, schemaVersion: 2 }, profile: 'draft720' },
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11].map((version) => ({
        document: unsupportedProject(version, `old-export-v${version}`, 'Unsupported export'),
        profile: 'draft720',
      })),
      { document: { ...document, media: undefined }, profile: 'draft720' },
      { document: { ...document, clips: [{ ...document.clips[0], speed: undefined }] }, profile: 'draft720' },
      { document: { ...document, frameRate: { numerator: 30, denominator: 1 } }, profile: 'draft720' },
    ])
      expect(exportRequestSchema.safeParse(request).success).toBe(false);
  });
  it('accepts a trimmed output name and rejects empty, oversized, slashed or control-character names', () => {
    const document = documentWithClips();
    expect(exportRequestSchema.parse({ document, profile: 'draft720', outputName: '  My cut  ' }).outputName).toBe(
      'My cut',
    );
    for (const outputName of ['', '   ', 'a'.repeat(101), 'a/b', String.raw`a\b`, 'a\nb', 'a\u0000b'])
      expect(exportRequestSchema.safeParse({ document, profile: 'draft720', outputName }).success).toBe(false);
  });
  it('labels a queued export with its output name, or the project title and quality by default', async () => {
    const library = fakeLibrary();
    const document = documentWithClips();
    const defaults = startExport(document, 'final4k', library);
    const named = startExport(document, 'draft720', library, undefined, ' Holiday cut ');
    try {
      expect(defaults.label).toBe(`${document.title} · 4K`);
      expect(named.label).toBe('Holiday cut');
      expect(() => startExport(document, 'draft720', library, undefined, 'a/b')).toThrow();
    } finally {
      library.jobs.cancel(defaults.id);
      library.jobs.cancel(named.id);
      await library.jobs.close();
    }
  });
  it('validates original bounds, rate and SDR without requiring proxies or source-video audio', () => {
    const document = documentWithClips();
    expect(validateExport(document, fakeLibrary()).clips).toHaveLength(1);
    expect(() =>
      validateExport(document, fakeLibrary(videoAsset({ frameCount: 20, durationSeconds: framesToSeconds(20) }))),
    ).toThrow('source frame count');
    expect(() =>
      validateExport(document, fakeLibrary(videoAsset({ frameRate: { numerator: 24, denominator: 1 } }))),
    ).toThrow('project-rate');
    expect(() => validateExport(document, fakeLibrary(videoAsset({ pixelFormat: 'yuv420p10le' })))).toThrow(
      '8-bit BT.709 SDR',
    );
    expect(() => validateExport(document, fakeLibrary(videoAsset({ durationSeconds: 20 })))).toThrow('project-rate');
  });
  it('parses and deeply freezes an independent snapshot instead of retaining the editor document', () => {
    const document = documentWithClips();
    document.music = [
      {
        id: 'captured',
        mediaId: 'music',
        sourceIn: 6,
        sourceOut: 18,
        start: 3,
        duration: 24,
        gainDb: -6,
        fadeIn: 6,
        fadeOut: 6,
        loop: true,
      },
    ];
    document.music.push({ ...document.music[0]!, id: 'second', start: 50 });
    const snapshot = validateExport(document, fakeLibrary());
    document.title = 'Later edit';
    document.clips[0]!.sourceIn = 10;
    document.layers[0]!.colour.brightness = 0.2;
    document.music[0]!.gainDb = 12;
    document.music.splice(1, 1);
    expect(snapshot.title).toBe('Export unit');
    expect(snapshot.clips[0]!.sourceIn).toBe(7);
    expect(snapshot.layers[0]!.colour.brightness).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.clips[0]!.speed)).toBe(true);
    expect(Object.isFrozen(snapshot.layers[0]!.colour)).toBe(true);
    expect(snapshot.music).toHaveLength(2);
    expect(snapshot.music[0]!.gainDb).toBe(-6);
    expect(Object.isFrozen(snapshot.music)).toBe(true);
    expect(Object.isFrozen(snapshot.music[1])).toBe(true);
  });
  it('requires a resolver only for music and validates its identity and exact selected source bounds', () => {
    const document = documentWithClips();
    const music = {
      id: 'music-instance',
      mediaId: 'music',
      sourceIn: 6,
      sourceOut: 18,
      start: 3,
      duration: 24,
      gainDb: -6,
      fadeIn: 6,
      fadeOut: 6,
      loop: true,
    };
    document.music = [music];
    expect(() => startExport(document, 'draft720', fakeLibrary())).toThrow('resolver');
    expect(validateExportAudio(music, audioAsset()).metadata.sampleRate).toBe(48000);
    expect(() => validateExportAudio({ ...music, sourceOut: 61 }, audioAsset())).toThrow('source bounds');
    expect(() => validateExportAudio({ ...music, mediaId: 'other' }, audioAsset())).toThrow('identity');
    expect(() =>
      validateExportAudio(music, { ...audioAsset(), metadata: { ...audioAsset().metadata, durationSeconds: 0.2 } }),
    ).toThrow('source bounds');
  });
  it('submits export to the same queue and a cancelled queued export never touches existing outputs', async () => {
    const directory = await temp();
    const library = fakeLibrary();
    library.config.dataDir = directory;
    const old = path.join(directory, 'renders', 'older-success');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'export.mp4'), 'already successful');
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = library.jobs.submit('prepare', 'busy worker', async () => gate);
    try {
      const job = startExport(documentWithClips(), 'draft720', library);
      expect(job.kind).toBe('export');
      expect(job.state).toBe('queued');
      expect(job.id).toMatch(/^[\da-f-]{36}$/);
      library.jobs.cancel(job.id);
      release();
      await library.jobs.wait(first.id);
      expect((await library.jobs.wait(job.id)).state).toBe('cancelled');
      expect(await readdir(path.join(directory, 'renders'))).toEqual(['older-success']);
      expect(await readFile(path.join(old, 'export.mp4'), 'utf8')).toBe('already successful');
    } finally {
      release();
    }
  });
});

describe('sequential output-frame chunk planning', () => {
  it('uses layered black tails only when music OUT exceeds video OUT, retaining clip fades and full audio ranges', () => {
    const document = documentWithClips();
    document.layers[0]!.closingFade = 3;
    const music = {
      id: 'conclusion',
      mediaId: 'music',
      sourceIn: 6,
      sourceOut: 18,
      start: 6,
      duration: 24,
      gainDb: -6,
      fadeIn: 3,
      fadeOut: 6,
      loop: true,
    };
    document.music = [music];
    expect(needsLayeredExport(document)).toBe(false);
    expect(planExport(document).duration).toBe(30);
    document.music = [
      { ...music, start: 60 },
      { ...music, id: 'shorter', start: 20 },
    ];
    const captured = structuredClone(document);
    const layout = calculateLayout(document);
    expect(layout.duration).toBe(84);
    expect(needsLayeredExport(document)).toBe(true);
    expect(() => planExport(document)).toThrow('layered exporter');
    const plan = planLayeredExport(document);
    expect(plan.duration).toBe(84);
    expect(plan.chunks).toEqual([]);
    expect(plan.layers[0]!.plan).toMatchObject({ duration: 30, clips: [{ duration: 30, fadeOut: 3 }] });
    expect(plan.layers[0]!.plan.chunks).toEqual([
      { kind: 'body', clipIndex: 0, sourceIn: 0, sourceOut: 30, start: 0, duration: 30 },
    ]);
    expect(sampleTimeline(document, 29, layout)[0]!.brightness).toBe(0);
    expect(sampleTimeline(document, 30, layout)).toEqual([]);
    expect(sampleTimeline(document, 83, layout)).toEqual([]);
    const audio = document.music.map((track) => planExportMusic(track, plan.duration));
    for (const [index, track] of document.music.entries()) {
      expect(audio[index]!.activeSamples).toBe(exportAudioSample(track.duration));
      expect(audio[index]!.videoSamples).toBe(exportAudioSample(84));
      expect(audio[index]!.sourceInSamples).toBe(exportAudioSample(6));
      expect(audio[index]!.sourceOutSamples).toBe(exportAudioSample(18));
      expect(audio[index]!.fadeOutSamples).toBe(exportAudioSample(6));
      expect(musicGainAt(track, track.start + track.duration - 3)).toBe(audio[index]!.gain / 2);
    }
    expect(document).toEqual(captured);
  });
  it('covers many independently retimed instances exactly, excluding only dissolve heads/tails', () => {
    const document = documentWithClips(5);
    document.clips[0]!.speed = { mode: 'constant', rate: 0.5 };
    document.clips[1]!.speed = { mode: 'constant', rate: 2 };
    document.clips[2]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'smooth' },
        { frame: 60, rate: 2, interpolation: 'smooth' },
      ],
    };
    document.clips[3]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 2, interpolation: 'ease-in' },
        { frame: 60, rate: 0.5, interpolation: 'ease-in' },
      ],
    };
    document.layers[0]!.transitions[0] = { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 4 };
    document.layers[0]!.transitions[1] = {
      leftId: 'clip-1',
      rightId: 'clip-2',
      type: 'fade-through-black',
      duration: 5,
    };
    document.layers[0]!.transitions[3] = { leftId: 'clip-3', rightId: 'clip-4', type: 'cross-dissolve', duration: 3 };
    document.layers[0]!.openingFade = 3;
    document.layers[0]!.closingFade = 2;
    const plan = planExport(document);
    expect(plan.duration).toBe(calculateLayout(document).duration);
    expect(plan.clips[0]).toMatchObject({ duration: 60, bodyIn: 0, bodyOut: 56, fadeIn: 3 });
    expect(plan.clips[1]).toMatchObject({ duration: 15, bodyIn: 4, bodyOut: 15, fadeOut: 3 });
    expect(plan.clips[2]!.fadeIn).toBe(2);
    expect(plan.chunks.map((chunk) => chunk.kind)).toEqual([
      'body',
      'dissolve',
      'body',
      'body',
      'body',
      'dissolve',
      'body',
    ]);
    let cursor = 0;
    for (const chunk of plan.chunks) {
      expect(chunk.start).toBe(cursor);
      for (let frame = 0; frame < chunk.duration; frame++) {
        const layers = sampleTimeline(document, cursor + frame);
        if (chunk.kind === 'body') {
          expect(layers).toHaveLength(1);
          expect(layers[0]!.sourceFrame).toBe(
            compileRetiming(document.clips[chunk.clipIndex]!).sourceAt(chunk.sourceIn + frame),
          );
        } else {
          expect(layers).toHaveLength(2);
          expect(layers[0]!.sourceFrame).toBe(
            compileRetiming(document.clips[chunk.leftIndex]!).sourceAt(chunk.leftIn + frame),
          );
          expect(layers[1]!.sourceFrame).toBe(compileRetiming(document.clips[chunk.rightIndex]!).sourceAt(frame));
          expect(layers[1]!.weight).toBe(frame / chunk.duration);
        }
      }
      cursor += chunk.duration;
    }
    expect(cursor).toBe(plan.duration);
  });
  it('handles zero-length bodies and the one-output-frame dissolve', () => {
    const document = documentWithClips(3);
    for (const clip of document.clips) clip.sourceOut = clip.sourceIn + 2;
    document.layers[0]!.transitions = [
      { leftId: 'clip-0', rightId: 'clip-1', type: 'cross-dissolve', duration: 1 },
      { leftId: 'clip-1', rightId: 'clip-2', type: 'cross-dissolve', duration: 1 },
    ];
    const plan = planExport(document);
    expect(plan.clips[1]!.bodyIn).toBe(plan.clips[1]!.bodyOut);
    expect(plan.chunks.map((chunk) => chunk.kind)).toEqual(['body', 'dissolve', 'dissolve', 'body']);
    expect(plan.duration).toBe(4);
  });
  it('uses 48 kHz sample positions and the unnormalized shared linear music envelope', () => {
    const music = {
      id: 'music-instance',
      mediaId: 'music',
      sourceIn: 6,
      sourceOut: 12,
      start: 3,
      duration: 24,
      gainDb: -6,
      fadeIn: 6,
      fadeOut: 6,
      loop: true,
    };
    const plan = planExportMusic(music, 36);
    expect(plan).toMatchObject({ id: music.id, mediaId: music.mediaId, loop: true });
    expect(plan.sourceInSamples).toBe(9610);
    expect(plan.sourceOutSamples).toBe(19219);
    expect(plan.videoSamples).toBe(57658);
    expect(plan.gain).toBe(10 ** (-6 / 20));
    expect(musicGainAt(music, 6)).toBe(plan.gain / 2);
    expect(musicGainAt(music, 24)).toBe(plan.gain / 2);
    expect(planExportMusic({ ...music, start: 40 }, 36).activeSamples).toBe(0);
    expect(exportAudioSample(1)).toBe(1602);
    expect(() => exportAudioSample(-1)).toThrow('sample counts');
  });
});

const speeds: SpeedSettings[] = [
  { mode: 'constant', rate: 0.5 },
  { mode: 'constant', rate: 2.5 },
  ...(['linear', 'ease-in', 'ease-out', 'smooth'] as const).flatMap((interpolation) =>
    [
      [0.4, 3],
      [3, 0.4],
    ].map(([first, last]) => ({
      mode: 'curve' as const,
      keyframes: [
        { frame: 2, rate: first!, interpolation },
        { frame: 42, rate: last!, interpolation },
      ],
    })),
  ),
];
describe('bounded raw-stream discrete retimer (no FFmpeg needed)', () => {
  for (const speed of speeds)
    it(`repeats/drops exact absolute sourceAt frames for ${JSON.stringify(speed)}`, async () => {
      const directory = await temp();
      const clip = { ...createClip('raw', 'video', 7, 37), speed };
      const destination = path.join(directory, 'retimed.rgb');
      // Deliberately fragmented stdout: neither writes nor OS pipe chunks match frame boundaries.
      const decode =
        `const b=Buffer.alloc(30*6);for(let f=0;f<30;f++)b.fill(f+7,f*6,(f+1)*6);` +
        `let p=0;function next(){if(p===b.length)return;const n=Math.min(1+(p%11),b.length-p);const c=b.subarray(p,p+n);p+=n;process.stdout.write(c,next)}next();`;
      const encode = `const fs=require('node:fs');process.stdin.pipe(fs.createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`;
      const report = await retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: ['-e', decode],
        encodeArgs: ['-e', encode],
        clip,
        frameBytes: 6,
        signal: new AbortController().signal,
      });
      const actual = await readFile(destination);
      const map = compileRetiming(clip);
      expect(actual).toHaveLength(map.duration * 6);
      for (let frame = 0; frame < map.duration; frame++)
        expect([...actual.subarray(frame * 6, (frame + 1) * 6)]).toEqual(Array(6).fill(map.sourceAt(frame)));
      expect(report).toMatchObject({ decodedFrames: 30, outputFrames: map.duration, rawFrameBuffers: 1 });
      expect(report.largestReadChunkBytes).toBeLessThanOrEqual(180);
    });
  for (const speed of [
    { mode: 'constant' as const, rate: 0.5 },
    {
      mode: 'curve' as const,
      keyframes: [
        { frame: 19999, rate: 0.5, interpolation: 'smooth' as const },
        { frame: 20030, rate: 2, interpolation: 'smooth' as const },
      ],
    },
  ])
    it(`owns an immutable shared map even after a cached caller clip is mutated (${speed.mode})`, async () => {
      const directory = await temp();
      const clip = { ...createClip('snapshot', 'video', 20007, 20019), speed };
      const cached = compileRetiming(clip);
      const expected = Array.from({ length: cached.duration }, (_, frame) => cached.sourceAt(frame));
      const destination = path.join(directory, 'snapshot.rgb');
      const decode =
        'const b=Buffer.alloc(12*6);for(let f=0;f<12;f++)b.fill((20007+f)%256,f*6,(f+1)*6);process.stdout.write(b);';
      const encode = `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`;
      let mutated = false;
      await retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: ['-e', decode],
        encodeArgs: ['-e', encode],
        clip,
        frameBytes: 6,
        signal: new AbortController().signal,
        onProgress: () => {
          if (mutated) return;
          mutated = true;
          clip.sourceIn += 3;
          clip.sourceOut += 3;
        },
      });
      expect(mutated).toBe(true);
      const actual = await readFile(destination);
      expect(actual).toHaveLength(expected.length * 6);
      for (const [frame, source] of expected.entries())
        expect([...actual.subarray(frame * 6, (frame + 1) * 6)]).toEqual(Array(6).fill(source % 256));
    });
  it('rejects truncated raw frames and terminates the companion encoder', async () => {
    const directory = await temp();
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: ['-e', 'process.stdout.write(Buffer.alloc(11));'],
        encodeArgs: ['-e', 'process.stdin.resume();setInterval(()=>{},1000);'],
        clip: createClip('raw', 'video', 0, 2),
        frameBytes: 6,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('truncated raw frame');
  });
  it('reaps both children when an encoder errors while the original decoder is blocked', async () => {
    const directory = await temp();
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: ['-e', 'setInterval(()=>{},1000);'],
        encodeArgs: ['-e', 'process.stderr.write("intentional encoder failure");process.exit(23);'],
        clip: createClip('raw', 'video', 0, 2),
        frameBytes: 6,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('intentional encoder failure');
  });
  it('rejects an already-aborted operation without starting native children', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retimeRawVideo({
        ffmpeg: '/does-not-exist',
        cwd: await temp(),
        decodeArgs: [],
        encodeArgs: [],
        clip: createClip('raw', 'video', 0, 2),
        frameBytes: 6,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });
  it('cancels blocked children, including the SIGKILL fallback for ignored SIGTERM', async () => {
    const directory = await temp();
    const controller = new AbortController();
    let sawProgress = false;
    const started = Date.now();
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: [
          '-e',
          'process.on("SIGTERM",()=>{});process.stdout.write(Buffer.alloc(6));setInterval(()=>{},1000);',
        ],
        encodeArgs: ['-e', 'process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},1000);'],
        clip: createClip('raw', 'video', 0, 30),
        frameBytes: 6,
        signal: controller.signal,
        onProgress: () => {
          sawProgress = true;
          controller.abort();
        },
      }),
    ).rejects.toThrow('cancelled');
    expect(sawProgress).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
