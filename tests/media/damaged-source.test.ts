import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const BROKEN = [31, 32, 33];

/** Overwrites whole packets, length prefixes included, as a damaged copy would. */
async function corruptPackets(config: ServiceConfig, filename: string, frames: readonly number[]): Promise<void> {
  const listing = await runProcess(config.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pos,size',
    '-of',
    'csv=p=0',
    filename,
  ]);
  const packets = listing
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(',').map(Number) as [number, number]);
  const file = await open(filename, 'r+');
  try {
    let state = 0x2545f491;
    for (const frame of frames) {
      const [size, position] = packets[frame]!;
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index++) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        bytes[index] = state >>> 24;
      }
      await file.write(bytes, 0, size, position);
    }
  } finally {
    await file.close();
  }
}

describe.skipIf(!enabled)('damaged originals · disposable native fixtures', () => {
  let root: string;
  let config: ServiceConfig;
  let jobs: JobQueue;
  let library: MediaLibrary;
  let asset: MediaAsset;
  let originalBytes: Buffer;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-damaged-'));
    const sources = path.join(root, 'sources');
    await mkdir(sources);
    config = createConfig({ dataDir: path.join(root, 'cache') });
    jobs = new JobQueue();
    library = new MediaLibrary(config, jobs);
    await library.initialise();
    const filename = path.join(sources, 'damaged.mp4');
    await runProcess(config.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30000/1001,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-frames:v',
      '90',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-keyint_min',
      '30',
      '-sc_threshold',
      '0',
      '-bf',
      '0',
      '-threads',
      '2',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-video_track_timescale',
      '30000',
      '-movflags',
      '+faststart',
      filename,
    ]);
    await corruptPackets(config, filename, BROKEN);
    asset = await library.register(filename);
    originalBytes = await readFile(filename);
  });
  afterAll(async () => {
    await jobs?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function lumas(filename: string): Promise<number[]> {
    const output = await runProcess(config.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      filename,
      '-map',
      '0:v:0',
      '-vf',
      'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
      '-fps_mode',
      'passthrough',
      '-f',
      'null',
      '-',
    ]);
    return [...output.toString('utf8').matchAll(/YAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  }
  function expectBlack(values: readonly number[], black: (frame: number) => boolean): void {
    values.forEach((value, frame) => {
      if (black(frame)) expect(value, `frame ${frame}`).toBeLessThan(20);
      else expect(value, `frame ${frame}`).toBeGreaterThan(40);
    });
  }
  async function exported(document: ProjectDocument, pipeline: string): Promise<number[]> {
    const job = startExport(document, 'draft720', library);
    const result = await jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    const directory = path.join(config.dataDir, 'renders', job.id);
    const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')) as ExportReceipt;
    expect(receipt.settings.pipeline).toBe(pipeline);
    const values = await lumas(path.join(directory, 'export.mp4'));
    expect(values).toHaveLength(calculateLayout(document).duration);
    return values;
  }

  it('records the damaged group of pictures and asks for an explicit choice', async () => {
    const job = await library.prepare(asset.id);
    const result = await jobs.wait(job.id);
    expect(result.state).toBe('failed');
    expect(result.message).toContain('3 video frames cannot be decoded');
    expect(result.message).toContain('00:01:00–00:01:29');
    expect(library.get(asset.id)).toMatchObject({ status: 'error', prepared: null, damage: [{ start: 30, end: 60 }] });
    await expect(library.prepare(asset.id)).rejects.toThrow('shown black');
    expect(await readFile(asset.sourcePath)).toEqual(originalBytes);
  }, 60_000);

  it('prepares an exact proxy with the damage shown black', async () => {
    const job = await library.prepare(asset.id, true);
    const result = await jobs.wait(job.id);
    expect(result.state, result.message).toBe('completed');
    expect(result.message).toContain('Damaged frames 00:01:00–00:01:29 are shown black.');
    const prepared = library.get(asset.id);
    expect(prepared.status).toBe('ready');
    expect(prepared.prepared!.verification.frameCount).toBe(90);
    expect(prepared.prepared!.verification.samples.map((sample) => sample.frame)).toEqual([0, 60, 89]);
    expectBlack(await lumas(library.proxyPath(prepared)), (frame) => frame >= 30 && frame < 60);
    expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
  }, 60_000);

  it('exports the same black frames forwards (static) and reversed (layered)', async () => {
    const forward = createProject('damaged-forward', 'Disposable damaged forward');
    forward.clips = [createClip('forward', asset.id, 20, 70)];
    forward.media.videoIds = [asset.id];
    expectBlack(await exported(forward, 'static-single-layer'), (frame) => frame >= 10 && frame < 40);

    const reversed = createProject('damaged-reversed', 'Disposable damaged reversed');
    reversed.clips = [{ ...createClip('reversed', asset.id, 25, 65), reverse: true }];
    reversed.media.videoIds = [asset.id];
    reversed.layers[0]!.opacity = 0.9;
    // Output frame f shows source frame 64 - f.
    expectBlack(await exported(reversed, 'sequential-layered'), (frame) => 64 - frame >= 30 && 64 - frame < 60);
    expect(await readFile(asset.sourcePath)).toEqual(originalBytes);
  }, 120_000);
});
