import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const FFMPEG = process.env['PASCAP_FFMPEG'] ?? 'ffmpeg';

async function cudaStarts(): Promise<boolean> {
  try {
    await runProcess(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-init_hw_device',
      'cuda',
      '-f',
      'lavfi',
      '-i',
      'nullsrc=s=64x64:d=0.04',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    return true;
  } catch {
    return false;
  }
}
// Hosts without a CUDA device (CI) skip this suite; the CPU decoder stays the reference.
const nvdec = enabled && (await cudaStarts());

describe.skipIf(!nvdec)('NVDEC proxy decoding · disposable native fixtures', () => {
  let root: string;
  let log: string;
  const libraries: { jobs: JobQueue; library: MediaLibrary }[] = [];
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-nvdec-'));
    await mkdir(path.join(root, 'sources'));
    log = path.join(root, 'ffmpeg.log');
    const wrapper = path.join(root, 'ffmpeg');
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${FFMPEG} "$@"\n`);
    await chmod(wrapper, 0o755);
  });
  afterAll(async () => {
    await Promise.all(libraries.map(({ jobs }) => jobs.close()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function libraryFor(name: string, hardwareDecode: boolean): Promise<MediaLibrary> {
    const config = createConfig({
      dataDir: path.join(root, name),
      ffmpeg: hardwareDecode ? path.join(root, 'ffmpeg') : FFMPEG,
      hardwareDecode,
    });
    const jobs = new JobQueue();
    const library = new MediaLibrary(config, jobs);
    await library.initialise();
    libraries.push({ jobs, library });
    return library;
  }
  async function prepare(library: MediaLibrary, id: string, blackOutDamage = false) {
    return library.jobs.wait((await library.prepare(id, blackOutDamage)).id);
  }
  /** 90 frames of 640 × 360 in 30-frame groups of pictures, optionally with packets overwritten. */
  async function source(config: ServiceConfig, name: string, bFrames: number, broken: number[] = []) {
    const filename = path.join(root, 'sources', name);
    await runProcess(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30000/1001,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      '-frames:v',
      '90',
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
      '-bf',
      String(bFrames),
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
      filename,
    ]);
    if (broken.length) {
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
        for (const frame of broken) {
          const [size, position] = packets[frame]!;
          await file.write(Buffer.alloc(size, 0x5a), 0, size, position);
        }
      } finally {
        await file.close();
      }
    }
    return filename;
  }
  async function frameHashes(filename: string): Promise<string[]> {
    const output = await runProcess(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      filename,
      '-map',
      '0:v:0',
      '-f',
      'framemd5',
      'pipe:1',
    ]);
    return output
      .toString('utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split(',').at(-1)!.trim());
  }
  async function encodes(): Promise<string[]> {
    return (await readFile(log, 'utf8')).split('\n').filter((line) => line.includes('-progress'));
  }

  it('decodes an undamaged original with B-frames on NVDEC into the same proxy as the CPU decoder', async () => {
    const cpu = await libraryFor('cpu', false);
    const gpu = await libraryFor('gpu', true);
    const filename = await source(cpu.config, 'clean.mp4', 1);
    const [onCpu, onGpu] = [await cpu.register(filename), await gpu.register(filename)];
    expect((await prepare(cpu, onCpu.id)).state).toBe('completed');
    const result = await prepare(gpu, onGpu.id);
    expect(result.state, result.message).toBe('completed');
    expect(result.message).toBe('Complete');
    expect(await encodes()).toEqual([expect.stringContaining('-hwaccel cuda')]);
    expect(await frameHashes(gpu.proxyPath(gpu.get(onGpu.id)))).toEqual(
      await frameHashes(cpu.proxyPath(cpu.get(onCpu.id))),
    );
    expect(gpu.get(onGpu.id).prepared!.verification.samples).toEqual(cpu.get(onCpu.id).prepared!.verification.samples);
  }, 60_000);

  it('finds the same damage on NVDEC, then repairs it with the CPU decoder', async () => {
    const cpu = await libraryFor('cpu-damaged', false);
    const gpu = await libraryFor('gpu-damaged', true);
    const filename = await source(cpu.config, 'damaged.mp4', 0, [31, 32, 33]);
    const [onCpu, onGpu] = [await cpu.register(filename), await gpu.register(filename)];
    expect((await prepare(cpu, onCpu.id)).state).toBe('failed');
    const found = await prepare(gpu, onGpu.id);
    expect(found.state).toBe('failed');
    expect(gpu.get(onGpu.id).damage).toEqual([{ start: 30, end: 60 }]);
    expect(gpu.get(onGpu.id).damage).toEqual(cpu.get(onCpu.id).damage);
    expect((await prepare(cpu, onCpu.id, true)).state).toBe('completed');
    const repaired = await prepare(gpu, onGpu.id, true);
    expect(repaired.state, repaired.message).toBe('completed');
    const damagedEncodes = (await encodes()).filter((line) => line.includes('damaged.mp4'));
    expect(damagedEncodes).toHaveLength(2);
    expect(damagedEncodes[0]).toContain('-hwaccel cuda');
    expect(damagedEncodes[1]).not.toContain('-hwaccel');
    expect(await frameHashes(gpu.proxyPath(gpu.get(onGpu.id)))).toEqual(
      await frameHashes(cpu.proxyPath(cpu.get(onCpu.id))),
    );
  }, 60_000);
});
