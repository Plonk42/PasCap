import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { ServiceError } from '../../src/server/errors.js';
import * as files from '../../src/server/files.js';
import { FootageBrowser } from '../../src/server/footage.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary, PROXY_PROFILE, type ImportForEditingResult } from '../../src/server/library.js';
import { probeVideo } from '../../src/server/probe.js';
import { runProcess } from '../../src/server/process.js';
import { MAX_FOOTAGE_ENTRIES, MAX_FOOTAGE_FILES, footageDirectorySchema, footageRootSchema, type FootageDirectory, type FootageRoot } from '../../src/shared/footage.js';
import { mediaAssetSchema, registrySchema, type MediaAsset, type VideoMetadata } from '../../src/shared/media.js';
import { forEachSerial } from '../../src/shared/serial.js';
import { framesToSeconds, PROJECT_FPS } from '../../src/shared/timing.js';

// All filesystem/security/HTTP/queue operations are real and disposable.
// No unit test can launch FFmpeg/FFprobe or access a user's recordings/cache.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));
vi.mock('../../src/server/process.js', () => ({ runProcess: vi.fn() }));
vi.mock('../../src/server/probe.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/probe.js')>(),
  probeVideo: vi.fn(),
}));

const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const queues: JobQueue[] = [];
const releases: (() => void)[] = [];
const permissions: { filename: string; mode: number }[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

function metadata(): VideoMetadata {
  return {
    width: 160, height: 90, codec: 'h264', pixelFormat: 'yuv420p', frameRate: { ...PROJECT_FPS },
    frameCount: 12, durationSeconds: framesToSeconds(12), colourPrimaries: 'bt709',
    colourTransfer: 'bt709', colourSpace: 'bt709', colourRange: 'tv', hasAudio: false,
  };
}
function prepared(): NonNullable<MediaAsset['prepared']> {
  return {
    profile: PROXY_PROFILE, width: 160, height: 90, thumbnailFrames: [0, 3, 6, 9, 11],
    verification: { frameCount: 12, samples: [0, 5, 11].map((frame) => ({ frame, meanAbsoluteError8Bit: 0 })), verifiedAt: '2026-10-03T00:00:00.000Z' },
  };
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pascap-footage-unit-'));
  temporary.push(root);
  const sources = path.join(root, 'recordings');
  const outside = path.join(root, 'recordings-elsewhere');
  const dataDir = path.join(root, 'cache');
  await Promise.all([sources, outside, dataDir].map((directory) => fs.mkdir(directory)));
  const config = createConfig({
    dataDir, mediaRoots: [sources], webDir: path.join(root, 'absent-web'), port: 4318,
    ffmpeg: '/unit-tests-never-run-ffmpeg', ffprobe: '/unit-tests-never-run-ffprobe',
    allowedHosts: new Set(['127.0.0.1:4318']), allowedOrigins: new Set(['http://127.0.0.1:4318']),
  });
  return { root, sources, outside, config };
}
async function serviceFixture() {
  const directories = await setup();
  const service = await createApp(directories.config); services.push(service);
  return { ...directories, ...service };
}
async function libraryFixture() {
  const directories = await setup();
  const jobs = new JobQueue(); queues.push(jobs);
  const library = new MediaLibrary(directories.config, jobs);
  await library.initialise();
  return { ...directories, library, jobs };
}
async function source(directory: string, name = 'Clip 1.mp4'): Promise<string> {
  const filename = path.join(directory, name);
  await fs.writeFile(filename, `disposable original bytes: ${name}`);
  return filename;
}
async function setPermissions(filename: string, mode: number, restore = 0o700): Promise<void> {
  permissions.push({ filename, mode: restore });
  await fs.chmod(filename, mode);
}
function blockWorker(jobs: JobQueue) {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  jobs.submit('reference', 'footage-unit worker gate', async (context) => new Promise<void>((resolve, reject) => {
    const abort = (): void => { reject(new ServiceError('Job cancelled.', 499)); };
    if (context.signal.aborted) { abort(); return; }
    context.signal.addEventListener('abort', abort, { once: true });
    void gate.then(() => { context.signal.removeEventListener('abort', abort); resolve(); });
  }));
  return release;
}
async function fakeProcess(_binary: string, args: string[], options: NonNullable<Parameters<typeof runProcess>[2]> = {}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const output = args.at(-1);
  if (!output) throw new Error('Expected a cache output argument.');
  if (output === 'pipe:1') return Buffer.alloc(160 * 90 * 3, 64);
  await fs.writeFile(output, args.includes('-progress') ? 'mock verified proxy' : 'mock thumbnail');
  return Buffer.alloc(0);
}
function browseUrl(rootId: string, directory?: string): string {
  const query = new URLSearchParams({ rootId });
  if (directory !== undefined) query.set('directory', directory);
  return `/api/footage?${query}`;
}
async function postPaths(app: Awaited<ReturnType<typeof createApp>>['app'], paths: readonly string[]) {
  return app.inject({ method: 'POST', url: '/api/media/register-paths', headers, payload: { paths } });
}

beforeEach(() => {
  vi.stubEnv('PASCAP_MEDIA_ROOTS', undefined);
  vi.stubEnv('PASCAP_PORT', undefined);
  vi.mocked(probeVideo).mockReset().mockResolvedValue(metadata());
  vi.mocked(runProcess).mockReset().mockImplementation(fakeProcess);
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(permissions.splice(0).map(({ filename, mode }) => fs.chmod(filename, mode)));
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('approved footage-root configuration', () => {
  it('defaults only to the service user Videos folder, without checking existence', () => {
    expect(createConfig().mediaRoots).toEqual([path.join(os.homedir(), 'Videos')]);
  });

  it('parses JSON paths with spaces/colons and keeps configured missing roots', async () => {
    const { root } = await setup();
    const paths = [path.join(root, 'Camera footage: SD 1'), path.join(root, 'missing-drive')];
    vi.stubEnv('PASCAP_MEDIA_ROOTS', JSON.stringify(paths));
    expect(createConfig().mediaRoots).toEqual(paths);
  });

  it('allows an explicitly empty root list and overrides a bad environment', () => {
    vi.stubEnv('PASCAP_MEDIA_ROOTS', '[]');
    expect(createConfig().mediaRoots).toEqual([]);
    vi.stubEnv('PASCAP_MEDIA_ROOTS', 'not JSON');
    expect(createConfig({ mediaRoots: [] }).mediaRoots).toEqual([]);
    expect(createConfig({ mediaRoots: ['/explicit/recordings/'] }).mediaRoots).toEqual(['/explicit/recordings']);
  });

  it.each([
    'not JSON', '', 'null', '{}', '42', 'true', '"/recordings"', '["relative"]', '[""]',
    '["/recordings",1]', JSON.stringify(['/nul\0path']), JSON.stringify([`/${'x'.repeat(4096)}`]),
    JSON.stringify(['/same', '/same']), JSON.stringify(['/same/', '/same/.']),
    JSON.stringify(Array.from({ length: 33 }, (_, index) => `/root-${index}`)),
  ])('clearly rejects invalid PASCAP_MEDIA_ROOTS: %s', (value) => {
    vi.stubEnv('PASCAP_MEDIA_ROOTS', value);
    expect(() => createConfig()).toThrow('PASCAP_MEDIA_ROOTS');
  });

  it('validates override roots too and accepts exactly 32', () => {
    expect(() => createConfig({ mediaRoots: ['relative'] })).toThrow('PASCAP_MEDIA_ROOTS');
    expect(createConfig({ mediaRoots: Array.from({ length: 32 }, (_, index) => `/root-${index}`) }).mediaRoots).toHaveLength(32);
  });
});

describe('metadata-only single-directory footage browsing', () => {
  it('naturally sorts directories before videos, ignores other entries and never reads/probes/prepares originals', async () => {
    const { sources, outside, config } = await setup();
    const directories = ['Flight 10', 'Flight 2'];
    await Promise.all(directories.map((name) => fs.mkdir(path.join(sources, name))));
    const names = ['Clip 10.MOV', 'Clip 2.mp4', 'Clip 1.m4v', 'Clip 20.MP4'];
    const originals = await Promise.all(names.map((name) => source(sources, name)));
    await source(path.join(sources, 'Flight 2'), 'Nested.mp4');
    await Promise.all(['notes.txt', 'sound.wav', 'photo.JPG'].map((name) => source(sources, name)));
    await fs.symlink(originals[0]!, path.join(sources, 'Linked.mp4'));
    await fs.symlink(outside, path.join(sources, 'Linked folder'));
    const read = vi.spyOn(fs, 'readFile'); const open = vi.spyOn(fs, 'open');
    const browser = new FootageBrowser(config);
    const result = footageDirectorySchema.parse(await browser.browse('root-0'));
    expect(result).toMatchObject({ rootId: 'root-0', directory: sources, parent: null, ignored: 5, truncated: false, warnings: [] });
    expect(result.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ['Flight 2', 'directory'], ['Flight 10', 'directory'], ['Clip 1.m4v', 'video'],
      ['Clip 2.mp4', 'video'], ['Clip 10.MOV', 'video'], ['Clip 20.MP4', 'video'],
    ]);
    expect(result.entries.filter((entry) => entry.kind === 'directory').every((entry) => entry.size === null)).toBe(true);
    expect(result.entries.filter((entry) => entry.kind === 'video').every((entry) => entry.size === Buffer.byteLength(`disposable original bytes: ${entry.name}`))).toBe(true);
    expect(result.entries.every((entry) => entry.path === path.join(sources, entry.name))).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(probeVideo).not.toHaveBeenCalled(); expect(runProcess).not.toHaveBeenCalled();
    expect(await fs.readdir(config.dataDir)).toEqual([]);
  });

  it('keeps parent navigation within the chosen root, including nested approved roots and trailing slashes', async () => {
    const { sources, config } = await setup();
    const nested = path.join(sources, 'Flight 2'); await fs.mkdir(nested);
    const browser = new FootageBrowser(createConfig({ ...config, mediaRoots: [sources, nested] }));
    expect(await browser.browse('root-0', `${sources}/`)).toMatchObject({ directory: sources, parent: null });
    expect(await browser.browse('root-0', nested)).toMatchObject({ directory: nested, parent: sources });
    expect(await browser.browse('root-1')).toMatchObject({ directory: nested, parent: null });
    await expect(browser.browse('root-1', sources)).rejects.toMatchObject({ statusCode: 403 });
    await expect(browser.browse('root-2')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects lexical escapes/traversal and does not confuse prefixes or dot-prefixed filenames with boundaries', async () => {
    const { sources, outside, config } = await setup();
    const browser = new FootageBrowser(config);
    const cases: [string, number][] = [
      ['relative', 400], [`${sources}/\0`, 400], [`/${'x'.repeat(4096)}`, 400],
      [`${sources}/nested/../`, 400], [`${sources}/../recordings-elsewhere`, 400],
      [outside, 403], [path.dirname(sources), 403], ['/', 403],
    ];
    await forEachSerial(cases, async ([directory, statusCode]) => {
      await expect(browser.browse('root-0', directory)).rejects.toMatchObject({ statusCode });
    });
    const retained = path.join(sources, '..not-traversal'); await fs.mkdir(retained);
    expect(await browser.browse('root-0', retained)).toMatchObject({ directory: retained, parent: sources });
    expect(browser.validatePaths([path.join(retained, '..clip.MP4')])).toEqual([path.join(retained, '..clip.MP4')]);
  });

  it('allows cache ancestors, hides the cache subtree, and forbids selecting/browsing the cache itself', async () => {
    const { root, sources, config } = await setup();
    await source(config.dataDir, 'proxy.mp4');
    const child = path.join(config.dataDir, 'nested'); await fs.mkdir(child);
    const browser = new FootageBrowser(createConfig({ ...config, mediaRoots: [root, config.dataDir, child] }));
    const result = await browser.browse('root-0');
    expect(result.entries.map((entry) => entry.path)).toContain(sources);
    expect(result.entries.some((entry) => entry.path === config.dataDir)).toBe(false);
    expect(result.ignored).toBe(1);
    await expect(browser.browse('root-0', config.dataDir)).rejects.toMatchObject({ statusCode: 403 });
    await expect(browser.browse('root-0', child)).rejects.toMatchObject({ statusCode: 403 });
    expect(() => browser.validatePaths([path.join(config.dataDir, 'proxy.mp4')])).toThrow('cache');
    expect((await browser.roots()).map((entry) => entry.available)).toEqual([true, false, false]);
  });

  it('rejects directory symlinks at every selected/root path component', async () => {
    const { root, sources, outside, config } = await setup();
    const nested = path.join(outside, 'nested'); await fs.mkdir(nested);
    const link = path.join(sources, 'linked'); await fs.symlink(outside, link);
    const parent = path.join(root, 'linked-parent'); await fs.symlink(outside, parent);
    const browser = new FootageBrowser(createConfig({ ...config, mediaRoots: [sources, path.join(parent, 'nested')] }));
    await expect(browser.browse('root-0', link)).rejects.toThrow('Symlinks');
    await expect(browser.browse('root-0', path.join(link, 'nested'))).rejects.toThrow('Symlinks');
    const roots = (await browser.roots()).map((entry) => footageRootSchema.parse(entry));
    expect(roots[1]).toMatchObject({ available: false, error: expect.stringContaining('Symlinks') });
    expect((await browser.browse('root-0')).entries).toEqual([]);
  });

  it('reports missing and non-directory roots without crashing service startup', async () => {
    const { root, sources, config } = await setup();
    const missing = path.join(root, 'disconnected'); const file = await source(sources);
    const service = await createApp(createConfig({ ...config, mediaRoots: [sources, missing, file] })); services.push(service);
    const response = await service.app.inject({ url: '/api/footage/roots', headers });
    expect(response.statusCode).toBe(200);
    const roots = response.json<{ roots: FootageRoot[] }>().roots.map((entry) => footageRootSchema.parse(entry));
    expect(roots).toEqual([
      { id: 'root-0', name: 'recordings', path: sources, available: true, error: null },
      { id: 'root-1', name: 'disconnected', path: missing, available: false, error: expect.stringContaining('missing') },
      { id: 'root-2', name: 'Clip 1.mp4', path: file, available: false, error: expect.stringContaining('directory') },
    ]);
    expect((await service.app.inject({ url: browseUrl('root-1'), headers })).statusCode).toBe(404);
    expect((await service.app.inject({ url: browseUrl('root-2'), headers })).statusCode).toBe(422);
    expect(service.jobs.list()).toEqual([]); expect(probeVideo).not.toHaveBeenCalled();
  });

  it.skipIf(process.getuid?.() === 0)('reports unreadable roots and denies browsing without changing their permissions', async () => {
    const { sources, config } = await setup();
    await setPermissions(sources, 0o000);
    const browser = new FootageBrowser(config);
    expect(await browser.roots()).toEqual([{ id: 'root-0', name: 'recordings', path: sources, available: false, error: expect.stringContaining('not readable') }]);
    await expect(browser.browse('root-0')).rejects.toMatchObject({ statusCode: 403 });
    expect((await fs.stat(sources)).mode & 0o777).toBe(0o000);
  });

  it('retains at most 2000 globally natural-sorted entries and explicitly signals truncation', async () => {
    const { sources, config } = await setup();
    await forEachSerial(Array.from({ length: MAX_FOOTAGE_ENTRIES }, (_, index) => MAX_FOOTAGE_ENTRIES - index), async (index) => {
      await fs.writeFile(path.join(sources, `Clip ${index}.mp4`), '');
    });
    const browser = new FootageBrowser(config);
    const exact = await browser.browse('root-0');
    expect(exact.entries).toHaveLength(MAX_FOOTAGE_ENTRIES); expect(exact.truncated).toBe(false);
    await source(sources, `Clip ${MAX_FOOTAGE_ENTRIES + 1}.mp4`);
    await source(sources, `Clip ${MAX_FOOTAGE_ENTRIES + 2}.mp4`);
    const folder = path.join(sources, 'Z directory'); await fs.mkdir(folder);
    await source(folder, 'not scanned.mp4');
    const capped = footageDirectorySchema.parse(await browser.browse('root-0'));
    expect(capped.entries).toHaveLength(MAX_FOOTAGE_ENTRIES);
    expect(capped).toMatchObject({ truncated: true, ignored: 0, warnings: [] });
    expect(capped.entries[0]).toMatchObject({ name: 'Z directory', kind: 'directory' });
    expect(capped.entries[1]!.name).toBe('Clip 1.mp4');
    expect(capped.entries.at(-1)!.name).toBe(`Clip ${MAX_FOOTAGE_ENTRIES - 1}.mp4`);
    expect(probeVideo).not.toHaveBeenCalled(); expect(runProcess).not.toHaveBeenCalled();
  });

  it('bounds warnings for entries that become unreadable during listing', async () => {
    const { sources, config } = await setup();
    await Promise.all(Array.from({ length: 30 }, (_, index) => source(sources, `Denied ${index}.mp4`)));
    const inspect = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((filename, options) => {
      if (String(filename).startsWith(`${sources}${path.sep}Denied `)) {
        return Promise.reject(Object.assign(new Error(`Permission denied: ${'x'.repeat(1000)}`), { code: 'EACCES' }));
      }
      return inspect(filename, options);
    });
    const result = await new FootageBrowser(config).browse('root-0');
    expect(result).toMatchObject({ entries: [], ignored: 30, truncated: false });
    expect(result.warnings).toHaveLength(20);
    expect(result.warnings.every((warning) => warning.length <= 512)).toBe(true);
    expect(result.warnings.at(-1)).toContain('omitted');
  });
});

describe('batch path prevalidation and serial no-copy registration', () => {
  it('validates every path before touching any source and rejects lexical scope/type/cache errors atomically', async () => {
    const { root, sources, outside, config } = await setup();
    const service = await createApp(createConfig({ ...config, mediaRoots: [root, sources] })); services.push(service);
    const valid = await source(sources);
    const fingerprint = vi.spyOn(files, 'fingerprintFile');
    const cases: [string, number][] = [
      [path.join(os.tmpdir(), 'not-approved', 'other.mp4'), 403], ['relative.mp4', 400],
      [`${sources}/../recordings/clip.mp4`, 400], [`${sources}/nul\0.mp4`, 400],
      [path.join(outside, 'sound.wav'), 400], [path.join(config.dataDir, 'proxy.mp4'), 403],
    ];
    await forEachSerial(cases, async ([invalid, status]) => {
      expect((await postPaths(service.app, [valid, invalid])).statusCode).toBe(status);
    });
    expect(fingerprint).not.toHaveBeenCalled(); expect(probeVideo).not.toHaveBeenCalled();
    expect(service.library.list()).toEqual([]); expect(service.jobs.list()).toEqual([]);
  });

  it('does not accept a sibling name sharing the approved-root prefix', async () => {
    const { sources, outside, app, library, jobs } = await serviceFixture();
    const valid = await source(sources); const escaped = await source(outside);
    expect((await postPaths(app, [valid, escaped])).statusCode).toBe(403);
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]);
  });

  it('rejects empty/oversized/non-string/non-JSON batches and strict-body extras', async () => {
    const { sources, app, library, jobs } = await serviceFixture();
    const filename = path.join(sources, 'clip.mp4');
    const bodies = [{}, { paths: [] }, { paths: filename }, { paths: [null] }, { paths: [1] }, { paths: [filename], copy: true }, { paths: Array(MAX_FOOTAGE_FILES + 1).fill(filename) }];
    await forEachSerial(bodies, async (payload) => {
      expect((await app.inject({ method: 'POST', url: '/api/media/register-paths', headers, payload })).statusCode).toBe(400);
    });
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]);
    const browser = new FootageBrowser(library.config);
    expect(browser.validatePaths(Array(MAX_FOOTAGE_FILES).fill(filename))).toHaveLength(MAX_FOOTAGE_FILES);
    expect(() => browser.validatePaths([])).toThrow('between 1');
    expect(() => browser.validatePaths(Array(MAX_FOOTAGE_FILES + 1).fill(filename))).toThrow('5000');
  });

  it('accepts files from multiple approved roots and case-insensitive recording extensions', async () => {
    const { sources, outside, config } = await setup();
    const service = await createApp(createConfig({ ...config, mediaRoots: [sources, outside] })); services.push(service);
    blockWorker(service.jobs);
    const paths = await Promise.all([source(sources, 'Camera 2.MP4'), source(outside, 'Camera 10.MOV'), source(sources, 'Camera 1.M4V')]);
    const response = await postPaths(service.app, paths);
    expect(response.statusCode).toBe(202);
    expect(response.json<ImportForEditingResult>()).toMatchObject({ added: 3, existing: 0, ignored: 0, errors: [], queueErrors: [] });
    expect(service.library.list().map((asset) => asset.sourcePath)).toEqual(paths);
    expect(service.jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(3);
    expect((await service.app.inject({ url: browseUrl('root-0', outside), headers })).statusCode).toBe(403);
  });

  it('serially reports missing/nonregular/symlink/probe failures without losing valid selections', async () => {
    const { sources, outside, app, library, jobs } = await serviceFixture();
    blockWorker(jobs);
    const first = await source(sources, 'First.mp4'); const last = await source(sources, 'Last.mov');
    const missing = path.join(sources, 'Missing.mp4'); const directory = path.join(sources, 'Directory.mp4'); await fs.mkdir(directory);
    const leaf = path.join(sources, 'Symlink.mp4'); await fs.symlink(first, leaf);
    const linkedParent = path.join(sources, 'Linked parent'); await fs.symlink(outside, linkedParent);
    const parent = path.join(linkedParent, 'Other.mp4'); await source(outside, 'Other.mp4');
    const rejected = await source(sources, 'Rejected.mp4');
    const seen: string[] = []; let active = 0; let maximum = 0;
    vi.mocked(probeVideo).mockImplementation(async (_config, filename) => {
      active++; maximum = Math.max(maximum, active); seen.push(filename);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (filename === rejected) throw new ServiceError('Unsupported timing.', 422);
        return metadata();
      } finally { active--; }
    });
    const response = await postPaths(app, [first, missing, directory, leaf, parent, rejected, last]);
    expect(response.statusCode).toBe(202);
    const imported = response.json<ImportForEditingResult>();
    expect(Object.keys(imported).sort()).toEqual(['added', 'assets', 'errors', 'existing', 'ignored', 'jobs', 'queueErrors']);
    expect(imported).toMatchObject({ added: 2, existing: 0, ignored: 0, queueErrors: [] });
    expect(imported.assets.map((asset) => asset.sourcePath)).toEqual([first, last]);
    expect(imported.errors.map((error) => error.path)).toEqual([missing, directory, leaf, parent, rejected]);
    expect(imported.errors[1]!.message).toContain('regular file');
    expect(imported.errors[2]!.message).toContain('Symlinks'); expect(imported.errors[3]!.message).toContain('Symlinks');
    expect(imported.errors[4]!.message).toBe('Unsupported timing.');
    expect(imported.jobs).toHaveLength(2); expect(maximum).toBe(1); expect(seen).toEqual([first, rejected, last]);
    expect(library.list()).toHaveLength(2); expect(runProcess).not.toHaveBeenCalled();
  });

  it('reports a recording removed or replaced by a symlink after browsing as a partial registration error', async () => {
    const { sources, app, library, jobs, config } = await serviceFixture();
    blockWorker(jobs);
    const valid = await source(sources, 'Valid.mp4');
    const removed = await source(sources, 'Removed.mp4'); const replaced = await source(sources, 'Replaced.mp4');
    const listing = await new FootageBrowser(config).browse('root-0'); expect(listing.entries).toHaveLength(3);
    await fs.rm(removed); await fs.rm(replaced); await fs.symlink(valid, replaced);
    const response = await postPaths(app, [removed, replaced, valid]);
    const result = response.json<ImportForEditingResult>();
    expect(response.statusCode).toBe(202); expect(result).toMatchObject({ added: 1, existing: 0, ignored: 0, queueErrors: [] });
    expect(result.errors.map((error) => error.path)).toEqual([removed, replaced]);
    expect(library.list().map((asset) => asset.sourcePath)).toEqual([valid]);
  });

  it('keeps registered assets when queue admission fails and never retries them implicitly', async () => {
    const { sources, app, library, jobs, config } = await serviceFixture();
    blockWorker(jobs);
    const first = await source(sources, 'First.mp4'); const second = await source(sources, 'Second.mp4');
    const submit = vi.spyOn(jobs, 'submit').mockImplementationOnce(() => { throw new ServiceError('Worker unavailable.', 503); });
    const response = await postPaths(app, [first, second]);
    expect(response.statusCode).toBe(202);
    const result = response.json<ImportForEditingResult>();
    expect(result).toMatchObject({ added: 2, existing: 0, errors: [], ignored: 0 });
    expect(result.queueErrors).toEqual([{ mediaId: result.assets[0]!.id, message: expect.stringContaining('Worker unavailable') }]);
    expect(result.assets.map((asset) => asset.status)).toEqual(['error', 'queued']);
    expect(result.jobs).toHaveLength(1);
    const saved = registrySchema.parse(JSON.parse(await fs.readFile(path.join(config.dataDir, 'library.json'), 'utf8')));
    expect(saved.assets).toEqual(library.list());
    const repeat = (await postPaths(app, [first, second])).json<ImportForEditingResult>();
    expect(repeat).toMatchObject({ added: 0, existing: 2, errors: [], queueErrors: [] });
    expect(repeat.jobs.map((job) => job.id)).toEqual(result.jobs.map((job) => job.id));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repeated paths/hard links and active jobs, then reuses ready proxies without work', async () => {
    const { sources, app, library, jobs } = await serviceFixture();
    const release = blockWorker(jobs);
    const original = await source(sources, 'Camera.MP4'); const alias = path.join(sources, 'Same.mov'); await fs.link(original, alias);
    const paths = [original, alias, original];
    const result = (await postPaths(app, paths)).json<ImportForEditingResult>();
    expect(result).toMatchObject({ added: 1, existing: 2, errors: [], ignored: 0, queueErrors: [] });
    expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(1);
    expect(result.assets.every((asset) => asset.sourcePath === original && asset.name === 'Camera.MP4')).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect((await postPaths(app, paths)).json<ImportForEditingResult>()).toMatchObject({ added: 0, existing: 3, jobs: result.jobs });
    release(); expect((await jobs.wait(result.jobs[0]!.id)).state).toBe('completed');
    const ready = library.get(result.assets[0]!.id); const proxy = await fs.readFile(library.proxyPath(ready));
    vi.mocked(probeVideo).mockClear(); vi.mocked(runProcess).mockClear();
    const repeated = (await postPaths(app, paths)).json<ImportForEditingResult>();
    expect(repeated).toEqual({ assets: [ready, ready, ready], errors: [], ignored: 0, added: 0, existing: 3, jobs: [], queueErrors: [] });
    expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
    expect(await fs.readFile(library.proxyPath(ready))).toEqual(proxy);
    expect(probeVideo).not.toHaveBeenCalled(); expect(runProcess).not.toHaveBeenCalled();
  });

  it('coalesces concurrent batches without overwriting queued state or adding duplicate workers', async () => {
    const { sources, library, jobs } = await libraryFixture();
    blockWorker(jobs);
    const filename = await source(sources);
    const results = await Promise.all([library.addFilesForEditing([filename]), library.addFilesForEditing([filename])]);
    expect(results.reduce((sum, result) => sum + result.added, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.existing, 0)).toBe(1);
    expect(results[0]!.jobs.map((job) => job.id)).toEqual(results[1]!.jobs.map((job) => job.id));
    expect(library.list()).toHaveLength(1); expect(library.list()[0]!.status).toBe('queued');
    expect(probeVideo).toHaveBeenCalledTimes(1); expect(jobs.list().filter((job) => job.kind === 'prepare')).toHaveLength(1);
  });

  it('prepares browser-selected originals beside a nested cache while preserving recursive-folder guards', async () => {
    const { root, config } = await setup();
    const service = await createApp(createConfig({ ...config, mediaRoots: [root] })); services.push(service);
    const filename = await source(root, 'Alongside cache.mp4');
    const listing = (await service.app.inject({ url: browseUrl('root-0'), headers })).json<FootageDirectory>();
    expect(listing.entries.map((entry) => entry.path)).toContain(filename);
    expect(listing.entries.map((entry) => entry.path)).not.toContain(config.dataDir);
    const response = await postPaths(service.app, [filename]);
    const result = response.json<ImportForEditingResult>();
    expect(response.statusCode).toBe(202); expect(result).toMatchObject({ added: 1, errors: [], queueErrors: [] });
    expect((await service.jobs.wait(result.jobs[0]!.id)).state).toBe('completed');
    await expect(service.library.importForEditing(root)).rejects.toThrow('cache must be outside');
    await expect(service.library.importFolder(root)).rejects.toThrow('cache must be outside');
  });

  it('reads readonly original files/folders without making imported-source or upload scratch copies', async () => {
    const { sources, config, app, library, jobs } = await serviceFixture();
    const filename = await source(sources);
    await setPermissions(filename, 0o444, 0o600); await setPermissions(sources, 0o555);
    const bytes = await fs.readFile(filename); const identity = await files.fingerprintFile(filename);
    const response = await postPaths(app, [filename]);
    expect(response.statusCode).toBe(202);
    const result = response.json<ImportForEditingResult>();
    expect(result.assets[0]).toMatchObject({ sourcePath: filename, fingerprint: identity, name: 'Clip 1.mp4' });
    expect((await jobs.wait(result.jobs[0]!.id)).state).toBe('completed');
    const served = await app.inject({ url: `/api/media/${result.assets[0]!.id}/source`, headers });
    expect(served.statusCode).toBe(200); expect(served.rawPayload).toEqual(bytes);
    expect(await files.fingerprintFile(filename)).toEqual(identity);
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o444);
    expect((await fs.stat(sources)).mode & 0o777).toBe(0o555);
    expect(await fs.readdir(sources)).toEqual(['Clip 1.mp4']);
    expect((await fs.readdir(config.dataDir)).sort()).toEqual(['assets', 'audio.json', 'library.json']);
    expect(library.get(result.assets[0]!.id).status).toBe('ready');
  });

  it('leaves deliberate folder/single-path/audio imports unrestricted, including with no approved roots', async () => {
    const { outside, config } = await setup();
    const service = await createApp(createConfig({ ...config, mediaRoots: [] })); services.push(service);
    blockWorker(service.jobs);
    const filename = await source(outside);
    expect((await service.app.inject({ url: '/api/footage/roots', headers })).json()).toEqual({ roots: [] });
    expect((await postPaths(service.app, [filename])).statusCode).toBe(403);
    const manual = await service.app.inject({ method: 'POST', url: '/api/media/import', headers, payload: { directory: outside } });
    expect(manual.statusCode).toBe(202); expect(manual.json<ImportForEditingResult>().added).toBe(1);
    expect((await service.app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } })).statusCode).toBe(202);
    const audio = vi.spyOn(service.audio, 'register').mockRejectedValue(new ServiceError('Explicit audio path reached the audio library.', 422));
    const audioPath = path.join(outside, 'music.wav');
    expect((await service.app.inject({ method: 'POST', url: '/api/audio/register', headers, payload: { path: audioPath } })).statusCode).toBe(422);
    expect(audio).toHaveBeenCalledWith(audioPath);
  });
});

