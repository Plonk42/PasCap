import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { runProcess } from '../../src/server/process.js';
import { referenceTimes } from '../../src/server/styles.js';
import { STYLE_VIDEO_FRAMES } from '../../src/shared/styles.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-styles-native-'));
  roots.push(root);
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const config = createConfig({
    dataDir: path.join(root, 'cache'),
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
    mediaRoots: [sources],
  });
  const service = await createApp(config);
  services.push(service);
  return { root, sources, ...service };
}

/** A finished edit: two seconds of bright, soft test pattern, as an export would be. */
async function finishedVideo(config: ServiceConfig, filename: string, brightness: number): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=30000/1001',
    '-frames:v',
    '60',
    '-vf',
    `eq=brightness=${brightness}:saturation=0.6,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-color_range',
    'tv',
    filename,
  ]);
}

async function still(config: ServiceConfig, filename: string): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=800x450',
    '-frames:v',
    '1',
    filename,
  ]);
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('style reference frames', () => {
  it('reads a video at the centers of equal slices', () => {
    expect(referenceTimes(8, 4)).toEqual([1, 3, 5, 7]);
    expect(referenceTimes(2)).toHaveLength(STYLE_VIDEO_FRAMES);
  });
});

describe.skipIf(!enabled)('registered styles · disposable native fixture', () => {
  it('measures videos and stills in place, lists and deletes a style', async () => {
    const { app, sources, config } = await fixture();
    const video = path.join(sources, 'edit.mp4');
    const image = path.join(sources, 'frame.jpg');
    await finishedVideo(config, video, 0.15);
    await still(config, image);
    const before = await readFile(video);

    const browse = await app.inject({ method: 'GET', url: `/api/styles/browse?rootId=root-0`, headers });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().entries.map((entry: { name: string; kind: string }) => [entry.name, entry.kind])).toEqual([
      ['edit.mp4', 'video'],
      ['frame.jpg', 'still'],
    ]);

    const created = await app.inject({
      method: 'POST',
      url: '/api/styles',
      headers,
      payload: { name: 'Bright edits', paths: [video, image] },
    });
    expect(created.statusCode).toBe(200);
    const { style } = created.json();
    expect(style).toMatchObject({
      name: 'Bright edits',
      references: [
        { name: 'edit.mp4', kind: 'video', frames: STYLE_VIDEO_FRAMES },
        { name: 'frame.jpg', kind: 'still', frames: 1 },
      ],
    });
    expect(style.look.levels).toHaveLength(7);
    expect(style.look.middle).toBeGreaterThan(0.3);
    // References are read in place, never changed.
    expect(await readFile(video)).toEqual(before);
    const saved = JSON.parse(await readFile(path.join(config.dataDir, 'styles.json'), 'utf8'));
    expect(saved.styles[0].references[0].path).toBe(video);

    const listed = await app.inject({ method: 'POST', url: '/api/ops/list_styles', headers, payload: {} });
    expect(listed.json().styles.map((item: { id: string }) => item.id)).toEqual([style.id]);
    // Paths stay on the service: the list names files only.
    expect(JSON.stringify(listed.json())).not.toContain(sources);

    const removed = await app.inject({ method: 'DELETE', url: `/api/styles/${style.id}`, headers });
    expect(removed.json()).toEqual({ deleted: true });
    expect((await app.inject({ method: 'POST', url: '/api/ops/list_styles', headers, payload: {} })).json()).toEqual({
      styles: [],
    });
  });

  it('refuses references outside the footage folders, links, other files and an unreadable registry', async () => {
    const { app, root, sources, config } = await fixture();
    const outside = path.join(root, 'outside.jpg');
    await still(config, outside);
    const linked = path.join(sources, 'linked.jpg');
    await symlink(outside, linked);
    const text = path.join(sources, 'notes.txt');
    await writeFile(text, 'not a picture');
    const register = (paths: string[]) =>
      app.inject({ method: 'POST', url: '/api/styles', headers, payload: { name: 'Refused', paths } });
    expect((await register([outside])).statusCode).toBe(403);
    expect((await register([text])).statusCode).toBe(400);
    expect((await register([linked])).statusCode).toBeGreaterThanOrEqual(400);
    expect((await register([path.join(sources, 'missing.jpg')])).statusCode).toBe(404);

    const registry = path.join(config.dataDir, 'styles.json');
    await writeFile(registry, '{"version":99,"styles":[]}');
    const unreadable = await app.inject({ method: 'POST', url: '/api/ops/list_styles', headers, payload: {} });
    expect(unreadable.statusCode).toBe(500);
    expect(await readFile(registry, 'utf8')).toBe('{"version":99,"styles":[]}');
  });
});
