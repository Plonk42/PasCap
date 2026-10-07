import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../../src/server/config.js';
import { validateExport } from '../../src/server/export.js';
import { JobQueue } from '../../src/server/jobs.js';
import { ColourLutCache, sampleColourLut } from '../../src/server/layered-colour.js';
import { composeLayerFrame, fittedContent, type LayerFrameSource } from '../../src/server/layered-frame.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runRawVideoPass, writeRawFrame } from '../../src/server/raw-process.js';
import { renderReference, validateReference } from '../../src/server/reference.js';
import { retimeRawVideo } from '../../src/server/retime-process.js';
import { ProjectStore } from '../../src/server/storage.js';
import { COLOUR_CONTROLS, gradePixel, NEUTRAL_COLOUR, type ColourSettings, type RGB } from '../../src/shared/colour.js';
import { colourAt, compositePixel } from '../../src/shared/composition.js';
import {
  exportRequestSchema,
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  planExport,
  planLayeredExport,
} from '../../src/shared/export.js';
import {
  EMPTY_KEY_VALUES,
  evaluateLayerSetting,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import { mediaAssetSchema, type MediaAsset } from '../../src/shared/media.js';
import {
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type ProjectDocument,
  type VideoLayer,
} from '../../src/shared/model.js';
import { compileRetiming, type Retiming } from '../../src/shared/speed.js';
import { calculateLayout, type PreviewLayer } from '../../src/shared/timeline.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';
import { unsupportedProject } from './project-fixtures.js';

const temporary: string[] = [];
const queues: JobQueue[] = [];
async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-layered-unit-'));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function document(): ProjectDocument {
  const project = createProject('layered-unit', 'Layered unit');
  project.clips = [createClip('left', 'video', 7, 19)];
  return projectSchema.parse(project);
}
function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function layer(id = 'video-2'): VideoLayer {
  return createLayer(id, id, false);
}
function fakeLibrary(): MediaLibrary {
  const jobs = new JobQueue();
  queues.push(jobs);
  const library = new MediaLibrary(
    createConfig({ dataDir: '/unused-layered-unit', ffmpeg: '/never-run-unit-ffmpeg' }),
    jobs,
  );
  vi.spyOn(library, 'get').mockImplementation((id) =>
    mediaAssetSchema.parse({
      id,
      name: `${id}.mp4`,
      sourcePath: '/never-read-original.mp4',
      fingerprint: { algorithm: 'sampled-sha256-v1', digest: 'a'.repeat(64), size: 1, mtimeMs: 0, device: 1, inode: 1 },
      metadata: {
        width: 160,
        height: 90,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        frameRate: PROJECT_FPS,
        frameCount: 100,
        durationSeconds: framesToSeconds(100),
        colourRange: 'tv',
        colourSpace: 'bt709',
        colourPrimaries: 'bt709',
        colourTransfer: 'bt709',
        hasAudio: false,
      },
      status: 'registered',
      error: null,
      prepared: null,
    } satisfies MediaAsset),
  );
  return library;
}

