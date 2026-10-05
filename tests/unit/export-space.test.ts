import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import { preflightExport, renderExport } from '../../src/server/export.js';
import { exportStorageFailure, readExportSpace, requireExportReserve } from '../../src/server/export-space.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue, type JobContext } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { retimeRawVideo } from '../../src/server/retime-process.js';
import { estimateExportSpace, exportPreflightSchema, formatStorageBytes, MIN_EXPORT_FREE_BYTES } from '../../src/shared/export-space.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});
vi.mock('../../src/server/retime-process.js', () => ({ retimeRawVideo: vi.fn() }));

const temporary: string[] = [];
const queues: JobQueue[] = [];
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(statfs).mockReset(); vi.mocked(retimeRawVideo).mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-export-space-'));
  temporary.push(directory); return directory;
}
function documentWithClips(count = 1): ProjectDocument {
  const document = createProject('space-unit', 'Space unit');
  document.clips = Array.from({ length: count }, (_, index) => createClip(`clip-${index}`, 'video', 0, 30));
  document.layers[0]!.transitions = document.clips.slice(1).map((clip, index) => ({ leftId: document.clips[index]!.id, rightId: clip.id, type: 'cut' as const, duration: 0 }));
  document.media.videoIds = ['video'];
  return projectSchema.parse(document);
}

async function fixture() {
  const root = await temp();
  const cache = path.join(root, 'cache'); await mkdir(cache);
  const source = path.join(root, 'original.mp4'); await writeFile(source, 'disposable source bytes');
  const fingerprint = await fingerprintFile(source);
  const asset: MediaAsset = {
    id: 'video', name: 'original.mp4', sourcePath: source, fingerprint, status: 'registered', error: null, prepared: null,
    metadata: { width: 320, height: 180, codec: 'h264', pixelFormat: 'yuv420p', frameRate: PROJECT_FPS, frameCount: 60, durationSeconds: framesToSeconds(60), colourPrimaries: 'bt709', colourTransfer: 'bt709', colourSpace: 'bt709', colourRange: 'tv', hasAudio: false },
  };
  const queue = new JobQueue(); queues.push(queue);
  const library = new MediaLibrary(createConfig({ dataDir: cache }), queue);
  vi.spyOn(library, 'get').mockReturnValue(asset);
  return { root, cache, source, fingerprint, asset, library, document: documentWithClips() };
}

async function setFree(directory: string, availableBytes: number): Promise<void> {
  const actual = await statfs(directory, { bigint: true });
  vi.mocked(statfs).mockResolvedValue({ ...actual, bsize: 1n, bavail: BigInt(availableBytes) });
}

