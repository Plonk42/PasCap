import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { runProcess } from '../../src/server/process.js';
import { proxyFrameArgs, STILL_SIZE } from '../../src/server/stills.js';
import { createColourSettings } from '../../src/shared/colour.js';
import { createClip, projectSchema } from '../../src/shared/model.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

interface Picture {
  revision?: number;
  image: { mimeType: string; data: string; width: number; height: number };
  legend: { cell: number; frame: number; timecode: string; clipIds?: string[] }[];
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-stills-native-'));
  roots.push(root);
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const config = createConfig({
    dataDir: path.join(root, 'cache'),
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
    assistantImages: { stillWidth: 480, sheetCellWidth: 240, sheetCells: 9 },
  });
  const service = await createApp(config);
  services.push(service);
  return { sources, ...service };
}

/** Two seconds of moving test pattern; every frame differs. */
async function recording(config: ServiceConfig, filename: string): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=30000/1001',
    '-frames:v',
    '60',
    '-vf',
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
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
}

async function rgbOf(config: ServiceConfig, jpeg: Buffer): Promise<Buffer> {
  return runProcess(
    config.ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input: jpeg },
  );
}

function meanError(left: Buffer, right: Buffer): number {
  expect(left).toHaveLength(right.length);
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += Math.abs(left[index]! - right[index]!);
  return sum / left.length;
}

