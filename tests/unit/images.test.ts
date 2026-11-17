import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { readImageInfo } from '../../src/server/image-header.js';
import { ImageLibrary } from '../../src/server/images.js';
import { imageFileUrl } from '../../src/shared/images.js';

const roots: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

/** The first bytes of a baseline JPEG: an EXIF-sized APP1 segment, then its frame header. */
function jpeg(width: number, height: number, app1 = 40_000): Buffer {
  const segment = (marker: number, body: Buffer) =>
    Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const frame = Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.alloc(app1, 7)),
    segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc0, frame),
    Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]),
  ]);
}

function png(width: number, height: number): Buffer {
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from('IHDR'),
    size,
    Buffer.from([8, 6, 0, 0, 0, 1, 2, 3, 4]),
  ]);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-images-'));
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
  return { root, sources, config };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('image headers', () => {
  it('reads the size of JPEG and PNG images', () => {
    expect(readImageInfo(jpeg(4000, 2250))).toEqual({ format: 'jpeg', width: 4000, height: 2250 });
    expect(readImageInfo(png(1920, 1080))).toEqual({ format: 'png', width: 1920, height: 1080 });
    // Fill bytes before a marker are allowed.
    const filled = jpeg(640, 360, 4);
    expect(readImageInfo(Buffer.concat([filled.subarray(0, 2), Buffer.from([0xff]), filled.subarray(2)]))).toEqual({
      format: 'jpeg',
      width: 640,
      height: 360,
    });
  });

  it('rejects other files, cut headers and empty pictures', () => {
    expect(readImageInfo(Buffer.from('GIF89a, not supported'))).toBeNull();
    expect(readImageInfo(jpeg(640, 360).subarray(0, 1_000))).toBeNull();
    expect(readImageInfo(png(1920, 1080).subarray(0, 20))).toBeNull();
    expect(readImageInfo(jpeg(0, 360))).toBeNull();
    expect(readImageInfo(png(1920, 0))).toBeNull();
    // Scan data before any frame header.
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
  });
});

describe('image library', () => {
  it('registers images in place, keeps the id of an image imported again and persists the registry', async () => {
    const { sources, config } = await fixture();
    const photo = path.join(sources, 'look.jpg');
    const still = path.join(sources, 'graded.png');
    await writeFile(photo, jpeg(4000, 2250));
    await writeFile(still, png(1920, 1080));
    const before = await readFile(photo);
    const library = new ImageLibrary(config);
    await library.initialize();
    const first = await library.register([photo, still, path.join(sources, 'gone.jpg')]);
    expect(first.images.map(({ name, format, width, height }) => [name, format, width, height])).toEqual([
      ['look.jpg', 'jpeg', 4000, 2250],
      ['graded.png', 'png', 1920, 1080],
    ]);
    expect(first.errors).toEqual([{ path: path.join(sources, 'gone.jpg'), message: 'gone.jpg is missing.' }]);
    expect(await readFile(photo)).toEqual(before);

    await writeFile(photo, jpeg(3000, 2000));
    expect(await library.missing()).toEqual([first.images[0]!.id]);
    const again = await library.register([photo]);
    expect(again.images[0]).toMatchObject({ id: first.images[0]!.id, width: 3000, height: 2000 });
    expect(await library.missing()).toEqual([]);

    const reopened = new ImageLibrary(config);
    await reopened.initialize();
    expect(reopened.list().map((image) => image.id)).toEqual(library.list().map((image) => image.id));
    expect(reopened.get(first.images[1]!.id).sourcePath).toBe(still);
  });

  it('refuses files that are not JPEG or PNG pictures, and reads PNG images in the editor only', async () => {
    const { sources, config } = await fixture();
    const text = path.join(sources, 'notes.png');
    const still = path.join(sources, 'graded.png');
    await writeFile(text, 'not an image');
    await writeFile(still, png(1920, 1080));
    const library = new ImageLibrary(config);
    const result = await library.register([text, still]);
    expect(result.errors).toEqual([{ path: text, message: 'notes.png is not a JPEG or PNG image PasCap can read.' }]);
    await expect(library.analysisFrame(result.images[0]!.id)).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining('the service reads JPEG images only'),
    });
    expect(() => library.get('unknown')).toThrow('No image unknown is registered.');
  });
});

describe('image routes', () => {
  it('lists images with videos, registers root-scoped images and serves only registered originals', async () => {
    const { sources, config } = await fixture();
    const service = await createApp(config);
    services.push(service);
    const { app } = service;
    const photo = path.join(sources, 'look.jpg');
    const bytes = jpeg(4000, 2250);
    await writeFile(photo, bytes);
    await writeFile(path.join(sources, 'clip.mp4'), 'video bytes');

    const listing = await app.inject({ method: 'GET', url: '/api/footage?rootId=root-0', headers });
    expect(listing.json().entries.map((entry: { name: string; kind: string }) => [entry.name, entry.kind])).toEqual([
      ['clip.mp4', 'video'],
      ['look.jpg', 'image'],
    ]);

    const outside = await app.inject({
      method: 'POST',
      url: '/api/images/register-paths',
      headers,
      payload: { paths: [path.join(path.dirname(sources), 'elsewhere.jpg')] },
    });
    expect(outside.statusCode).toBe(403);
    const video = await app.inject({
      method: 'POST',
      url: '/api/images/register-paths',
      headers,
      payload: { paths: [path.join(sources, 'clip.mp4')] },
    });
    expect(video.statusCode).toBe(400);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/images/register-paths',
      headers,
      payload: { paths: [photo] },
    });
    expect(registered.statusCode).toBe(200);
    const [image] = registered.json().images;
    expect(image).toMatchObject({ name: 'look.jpg', format: 'jpeg', sourcePath: photo });
    expect(await app.inject({ method: 'GET', url: '/api/images', headers }).then((reply) => reply.json())).toEqual({
      images: [image],
      missing: [],
    });

    const served = await app.inject({ method: 'GET', url: imageFileUrl(image), headers });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.rawPayload).toEqual(bytes);
    expect((await app.inject({ method: 'GET', url: '/api/images/unknown/file', headers })).statusCode).toBe(404);

    // A replaced original is no longer served.
    await rm(photo);
    await symlink(path.join(sources, 'clip.mp4'), photo);
    const replaced = await app.inject({ method: 'GET', url: imageFileUrl(image), headers });
    expect(replaced.statusCode).toBe(422);
    expect(
      await app.inject({ method: 'GET', url: '/api/images', headers }).then((reply) => reply.json().missing),
    ).toEqual([image.id]);
  });

  it('refuses to save a project whose library holds an image that is not registered', async () => {
    const { config } = await fixture();
    const service = await createApp(config);
    services.push(service);
    const { app } = service;
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { title: 'Images' } });
    const { document } = created.json();
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/${document.id}`,
      headers,
      payload: { document: { ...document, media: { ...document.media, imageIds: ['unknown'] } }, expectedRevision: 0 },
    });
    expect(saved.statusCode).toBe(404);
    expect(saved.json().error).toBe('No image unknown is registered.');
  });
});