describe('duration-dependent planning allowance, not a codec guarantee', () => {
  it('budgets one lossless clip, two encoded copies, margin and start reserve for a static clip', () => {
    const estimate = estimateExportSpace(documentWithClips(), 'draft720');
    const pixels = 1280 * 720;
    expect(estimate.losslessBytes).toBe(pixels * 30 * 4);
    expect(estimate.encodedBytes).toBe(pixels * 30 * 2);
    expect(estimate.audioBytes).toBe(0);
    expect(estimate.overheadBytes).toBe((estimate.losslessBytes + estimate.encodedBytes) / 4 + MIN_EXPORT_FREE_BYTES);
    expect(estimate.totalBytes).toBe(estimate.losslessBytes + estimate.encodedBytes + estimate.overheadBytes);
  });
  it('bounds clip scratch to the two largest enabled clips, not every clip in a long sequence', () => {
    const document = documentWithClips(8);
    document.clips[3]!.sourceOut = 60;
    const before = JSON.stringify(document);
    expect(estimateExportSpace(document, 'draft720').losslessBytes).toBe(1280 * 720 * 90 * 4);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('uses authoritative retimed durations and UHD pixel count rather than original source lengths', () => {
    const document = documentWithClips();
    document.clips[0]!.speed = { mode: 'constant', rate: 0.5 };
    expect(estimateExportSpace(document, 'draft720').losslessBytes).toBe(1280 * 720 * 60 * 4);
    expect(estimateExportSpace(document, 'final4k').losslessBytes).toBe(3840 * 2160 * 60 * 4);
  });
  it('budgets three RGBA16 timeline representations for row animation, even a neutral key', () => {
    const document = documentWithClips();
    document.layers[0]!.keyframes = [{ frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, exposure: 0 } }];
    expect(estimateExportSpace(document, 'draft720').losslessBytes).toBe(1280 * 720 * (30 * 4 + 3 * 30 * 8));
  });
  it('keeps disabled tails in full timeline allowance but excludes their unrendered clip files', () => {
    const document = documentWithClips();
    document.layers.push({ ...createLayer('hidden', 'Hidden', false), enabled: false });
    document.clips.push({ ...createClip('hidden', 'video', 0, 60), layerId: 'hidden', start: 100 });
    expect(estimateExportSpace(document, 'draft720').losslessBytes).toBe(1280 * 720 * (30 * 4 + 3 * 160 * 8));
  });
  it('budgets only the selected PCM once regardless of looping and none for inactive music', () => {
    const document = documentWithClips();
    document.music = { mediaId: 'music', sourceIn: 6, sourceOut: 12, start: 0, duration: 30, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: true };
    expect(estimateExportSpace(document, 'draft720').audioBytes).toBe((19219 - 9610) * 4);
    document.music.start = 40;
    expect(estimateExportSpace(document, 'draft720').audioBytes).toBe(0);
  });
  it('remains finite for the maximum supported timeline and grows with duration, not a fixed GB bound', () => {
    const document = documentWithClips();
    const short = estimateExportSpace(document, 'final4k');
    document.clips[0]!.sourceOut = 2_147_483_647;
    const long = estimateExportSpace(document, 'final4k');
    expect(Number.isFinite(long.totalBytes)).toBe(true); expect(long.totalBytes).toBeGreaterThan(short.totalBytes * 1_000_000);
  });
  it.each([{ bytes: 0, text: '0 B' }, { bytes: 1024, text: '1.0 KiB' }, { bytes: 16 * 1024 ** 2, text: '16.0 MiB' }, { bytes: 1024 ** 3, text: '1.0 GiB' }])('formats $bytes bytes with explicit binary units', ({ bytes, text }) => {
    expect(formatStorageBytes(bytes)).toBe(text);
  });
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid storage size %s', (value) => {
    expect(() => formatStorageBytes(value)).toThrow('finite and non-negative');
  });
});