describe('schema-8 production dispatch and read-only validation', () => {
  it('keeps static constant/ramp speed on the cheap path and dispatches shared speed points with their placed map', () => {
    const project = document();
    expect(needsLayeredExport(project)).toBe(false);
    expect(planExport(project).duration).toBe(compileRetiming(project.clips[0]!).duration);
    for (const speed of [
      { mode: 'constant' as const, rate: 2 },
      { mode: 'ramp' as const, startRate: 0.5, endRate: 2, anchorIn: 0, anchorOut: 40, curve: 'smooth' as const },
    ]) {
      project.clips[0]!.speed = speed;
      expect(needsLayeredExport(project)).toBe(false);
      expect(planExport(project).duration).toBe(compileRetiming(project.clips[0]!).duration);
    }
    project.clips[0]!.speed = { mode: 'constant', rate: 1 };
    project.layers[0]!.keyframes = [point(0, { speed: 0.5 }, 'smooth'), point(40, { speed: 2 }, 'hold')];
    expect(needsLayeredExport(project)).toBe(true);
    expect(() => planExport(project)).toThrow('layered exporter');
    const placed = calculateLayout(project).clips[0]!;
    expect(planLayeredExport(project).duration).toBe(
      compileLayerRetiming(project.clips[0]!, project.layers[0]!, placed.start).duration,
    );
    expect(placed.retiming.duration).toBe(planLayeredExport(project).duration);
    expect(exportRequestSchema.parse({ document: project, profile: 'draft720' }).document.schemaVersion).toBe(8);
    expect(
      exportRequestSchema.safeParse({ document: { ...project, schemaVersion: 2 }, profile: 'draft720' }).success,
    ).toBe(false);
    for (const version of [3, 4, 5, 6, 7])
      expect(
        exportRequestSchema.safeParse({
          document: unsupportedProject(version, 'old', 'Unsupported export'),
          profile: 'draft720',
        }).success,
      ).toBe(false);
  });
  it('dispatches and explicitly rejects static planning for every non-neutral layered/animated case', () => {
    const variants: ((project: ProjectDocument) => void)[] = [
      (project) => {
        project.layers.push(layer());
      },
      (project) => {
        project.layers[0]!.enabled = false;
      },
      (project) => {
        project.layers[0]!.opacity = 0.4;
      },
      (project) => {
        project.layers[0]!.opacity = 0;
      },
      (project) => {
        project.layers[0]!.keyframes = [point(7, { opacity: 1 }, 'hold')];
      },
      (project) => {
        project.layers[0]!.keyframes = [point(7, { ...NEUTRAL_COLOUR })];
      },
      ...COLOUR_CONTROLS.map(({ key }) => (project: ProjectDocument) => {
        project.layers[0]!.keyframes = [point(7, { [key]: NEUTRAL_COLOUR[key] })];
      }),
    ];
    for (const change of variants) {
      const project = document();
      change(project);
      expect(needsLayeredExport(project)).toBe(true);
      expect(() => planExport(project)).toThrow('layered exporter');
      expect(planLayeredExport(project).kind).toBe('layered');
    }
  });
  it('requires explicit v8 media/row/static clip fields, permits eight rows and refuses a ninth or same-row overlap', () => {
    const project = document();
    for (let index = 2; index <= 8; index++) project.layers.push(layer(`video-${index}`));
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, media: undefined }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, layers: [...project.layers, layer('video-9')] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, layers: undefined }).success).toBe(false);
    const { keyframes: _keyframes, ...incompleteLayer } = project.layers[0]!;
    expect(projectSchema.safeParse({ ...project, layers: [incompleteLayer, ...project.layers.slice(1)] }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...project, clips: [{ ...project.clips[0], colour: undefined }] }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...project, clips: [{ ...project.clips[0], opacity: 1 }] }).success).toBe(false);
    expect(
      projectSchema.safeParse({ ...project, layers: [{ ...project.layers[0], opacity: undefined }] }).success,
    ).toBe(false);
    expect(projectSchema.safeParse({ ...project, clips: [{ ...project.clips[0], speed: undefined }] }).success).toBe(
      false,
    );
    expect(
      projectSchema.safeParse({ ...project, clips: [{ ...project.clips[0], animation: { opacity: [], colour: [] } }] })
        .success,
    ).toBe(false);
    project.clips.push(
      { ...createClip('first-overlay', 'video', 0, 3), layerId: 'video-2', start: 1 },
      { ...createClip('overlap', 'video', 3, 6), layerId: 'video-2', start: 2 },
    );
    project.layers[1]!.transitions = [{ leftId: 'first-overlay', rightId: 'overlap', type: 'cut', duration: 0 }];
    expect(() => planLayeredExport(project)).toThrow('same track cannot overlap');
  });
  it('plans each track by its own order, not the flat array, and retains hidden end holds', () => {
    const project = document();
    project.layers.push(layer(), { ...layer('video-3'), enabled: false });
    project.clips = [
      { ...createClip('overlay-late', 'video', 0, 2), layerId: 'video-2', start: 11 },
      createClip('left', 'video', 0, 6),
      { ...createClip('overlay-early', 'video', 4, 7), layerId: 'video-2', start: 3 },
      createClip('right', 'video', 7, 13),
      { ...createClip('hidden', 'hidden-source', 0, 2), layerId: 'video-3', start: 18 },
    ];
    project.layers[0]!.transitions = [{ type: 'cross-dissolve', leftId: 'left', rightId: 'right', duration: 2 }];
    project.layers[1]!.transitions = [{ type: 'cut', leftId: 'overlay-early', rightId: 'overlay-late', duration: 0 }];
    project.layers[0]!.keyframes = [point(3, { opacity: 0.65, exposure: 0.4 }, 'hold')];
    const plan = planLayeredExport(project);
    expect(plan.duration).toBe(20);
    expect(plan.layers[0]!.plan.duration).toBe(10);
    expect(plan.chunks).toEqual([]);
    expect(plan.layers[0]!.plan.chunks).toEqual([
      { kind: 'body', clipIndex: 1, sourceIn: 0, sourceOut: 4, duration: 4, start: 0 },
      { kind: 'dissolve', leftIndex: 1, rightIndex: 3, leftIn: 4, duration: 2, start: 4 },
      { kind: 'body', clipIndex: 3, sourceIn: 2, sourceOut: 6, duration: 4, start: 6 },
    ]);
    expect(plan.layers[1]!.clips.map((clip) => [clip.clipId, clip.index, clip.start])).toEqual([
      ['overlay-early', 2, 3],
      ['overlay-late', 0, 11],
    ]);
    const library = fakeLibrary();
    const snapshot = validateExport(project, library);
    expect(library.get).toHaveBeenCalledWith('hidden-source');
    expect(snapshot.clips).toHaveLength(5);
    project.layers[0]!.opacity = 0;
    project.layers[0]!.keyframes[0]!.values.exposure = -1;
    expect(snapshot.clips[0]).not.toHaveProperty('opacity');
    expect(snapshot.layers[0]!.opacity).toBe(1);
    expect(snapshot.layers[0]!.keyframes[0]!.values.exposure).toBe(0.4);
    expect(Object.isFrozen(snapshot.layers[0]!.keyframes)).toBe(true);
    expect(Object.isFrozen(snapshot.layers[0]!.keyframes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.layers[0]!.keyframes[0]!.values)).toBe(true);
    expect(Object.isFrozen(snapshot.clips[0]!.colour)).toBe(true);
  });
  it('strictly loads v8 but lists/rejects unsupported versions unchanged, including overwrite attempts', async () => {
    const directory = await temp();
    const store = new ProjectStore(directory);
    const saved = await store.save(document(), 0);
    expect(await store.load(saved.id)).toEqual(saved);
    for (const version of [2, 3, 4, 5, 6, 7]) {
      const id = `old-v${version}`;
      const title = `Original v${version} document`;
      const unsupported = unsupportedProject(version, id, title);
      const bytes = `${JSON.stringify(unsupported, null, 2)}\n`;
      const filename = path.join(directory, 'projects', `${id}.json`);
      await writeFile(filename, bytes);
      expect(projectSchema.safeParse(unsupported).success).toBe(false);
      expect((await store.list()).find((summary) => summary.id === id)).toMatchObject({
        compatible: false,
        title,
        error: expect.stringContaining(`schema version ${version}`),
      });
      await expect(store.load(id)).rejects.toThrow('requires version 8');
      await expect(store.rename(id, 'No migration', 0)).rejects.toThrow('existing file was not changed');
      await expect(store.save(createProject(id, 'No migration'), 0)).rejects.toThrow('existing file was not changed');
      expect(await readFile(filename, 'utf8')).toBe(bytes);
    }
  });
  it.each(['cut', 'cross-dissolve'] as const)(
    'accepts an arbitrary-ID positioned %s reference but rejects leading/internal gaps before native work',
    async (type) => {
      const plain = document();
      const trackId = 'arbitrary-track';
      plain.layers = [createLayer(trackId, 'Arbitrary', false)];
      plain.clips = [
        createClip('left', 'video', 7, 19, trackId),
        { ...createClip('right', 'video', 20, 32, trackId), start: type === 'cut' ? 12 : 10 },
      ];
      plain.layers[0]!.transitions = [
        type === 'cut'
          ? { leftId: 'left', rightId: 'right', type, duration: 0 }
          : { leftId: 'left', rightId: 'right', type, duration: 2 },
      ];
      const library = fakeLibrary();
      expect(validateReference(plain, library)).toEqual(plain);
      const leading = structuredClone(plain);
      leading.clips.forEach((clip) => {
        clip.start += 5;
      });
      const gap = structuredClone(plain);
      gap.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cut', duration: 0 }];
      gap.clips[1]!.start = 20;
      for (const invalid of [leading, gap]) {
        const before = structuredClone(invalid);
        vi.mocked(library.get).mockClear();
        expect(() => validateReference(invalid, library)).toThrow('zero-origin contiguous');
        await expect(
          renderReference(invalid, library, { id: 'unused', signal: new AbortController().signal, update: () => {} }),
        ).rejects.toThrow('zero-origin contiguous');
        expect(library.get).not.toHaveBeenCalled();
        expect(library.jobs.list()).toEqual([]);
        expect(invalid).toEqual(before);
      }
    },
  );

  it('rejects layered/animated/speed-key diagnostic references, even on direct render calls', async () => {
    const plain = document();
    plain.clips.push(createClip('right', 'video', 20, 32));
    plain.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cut', duration: 0 }];
    const library = fakeLibrary();
    expect(validateReference(plain, library).clips).toHaveLength(2);
    for (const change of [
      (project: ProjectDocument) => {
        project.layers.push(layer());
      },
      (project: ProjectDocument) => {
        project.layers[0]!.opacity = 0.5;
      },
      (project: ProjectDocument) => {
        project.layers[0]!.keyframes.push(point(2, { opacity: 0 }, 'hold'));
      },
      (project: ProjectDocument) => {
        project.layers[0]!.keyframes.push(point(7, { ...NEUTRAL_COLOUR }));
      },
      (project: ProjectDocument) => {
        project.layers[0]!.keyframes.push(point(7, { opacity: 0.5 }, 'smooth'));
      },
      (project: ProjectDocument) => {
        project.layers[0]!.keyframes.push(point(7, { speed: 1 }, 'hold'));
      },
    ]) {
      const project = structuredClone(plain);
      change(project);
      expect(() => validateReference(project, library)).toThrow(/diagnostic reference/i);
      await expect(
        renderReference(project, library, { id: 'unused', signal: new AbortController().signal, update: () => {} }),
      ).rejects.toThrow(/diagnostic reference/i);
    }
  });
});