describe.skipIf(!enabled)('project stills · disposable native fixture', () => {
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('decodes exact proxy frames and renders stills, sheets and candidates without saving', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filename = path.join(sources, 'pattern.mp4');
    await recording(config, filename);
    const original = await readFile(filename);
    const added = await library.addForEditing(filename);
    expect((await jobs.wait(added.job!.id)).state).toBe('completed');
    const asset = library.get(added.asset.id);
    const proxy = library.proxyPath(asset);

    // Seeking to a frame gives exactly the frame a full decode reaches, across GOP boundaries.
    const filter = proxyFrameArgs(proxy, asset, 0)[proxyFrameArgs(proxy, asset, 0).indexOf('-vf') + 1]!;
    for (const frame of [0, 1, 14, 15, 16, 29, 44, 59]) {
      const seeked = await runProcess(config.ffmpeg, proxyFrameArgs(proxy, asset, frame));
      const reference = await runProcess(config.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        proxy,
        '-vf',
        `select=eq(n\\,${frame}),${filter}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ]);
      expect(seeked.length, `frame ${frame}`).toBe(STILL_SIZE.width * STILL_SIZE.height * 3);
      expect(seeked.equals(reference), `frame ${frame}`).toBe(true);
    }

    const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Stills' } });
    const project = projectSchema.parse(created.json<{ document: unknown }>().document);
    const inserted = await app.inject({
      method: 'POST',
      url: '/api/ops/edit',
      headers,
      payload: {
        projectId: project.id,
        expectedRevision: 1,
        commands: [{ type: 'insert', clip: createClip('clip-1', asset.id, 0, 60), index: 0 }],
      },
    });
    expect(inserted.statusCode, inserted.body).toBe(200);
    const saved = await readFile(path.join(config.dataDir, 'projects', `${project.id}.json`), 'utf8');

    const still = await app.inject({
      method: 'POST',
      url: '/api/ops/still',
      headers,
      payload: { projectId: project.id, frame: 20 },
    });
    expect(still.statusCode, still.body).toBe(200);
    const picture = still.json<Picture>();
    expect(picture.revision).toBe(2);
    expect(picture.legend).toEqual([{ cell: 0, frame: 20, timecode: '00:00:20', clipIds: ['clip-1'] }]);
    expect([picture.image.width, picture.image.height]).toEqual([480, 270]);
    const jpeg = Buffer.from(picture.image.data, 'base64');
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
    const expected = await runProcess(
      config.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        '1280x720',
        '-i',
        'pipe:0',
        '-vf',
        'scale=480:270:flags=area',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { input: await runProcess(config.ffmpeg, proxyFrameArgs(proxy, asset, 20)) },
    );
    expect(meanError(await rgbOf(config, jpeg), expected)).toBeLessThan(4);

    // A candidate grade renders brighter and is never saved.
    const brighter = await app.inject({
      method: 'POST',
      url: '/api/ops/still',
      headers,
      payload: {
        projectId: project.id,
        frame: 20,
        commands: [{ type: 'colour', layerId: 'video-1', colour: { ...createColourSettings(), exposure: 1 } }],
      },
    });
    expect(brighter.statusCode, brighter.body).toBe(200);
    const mean = (rgb: Buffer) => rgb.reduce((sum, value) => sum + value, 0) / rgb.length;
    const graded = await rgbOf(config, Buffer.from(brighter.json<Picture>().image.data, 'base64'));
    // Bright test-pattern areas clip, so one stop raises the mean less than it would on footage.
    expect(mean(graded)).toBeGreaterThan(mean(await rgbOf(config, jpeg)) + 5);
    expect(await readFile(path.join(config.dataDir, 'projects', `${project.id}.json`), 'utf8')).toBe(saved);

    const crop = await app.inject({
      method: 'POST',
      url: '/api/ops/still',
      headers,
      payload: { projectId: project.id, frame: 20, crop: { x: 100, y: 50, width: 200, height: 100 } },
    });
    expect(crop.statusCode, crop.body).toBe(200);
    expect([crop.json<Picture>().image.width, crop.json<Picture>().image.height]).toEqual([200, 100]);

    const sheet = await app.inject({
      method: 'POST',
      url: '/api/ops/timeline_sheet',
      headers,
      payload: { projectId: project.id, frames: [0, 20, 40, 59] },
    });
    expect(sheet.statusCode, sheet.body).toBe(200);
    const contact = sheet.json<Picture>();
    expect([contact.image.width, contact.image.height]).toEqual([484, 276]);
    expect(await rgbOf(config, Buffer.from(contact.image.data, 'base64'))).toHaveLength(484 * 276 * 3);
    expect(contact.legend.map((cell) => [cell.cell, cell.frame, cell.clipIds])).toEqual([
      [0, 0, ['clip-1']],
      [1, 20, ['clip-1']],
      [2, 40, ['clip-1']],
      [3, 59, ['clip-1']],
    ]);

    const recordingSheet = await app.inject({
      method: 'POST',
      url: '/api/ops/recording_sheet',
      headers,
      payload: { mediaId: asset.id, frames: [0, 30, 59] },
    });
    expect(recordingSheet.statusCode, recordingSheet.body).toBe(200);
    expect(recordingSheet.json<Picture>().image.width).toBe(2 * 240 + 4);

    const compared = await app.inject({
      method: 'POST',
      url: '/api/ops/compare_recordings',
      headers,
      payload: {
        projectId: project.id,
        candidates: [
          { mediaId: asset.id, sourceIn: 0, sourceOut: 30 },
          { mediaId: asset.id, sourceIn: 30, sourceOut: 60 },
        ],
        frames: 3,
      },
    });
    expect(compared.statusCode, compared.body).toBe(200);
    const rows = compared.json<{ image: Picture['image']; candidates: { cells: number[]; frames: number[] }[] }>();
    // One row of three cells per candidate.
    expect([rows.image.width, rows.image.height]).toEqual([3 * 240 + 2 * 4, 2 * 136 + 4]);
    expect(rows.candidates.map((candidate) => [candidate.cells, candidate.frames])).toEqual([
      [
        [0, 1, 2],
        [5, 15, 25],
      ],
      [
        [3, 4, 5],
        [35, 45, 55],
      ],
    ]);

    const tooWide = await app.inject({
      method: 'POST',
      url: '/api/ops/still',
      headers,
      payload: { projectId: project.id, frame: 20, width: 640 },
    });
    expect(tooWide.statusCode).toBe(422);
    expect(tooWide.json<{ error: string }>().error).toMatch(/allows 480 pixels of still width/);
    const after = await app.inject({
      method: 'POST',
      url: '/api/ops/still',
      headers,
      payload: { projectId: project.id, frame: 60 },
    });
    expect(after.statusCode).toBe(422);
    expect(await readFile(filename)).toEqual(original);
  });
});