describe('read-only preflight and safe reserve enforcement', () => {
  it('reads free space and validates originals metadata without reading/probing/preparing sources or writing files', async () => {
    const fixtureData = await fixture();
    const before = await readdir(fixtureData.cache);
    await rm(fixtureData.source);
    const result = await preflightExport(fixtureData.document, 'draft720', fixtureData.library);
    expect(exportPreflightSchema.parse(result)).toEqual(result);
    expect(result.directory).toBe(path.join(fixtureData.cache, 'renders'));
    expect(await readdir(fixtureData.cache)).toEqual(before);
    expect(fixtureData.library.jobs.list()).toEqual([]); expect(retimeRawVideo).not.toHaveBeenCalled();
  });
  it('warns below the allowance without treating an uncertain budget as a hard codec bound', async () => {
    const { cache, document } = await fixture();
    await setFree(cache, MIN_EXPORT_FREE_BYTES);
    const result = await readExportSpace(cache, document, 'draft720');
    expect(result.status).toBe('tight'); expect(result.availableBytes).toBe(MIN_EXPORT_FREE_BYTES);
    expect(() => requireExportReserve(result)).not.toThrow();
  });
  it('blocks below the explicit start reserve with a 507 recovery message', async () => {
    const { cache, document } = await fixture();
    await setFree(cache, MIN_EXPORT_FREE_BYTES - 1);
    const result = await readExportSpace(cache, document, 'draft720');
    expect(result.status).toBe('blocked');
    expect(() => requireExportReserve(result)).toThrow(expect.objectContaining({ statusCode: 507, message: expect.stringContaining('No render was started') }));
  });
  it('reports a failed filesystem check instead of fabricating available space', async () => {
    const { cache, document } = await fixture();
    vi.mocked(statfs).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    await expect(readExportSpace(cache, document, 'final4k')).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('mount and permissions') });
  });
  it('checks an existing output volume rather than assuming that the data-directory mount is identical', async () => {
    const { cache, document } = await fixture(); const renders = path.join(cache, 'renders'); await mkdir(renders);
    await setFree(cache, 100 * 1024 ** 3); vi.mocked(statfs).mockClear();
    await readExportSpace(cache, document, 'draft720');
    expect(statfs).toHaveBeenCalledExactlyOnceWith(renders, { bigint: true });
  });
  it('rejects a symlinked output location instead of following it or presenting the wrong volume', async () => {
    const { root, cache, document } = await fixture(); const unrelated = path.join(root, 'unrelated'); await mkdir(unrelated);
    await symlink(unrelated, path.join(cache, 'renders'));
    await expect(readExportSpace(cache, document, 'draft720')).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining('Symlinks') });
    expect(await readdir(unrelated)).toEqual([]);
  });
  it('rechecks at worker start and creates no directory or native work when the volume has filled', async () => {
    const { cache, document, library } = await fixture();
    await setFree(cache, 0);
    const context: JobContext = { id: randomUUID(), signal: new AbortController().signal, update: vi.fn() };
    await expect(renderExport(document, 'draft720', library, context)).rejects.toMatchObject({ statusCode: 507 });
    expect(await readdir(cache)).toEqual([]); expect(retimeRawVideo).not.toHaveBeenCalled();
  });
  it('guards the preflight route and rejects low-space submission before a job is admitted', async () => {
    const { cache, document, asset } = await fixture();
    const service = await createApp(createConfig({ dataDir: cache, webDir: '/nonexistent-space-assets' }));
    vi.spyOn(service.library, 'get').mockReturnValue(asset);
    try {
      const payload = { document, profile: 'draft720' };
      const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };
      expect((await service.app.inject({ method: 'POST', url: '/api/exports/preflight', headers: { host: headers.host }, payload })).statusCode).toBe(403);
      expect((await service.app.inject({ method: 'POST', url: '/api/exports/preflight', headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
      await setFree(cache, 0);
      const read = await service.app.inject({ method: 'POST', url: '/api/exports/preflight', headers, payload });
      expect(read.statusCode).toBe(200); expect(read.json().space.status).toBe('blocked');
      const submit = await service.app.inject({ method: 'POST', url: '/api/exports', headers, payload });
      expect(submit.statusCode).toBe(507); expect(submit.json().error).toContain('Free at least');
      expect(service.jobs.list()).toEqual([]); expect(retimeRawVideo).not.toHaveBeenCalled();
      expect((await service.app.inject({ method: 'POST', url: '/api/exports/preflight', headers, payload: { ...payload, ignoreSafety: true } })).statusCode).toBe(400);
    } finally { await service.app.close(); }
  });
});

describe('ENOSPC retains original identity and previous successful data', () => {
  it.each([
    { name: 'filesystem ENOSPC', cause: Object.assign(new Error('write failed'), { code: 'ENOSPC' }) },
    { name: 'native stderr', cause: new ServiceError('FFmpeg encoder failed: No space left on device') },
    { name: 'quota', cause: Object.assign(new Error('write failed'), { code: 'EDQUOT' }) },
  ])('cleans only owned work/partials after $name', async ({ cause }) => {
    const { cache, source, fingerprint, document, library } = await fixture();
    await setFree(cache, 100 * 1024 ** 3);
    const previous = path.join(cache, 'renders', 'completed'); await mkdir(previous, { recursive: true });
    await writeFile(path.join(previous, 'export.mp4'), 'previous completed output');
    const project = path.join(cache, 'saved-project.json'); await writeFile(project, JSON.stringify(document));
    vi.mocked(retimeRawVideo).mockImplementationOnce(async (options) => {
      await writeFile(path.join(options.cwd, 'owned-incomplete.nut'), 'partial scratch');
      await writeFile(path.join(path.dirname(options.cwd), 'export.partial.mp4'), 'partial mp4');
      throw cause;
    });
    const context: JobContext = { id: randomUUID(), signal: new AbortController().signal, update: vi.fn() };
    await expect(renderExport(document, 'draft720', library, context)).rejects.toMatchObject({ statusCode: 507, message: expect.stringContaining('start a new export') });
    expect(await readdir(path.join(cache, 'renders'))).toEqual(['completed']);
    expect(await readFile(path.join(previous, 'export.mp4'), 'utf8')).toBe('previous completed output');
    expect(await readFile(project, 'utf8')).toBe(JSON.stringify(document));
    expect(await fingerprintFile(source)).toEqual(fingerprint);
  });
  it('does not misclassify unrelated native errors as a disk-space failure', () => {
    const cause = new ServiceError('Invalid source frames.', 422);
    expect(exportStorageFailure(cause, '/unused')).toBe(cause);
  });
});