describe('bounded project-frame row speed and native pipe ownership without FFmpeg', () => {
  it('rejects supplied partial continuous-query maps and bad endpoints before starting children', async () => {
    const directory = await temp();
    const clip = createClip('invalid-map', 'video', 7, 19);
    const baseline = compileRetiming(clip);
    const { sourcePositionAt: omitted, ...partial } = baseline;
    expect(typeof omitted).toBe('function');
    const request = {
      ffmpeg: '/must-not-start-invalid-retiming',
      cwd: directory,
      clip,
      decodeArgs: [],
      encodeArgs: [],
      frameBytes: 6,
      signal: new AbortController().signal,
    };
    for (const sourcePositionAt of [undefined, null, 7]) {
      await expect(
        retimeRawVideo({
          ...request,
          retiming: { ...baseline, sourcePositionAt } as unknown as Retiming,
        }),
      ).rejects.toThrow('sourceAt, sourcePositionAt, outputAt and rateAt');
    }
    await expect(retimeRawVideo({ ...request, retiming: partial as Retiming })).rejects.toThrow('sourcePositionAt');
    for (const invalid of [NaN, Infinity, -Infinity, 6, 20]) {
      await expect(
        retimeRawVideo({
          ...request,
          retiming: { ...baseline, sourcePositionAt: () => invalid },
        }),
      ).rejects.toThrow('selected source endpoints');
    }
    await expect(
      retimeRawVideo({
        ...request,
        retiming: { ...baseline, sourcePositionAt: (output) => (output === 0 ? 7 : 18) },
      }),
    ).rejects.toThrow('selected source endpoints');
    await expect(
      retimeRawVideo({
        ...request,
        retiming: {
          ...baseline,
          sourcePositionAt: () => {
            throw new Error('continuous query failed');
          },
        },
      }),
    ).rejects.toThrow('continuous query failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    [7, 9.5, 8.5, 10],
    [7, 6.5, 8, 9],
    [7, 19.5, 19.5, 19.5],
    [7, NaN, 8, 9],
    [7, Infinity, 8, 9],
    [7, -Infinity, 8, 9],
  ])('rejects invalid continuous positions %# despite a valid discrete decoder map', async (...positions) => {
    const directory = await temp();
    const clip = createClip('invalid-continuous', 'video', 7, 19);
    const map: Retiming = {
      duration: 4,
      sourceAt: (output) => 7 + output,
      sourcePositionAt: (output) => (output >= 4 ? 19 : positions[output]!),
      outputAt: () => 0,
      rateAt: () => 1,
    };
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        clip,
        retiming: map,
        decodeArgs: ['-e', 'process.stdout.write(Buffer.alloc(12*6));'],
        encodeArgs: ['-e', 'process.stdin.resume();'],
        frameBytes: 6,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('finite, monotonic, in-range continuous source-position map');
  });

  it('rejects a throwing interior continuous query through the native ownership path', async () => {
    const directory = await temp();
    const clip = createClip('throwing-continuous', 'video', 7, 19);
    const baseline = compileRetiming(clip);
    await expect(
      retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        clip,
        retiming: {
          ...baseline,
          sourcePositionAt: (output) => {
            if (output === 1) throw new Error('interior continuous query failed');
            return baseline.sourcePositionAt(output);
          },
        },
        decodeArgs: ['-e', 'process.stdout.write(Buffer.alloc(12*6));'],
        encodeArgs: ['-e', 'process.stdin.resume();'],
        frameBytes: 6,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('interior continuous query failed');
  });

  it('binds the original continuous query and keeps only bounded per-output validation', async () => {
    const directory = await temp();
    const clip = createClip('bound-continuous', 'video', 7, 19);
    const queried: number[] = [];
    const map = {
      duration: 4,
      sourceIn: 7,
      sourceAt: (output: number) => 7 + output,
      sourcePositionAt(output: number): number {
        queried.push(output);
        return output >= this.duration ? 19 : this.sourceIn + output / 2;
      },
      outputAt: () => 0,
      rateAt: () => 1,
    };
    const report = await retimeRawVideo({
      ffmpeg: process.execPath,
      cwd: directory,
      clip,
      retiming: map,
      decodeArgs: ['-e', 'process.stdout.write(Buffer.alloc(12*6));'],
      encodeArgs: ['-e', 'process.stdin.resume();'],
      frameBytes: 6,
      signal: new AbortController().signal,
      onProgress: () => {
        map.sourcePositionAt = () => {
          throw new Error('replacement must not be called');
        };
      },
    });
    expect(queried).toEqual([0, 4, 0, 1, 2, 3]);
    expect(report).toMatchObject({ decodedFrames: 12, outputFrames: 4, rawFrameBuffers: 1 });
  });

  for (const interpolation of ['hold', 'linear', 'ease-in', 'ease-out', 'smooth'] as const) {
    it(`uses the exact shared compound speed-key map (${interpolation}) and owns the captured keys`, async () => {
      const directory = await temp();
      const clip = createClip('keyed', 'video', 7, 19);
      const rateLayer = layer();
      clip.layerId = rateLayer.id;
      clip.start = 9;
      rateLayer.keyframes = [
        point(2, { speed: 0.35 }, interpolation),
        point(11, { speed: 3 }, 'ease-out'),
        point(14, { exposure: 0.5, opacity: 0.3 }, 'hold'),
        point(16, { speed: 0.7 }, 'smooth'),
        point(25, { speed: 2 }, 'hold'),
      ];
      const map = compileLayerRetiming(clip, rateLayer, clip.start);
      const startingRate = evaluateLayerSetting(rateLayer, 'speed', 9, 1);
      expect(map.rateAt(0)).toBeCloseTo(startingRate);
      const expected = Array.from({ length: map.duration }, (_, output) => map.sourceAt(output));
      const destination = path.join(directory, 'mapped.rgb');
      const decode =
        'const b=Buffer.alloc(12*6);for(let f=0;f<12;f++)b.fill(f+7,f*6,(f+1)*6);let p=0;function next(){if(p===b.length)return;const n=Math.min(5,b.length-p);const c=b.subarray(p,p+n);p+=n;process.stdout.write(c,next)}next();';
      const encode = `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`;
      const frameBuffer = Buffer.alloc(6);
      let mutated = false;
      const report = await retimeRawVideo({
        ffmpeg: process.execPath,
        cwd: directory,
        decodeArgs: ['-e', decode],
        encodeArgs: ['-e', encode],
        clip,
        retiming: map,
        frameBytes: 6,
        frameBuffer,
        signal: new AbortController().signal,
        onProgress: () => {
          if (mutated) return;
          mutated = true;
          rateLayer.keyframes[0]!.values.speed = 8;
          rateLayer.keyframes.at(-1)!.frame = 125;
          clip.sourceIn = 8;
          clip.start = 500;
        },
      });
      const actual = await readFile(destination);
      expect(actual).toHaveLength(expected.length * 6);
      for (const [output, source] of expected.entries())
        expect([...actual.subarray(output * 6, output * 6 + 6)]).toEqual(Array(6).fill(source));
      expect(report).toMatchObject({
        decodedFrames: 12,
        outputFrames: expected.length,
        frameBytes: 6,
        rawFrameBuffers: 1,
      });
      expect(
        expected.every(
          (source, index) => source >= 7 && source < 19 && (index === 0 || source >= expected[index - 1]!),
        ),
      ).toBe(true);
      expect(mutated).toBe(true);
      expect(map.rateAt(0)).toBeCloseTo(startingRate);
      expect(Array.from({ length: map.duration }, (_, output) => map.sourceAt(output))).toEqual(expected);
    });
  }
  it('streams two readers into one encoder with measured bounded resources', async () => {
    const directory = await temp();
    const destination = path.join(directory, 'sum.rgb');
    const report = await runRawVideoPass(
      { ffmpeg: process.execPath, cwd: directory, signal: new AbortController().signal },
      async (pass) => {
        const left = pass.reader(['-e', 'process.stdout.write(Buffer.from([1,2,3,4,5,6]));'], 'left');
        const right = pass.reader(['-e', 'process.stdout.write(Buffer.from([6,5,4,3,2,1]));'], 'right');
        const encoder = pass.encoder(
          [
            '-e',
            `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(destination)},{flags:'wx'}));`,
          ],
          'encoder',
        );
        const a = Buffer.alloc(3);
        const b = Buffer.alloc(3);
        for (let frame = 0; frame < 2; frame++) {
          await left.requireFrame(a);
          await right.requireFrame(b);
          for (let index = 0; index < 3; index++) a[index] = a[index]! + b[index]!;
          await writeRawFrame(encoder, a);
        }
        encoder.end();
        await left.requireEnd(a);
        await right.requireEnd(b);
      },
    );
    expect(await readFile(destination)).toEqual(Buffer.alloc(6, 7));
    expect(report).toMatchObject({
      peakReaders: 2,
      peakEncoders: 1,
      peakChildren: 3,
      readerProcesses: 2,
      encoderProcesses: 1,
    });
  });
  it('enforces the reader bound and reaps blocked native companions', async () => {
    await expect(
      runRawVideoPass(
        { ffmpeg: process.execPath, cwd: await temp(), signal: new AbortController().signal },
        async (pass) => {
          pass.reader(['-e', 'setInterval(()=>{},1000);'], 'one');
          pass.reader(['-e', 'setInterval(()=>{},1000);'], 'two');
          pass.encoder(['-e', 'process.stdin.resume();setInterval(()=>{},1000);'], 'encoder');
          pass.reader(['-e', 'setInterval(()=>{},1000);'], 'forbidden third');
        },
      ),
    ).rejects.toThrow('two-reader / one-encoder bound');
  });
});

const strong: ColourSettings = {
  exposure: 1.2,
  brightness: -0.09,
  contrast: 1.4,
  saturation: 1.6,
  hue: 83,
  shadows: 0.7,
  highlights: -0.8,
};
const warm: ColourSettings = {
  exposure: -0.6,
  brightness: 0.11,
  contrast: 0.72,
  saturation: 0.65,
  hue: -47,
  shadows: -0.3,
  highlights: 0.5,
};
describe('bounded CPU-reference animated LUTs and premultiplied groups', () => {
  it('approximates the CPU grade numerically, caches settings in only two reusable arrays and writes no LUT files', async () => {
    const cache = new ColourLutCache();
    const signal = new AbortController().signal;
    const triple = new Float64Array(3);
    let maximumMae = 0;
    let first: Float32Array | null = null;
    for (const settings of [{ ...NEUTRAL_COLOUR }, strong, warm, strong]) {
      const lut = await cache.get(settings, signal);
      if (!first) first = lut;
      let error = 0;
      for (let index = 0; index < 4096; index++) {
        const red = (index * 73) % 256;
        const green = (index * 157) % 256;
        const blue = Math.floor(index / 256) * 17;
        sampleColourLut(lut, red, green, blue, triple);
        const exact = gradePixel([red / 255, green / 255, blue / 255], settings);
        for (let channel = 0; channel < 3; channel++) error += Math.abs(triple[channel]! - exact[channel]!) * 255;
      }
      const mae = error / (4096 * 3);
      maximumMae = Math.max(maximumMae, mae);
      expect(mae).toBeLessThan(4);
      if (settings === warm) expect(lut).toBe(first);
    }
    expect(cache.report).toMatchObject({ peakEntries: 2, bytes: LAYERED_EXPORT_RESOURCES.lutBytes * 2, generated: 3 });
    console.log(`Layered Float32 tetrahedral 65³ LUT maximum mean error: ${maximumMae.toFixed(4)} / 255`);
  });
  it('evaluates interpolated colour PARAMETERS at the absolute project frame, not original source time or endpoint RGB grades', async () => {
    const clip = createClip('animated', 'video', 200, 210);
    const row = layer();
    clip.layerId = row.id;
    clip.start = 20;
    row.keyframes = [point(10, { exposure: -2 }), point(40, { exposure: 2 }, 'hold')];
    expect(compileLayerRetiming(clip, row, clip.start).sourceAt(5)).toBe(205);
    const settings = colourAt(clip, row, 25);
    expect(settings.exposure).toBe(0);
    const cache = new ColourLutCache();
    const lut = await cache.get(settings, new AbortController().signal);
    const actual = new Float64Array(3);
    sampleColourLut(lut, 100, 130, 160, actual);
    const source: RGB = [100 / 255, 130 / 255, 160 / 255];
    const correct = gradePixel(source, settings);
    const left = gradePixel(source, colourAt(clip, row, 10));
    const right = gradePixel(source, colourAt(clip, row, 40));
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(actual[channel]! - correct[channel]!)).toBeLessThan(1 / 255);
    expect(Math.abs(correct[0] - (left[0] + right[0]) / 2)).toBeGreaterThan(4 / 255);
  });
  it('applies the sole row opacity through a dissolve over a lower group, matching compositePixel', async () => {
    const target = { width: 8, height: 4 };
    const pixels = target.width * target.height;
    const buffer = Buffer.alloc(pixels * 8);
    const cache = new ColourLutCache();
    const signal = new AbortController().signal;
    const bounds = { x: 0, y: 0, ...target };
    const sample = (
      id: string,
      layerId: string,
      colour: ColourSettings,
      blendWeight: number,
      opacity: number,
    ): PreviewLayer => ({
      clipId: id,
      mediaId: id,
      layerId,
      sourceFrame: 11,
      colour,
      weight: blendWeight,
      blendWeight,
      brightness: 1,
      opacity,
    });
    const lower = sample('lower', 'video-1', { ...NEUTRAL_COLOUR }, 1, 1);
    // Both sources use the row's evaluated opacity; dissolve weights retain independent source coverage.
    const left = sample('left', 'video-2', strong, 0.4, 0.65);
    const right = sample('right', 'video-2', warm, 0.6, 0.65);
    const input = new Map<string, Buffer>();
    for (const [index, current] of [lower, left, right].entries()) {
      const rgb = Buffer.alloc(pixels * 3);
      for (let pixel = 0; pixel < pixels; pixel++) {
        rgb[pixel * 3] = (pixel * 73 + index * 41) % 256;
        rgb[pixel * 3 + 1] = (pixel * 157 + index * 23) % 256;
        rgb[pixel * 3 + 2] = (pixel * 29 + index * 61) % 256;
      }
      input.set(current.clipId, rgb);
    }
    const source = (current: PreviewLayer): LayerFrameSource => ({
      sample: current,
      rgb: input.get(current.clipId)!,
      bounds,
    });
    const unchanged = [...input.values()].map((rgb) => Buffer.from(rgb));
    await composeLayerFrame(buffer, target, [source(lower)], cache, signal);
    await composeLayerFrame(buffer, target, [source(left), source(right)], cache, signal);
    const output = new Uint16Array(buffer.buffer, buffer.byteOffset, pixels * 4);
    let error = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      const expected = compositePixel([lower, left, right], (current) => {
        const rgb = input.get(current.clipId)!;
        return [rgb[pixel * 3]! / 255, rgb[pixel * 3 + 1]! / 255, rgb[pixel * 3 + 2]! / 255];
      });
      for (let channel = 0; channel < 3; channel++)
        error += Math.abs(output[pixel * 4 + channel]! / 65535 - expected[channel]!) * 255;
      expect(output[pixel * 4 + 3]).toBe(65535);
    }
    expect(error / (pixels * 3)).toBeLessThan(4);
    expect([...input.values()]).toEqual(unchanged);
    expect(cache.report.peakEntries).toBe(2);
  });
  it('keeps black fades opaque and transparent/zero-opacity gaps unchanged', async () => {
    const target = { width: 2, height: 2 };
    const buffer = Buffer.alloc(32);
    const output = new Uint16Array(buffer.buffer, buffer.byteOffset, 16);
    output.fill(65535);
    const current: PreviewLayer = {
      clipId: 'black',
      mediaId: 'video',
      layerId: 'video-2',
      sourceFrame: 0,
      colour: { ...strong },
      weight: 0,
      blendWeight: 1,
      brightness: 0,
      opacity: 1,
    };
    const source = { sample: current, rgb: Buffer.alloc(12, 200), bounds: { x: 0, y: 0, ...target } };
    const cache = new ColourLutCache();
    const signal = new AbortController().signal;
    await composeLayerFrame(buffer, target, [source], cache, signal);
    expect([...output]).toEqual([0, 0, 0, 65535, 0, 0, 0, 65535, 0, 0, 0, 65535, 0, 0, 0, 65535]);
    const before = Buffer.from(buffer);
    await composeLayerFrame(buffer, target, [], cache, signal);
    await composeLayerFrame(buffer, target, [{ ...source, sample: { ...current, opacity: 0 } }], cache, signal);
    expect(buffer).toEqual(before);
    expect(fittedContent({ width: 160, height: 120 }, { width: 1280, height: 720 })).toEqual({
      x: 160,
      y: 0,
      width: 960,
      height: 720,
    });
  });
  it('keeps letterbox padding black AFTER grading, with the same opaque group coverage', async () => {
    const target = { width: 4, height: 2 };
    const buffer = Buffer.alloc(64);
    const rgb = Buffer.alloc(24, 160);
    const sample: PreviewLayer = {
      clipId: 'letterboxed',
      mediaId: 'video',
      layerId: 'video-1',
      sourceFrame: 0,
      colour: { ...NEUTRAL_COLOUR, brightness: 0.2, shadows: 0.4 },
      weight: 1,
      blendWeight: 1,
      brightness: 1,
      opacity: 1,
    };
    await composeLayerFrame(
      buffer,
      target,
      [{ sample, rgb, bounds: { x: 1, y: 0, width: 2, height: 2 } }],
      new ColourLutCache(),
      new AbortController().signal,
    );
    const output = new Uint16Array(buffer.buffer, buffer.byteOffset, 32);
    for (const pixel of [0, 3, 4, 7]) expect([...output.subarray(pixel * 4, pixel * 4 + 4)]).toEqual([0, 0, 0, 65535]);
    for (const pixel of [1, 2, 5, 6]) {
      expect(output[pixel * 4]).toBeGreaterThan((160 / 255) * 65535);
      expect(output[pixel * 4 + 3]).toBe(65535);
    }
  });
  it('interrupts LUT construction cooperatively, reuses a partial slot, and rejects undersized group caches', async () => {
    const cache = new ColourLutCache();
    const controller = new AbortController();
    const pending = cache.get(strong, controller.signal);
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toThrow('cancelled');
    expect(cache.report.generated).toBe(0);
    await cache.get(warm, new AbortController().signal);
    expect(cache.report).toMatchObject({ peakEntries: 1, generated: 1 });
    const current: PreviewLayer = {
      clipId: 'test',
      mediaId: 'video',
      layerId: 'video-1',
      sourceFrame: 0,
      colour: { ...NEUTRAL_COLOUR },
      weight: 0.5,
      blendWeight: 0.5,
      brightness: 1,
      opacity: 1,
    };
    const source: LayerFrameSource = {
      sample: current,
      rgb: Buffer.alloc(12),
      bounds: { x: 0, y: 0, width: 2, height: 2 },
    };
    await expect(
      composeLayerFrame(
        Buffer.alloc(32),
        { width: 2, height: 2 },
        [source, source],
        new ColourLutCache(1),
        new AbortController().signal,
      ),
    ).rejects.toThrow('every borrowed grade');
    expect(await readdir(await temp())).toEqual([]);
  });
});