describe('trusted JSON-only HTTP boundary and retained native registry entries', () => {
  it('refuses manual video imports from cache files/subfolders without weakening raw fixture or existing-source access', async () => {
    const { config, app, library, jobs } = await serviceFixture();
    const generated = path.join(config.dataDir, 'generated'); await fs.mkdir(generated);
    const filename = await source(generated, 'proxy.mp4'); const bytes = await fs.readFile(filename);
    expect((await app.inject({ method: 'POST', url: '/api/media/import', headers, payload: { directory: generated } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/media/register', headers, payload: { path: filename } })).statusCode).toBe(403);
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]); expect(probeVideo).not.toHaveBeenCalled();
    expect(await fs.readFile(filename)).toEqual(bytes);
  });

  it('keeps Host/Origin/fetch-site/client guards on the new routes', async () => {
    const { sources, app } = await serviceFixture();
    await forEachSerial([
      { host: 'evil.example' }, { host: headers.host, origin: 'https://evil.example' },
      { host: headers.host, 'sec-fetch-site': 'cross-site' },
    ], async (hostile) => {
      expect((await app.inject({ url: '/api/footage/roots', headers: hostile })).statusCode).toBe(403);
      expect((await app.inject({ url: browseUrl('root-0'), headers: hostile })).statusCode).toBe(403);
    });
    const filename = await source(sources);
    expect((await app.inject({ method: 'POST', url: '/api/media/register-paths', headers: { host: headers.host }, payload: { paths: [filename] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/media/register-paths', headers: { ...headers, origin: 'https://evil.example' }, payload: { paths: [filename] } })).statusCode).toBe(403);
    const response = await app.inject({ url: browseUrl('root-0'), headers });
    expect(response.statusCode).toBe(200); expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(footageDirectorySchema.parse(response.json())).toMatchObject({ rootId: 'root-0', directory: sources, parent: null });
  });

  it('validates browse queries, escaped paths, symlinks and nonexistent directories over HTTP', async () => {
    const { sources, outside, app } = await serviceFixture();
    const linked = path.join(sources, 'linked'); await fs.symlink(outside, linked);
    const cases: [string, number][] = [
      ['/api/footage', 400], ['/api/footage?rootId=root-0&unexpected=yes', 400],
      [browseUrl('root-9'), 404], [browseUrl('root-0', outside), 403],
      [browseUrl('root-0', `${sources}/../recordings-elsewhere`), 400],
      [browseUrl('root-0', linked), 422], [browseUrl('root-0', path.join(sources, 'missing')), 404],
    ];
    await forEachSerial(cases, async ([url, statusCode]) => {
      const response = await app.inject({ url, headers });
      expect(response.statusCode).toBe(statusCode); expect(response.json()).toEqual({ error: expect.any(String) });
    });
  });

  it('restores JSON parsing errors, the 1 MiB body limit and the 120-second timeout without multipart', async () => {
    const { app, config, library, jobs } = await serviceFixture();
    expect(app.server.requestTimeout).toBe(120_000);
    expect(app.hasContentTypeParser('multipart/form-data')).toBe(false);
    const invalid = await app.inject({ method: 'POST', url: '/api/media/register-paths', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"paths":' });
    expect(invalid.statusCode).toBe(400);
    const tooLarge = await app.inject({ method: 'POST', url: '/api/media/register-paths', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ paths: ['x'.repeat(1_048_576)] }) });
    expect(tooLarge.statusCode).toBe(413);
    const multipart = await app.inject({ method: 'POST', url: '/api/media/register-paths', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=removed' }, payload: '--removed--\r\n' });
    expect(multipart.statusCode).toBe(415);
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]); expect(await fs.readdir(config.dataDir)).toEqual(['audio.json']);
  });

  it('removes the upload route entirely and never creates copy scratch for rejected requests', async () => {
    const { app, config, library, jobs } = await serviceFixture();
    expect(app.hasRoute({ method: 'POST', url: '/api/media/upload' })).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/media/upload', headers, payload: {} })).statusCode).toBe(404);
    const multipart = await app.inject({ method: 'POST', url: '/api/media/upload', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=removed' }, payload: '--removed--\r\n' });
    expect([404, 415]).toContain(multipart.statusCode);
    expect(library.list()).toEqual([]); expect(jobs.list()).toEqual([]); expect(await fs.readdir(config.dataDir)).toEqual(['audio.json']);
  });

  it('preserves an already registered extensionless copied source, verified proxy and exact bytes across restart', async () => {
    const { root, config } = await setup();
    const directory = path.join(config.dataDir, 'imported-sources', 'a'.repeat(64)); await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'source'); const original = Buffer.from('seeded retained original: never delete or migrate');
    await fs.writeFile(filename, original);
    const fingerprint = await files.fingerprintFile(filename);
    const asset = mediaAssetSchema.parse({ id: `media-${fingerprint.digest.slice(0, 32)}`, name: 'Old recording.MP4', sourcePath: filename, fingerprint, metadata: metadata(), status: 'ready', error: null, prepared: prepared() });
    const proxyDirectory = path.join(config.dataDir, 'assets', fingerprint.digest, PROXY_PROFILE); await fs.mkdir(proxyDirectory, { recursive: true });
    const proxy = Buffer.from('seeded verified proxy: exact bytes retained'); await fs.writeFile(path.join(proxyDirectory, 'proxy.mp4'), proxy);
    const registry = `${JSON.stringify({ version: 1, assets: [asset] })}\n`; await fs.writeFile(path.join(config.dataDir, 'library.json'), registry);
    await setPermissions(filename, 0o444, 0o600); await setPermissions(directory, 0o555);
    const serviceConfig = createConfig({ ...config, mediaRoots: [root] });
    const first = await createApp(serviceConfig); services.push(first);
    expect(first.library.get(asset.id)).toEqual(asset); expect(first.jobs.list()).toEqual([]);
    expect((await postPaths(first.app, [filename])).statusCode).toBe(403);
    const served = await first.app.inject({ url: `/api/media/${asset.id}/source`, headers });
    expect(served.statusCode).toBe(200); expect(served.rawPayload).toEqual(original);
    const cached = await first.app.inject({ url: `/api/media/${asset.id}/proxy`, headers });
    expect(cached.statusCode).toBe(200); expect(cached.rawPayload).toEqual(proxy);
    await first.app.close();
    const restarted = await createApp(serviceConfig); services.push(restarted);
    expect(restarted.library.get(asset.id)).toEqual(asset); expect(restarted.jobs.list()).toEqual([]);
    expect((await restarted.app.inject({ url: `/api/media/${asset.id}/source`, headers })).rawPayload).toEqual(original);
    expect((await restarted.app.inject({ url: `/api/media/${asset.id}/proxy`, headers })).rawPayload).toEqual(proxy);
    expect(await files.fingerprintFile(filename)).toEqual(fingerprint);
    expect(await fs.readFile(path.join(config.dataDir, 'library.json'), 'utf8')).toBe(registry);
    expect(probeVideo).not.toHaveBeenCalled(); expect(runProcess).not.toHaveBeenCalled();
  });
});