import { expect, test, type Locator, type Page } from '@playwright/test';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { AudioDirectory, FootageDirectory, FootageRoot } from '../../src/shared/footage.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let ready: MediaAsset;
let song: AudioAsset;
const originalPath = path.resolve('.pascap/browser-footage/synthetic-sources/browse-camera-1.mp4');
const fixtureCache = path.resolve('.pascap/browser-tests');
const root: FootageRoot = {
  id: 'root-0',
  name: 'Approved recordings',
  path: '/approved',
  available: true,
  error: null,
};
const audioJob: MediaJob = {
  id: 'import-dialog-audio',
  kind: 'audio',
  label: 'Synthetic music',
  state: 'completed',
  progress: 1,
  message: 'Prepared synthetic fixture reused',
  createdAt: '2026-10-14T10:00:00Z',
  finishedAt: '2026-10-14T10:00:01Z',
  outputUrl: null,
  receiptUrl: null,
};

test.beforeEach(async ({ page, request }) => {
  const { assets } = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  ready = assets.find((asset) => asset.name === 'pattern-a.mp4')!;
  const audio = (await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] };
  song = audio.assets.find((asset) => asset.name === 'test-music.wav')!;
  memory = await memoryProjects(page, {
    ...createProject('no-copy-browser', 'Originals in place · memory-only'),
    revision: 1,
  });
  await page.goto('/?project=no-copy-browser');
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(
    'Originals in place · memory-only',
  );
});

function trigger(page: Page): Locator {
  return page.locator('.media-panel .panel-heading').getByRole('button', { name: 'Import media', exact: true });
}

async function openImport(page: Page): Promise<Locator> {
  await trigger(page).click();
  const dialog = page.getByRole('dialog', { name: 'Import media', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

function directory(
  entries: FootageDirectory['entries'],
  selected = '/approved',
  parent: string | null = null,
  rootId = 'root-0',
): FootageDirectory {
  return { rootId, directory: selected, parent, entries, ignored: 0, truncated: false, warnings: [] };
}

type Listing = (url: URL) => FootageDirectory | Promise<FootageDirectory>;

/** Mocks both metadata listings the dialog merges; music entries default to none. */
async function mockBrowsing(
  page: Page,
  videos: FootageDirectory | Listing,
  roots: readonly FootageRoot[] = [root],
  music: (url: URL) => AudioDirectory['entries'] = () => [],
): Promise<void> {
  const list = typeof videos === 'function' ? videos : () => videos;
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots } }));
  await page.route(/\/api\/footage\?/, async (route) => {
    const listing = await list(new URL(route.request().url()));
    await route.fulfill({ json: listing }).catch(() => {
      /* An aborted read may no longer have a route. */
    });
  });
  await page.route(/\/api\/audio\/browse\?/, (route) => {
    const url = new URL(route.request().url());
    const audio: AudioDirectory = {
      ...directory([], url.searchParams.get('directory') ?? '/approved', null, url.searchParams.get('rootId')!),
      entries: music(url),
    };
    return route.fulfill({ json: audio });
  });
}

function postCount(page: Page): () => number {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  return () => posts;
}

async function externalDrop(page: Page, selector: string): Promise<void> {
  const bounds = (await page.locator(selector).boundingBox())!;
  const session = await page.context().newCDPSession(page);
  const data = { items: [], files: [originalPath], dragOperationsMask: 1 };
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: bounds.x + 25, y: bounds.y + 25, data });
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: bounds.x + 25, y: bounds.y + 25, data });
  await session.send('Input.dispatchDragEvent', { type: 'drop', x: bounds.x + 25, y: bounds.y + 25, data });
  await session.detach();
}

test('browse and import original paths, prepare verified proxies, persist project membership and reuse ready work without copying', async ({
  page,
}) => {
  const before = await stat(originalPath);
  const sourceNames = await readdir(path.dirname(originalPath));
  const writes: { url: string; body: unknown; type: string | undefined }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST')
      writes.push({
        url: new URL(request.url()).pathname,
        body: request.postDataJSON(),
        type: request.headers()['content-type'],
      });
  });
  let dialog = await openImport(page);
  const checkbox = dialog.getByRole('checkbox', { name: 'Select browse-camera-1.mp4', exact: true });
  await expect(checkbox).toBeVisible();
  expect(writes).toEqual([]);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await checkbox.check();
  await expect(dialog.locator('.import-selection')).toHaveText('1 video recording selected');
  expect(writes).toEqual([]);
  const accepted = page.waitForResponse((response) => response.url().endsWith('/api/media/register-paths'));
  await dialog.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const result = (await response.json()) as { assets: MediaAsset[]; jobs: unknown[]; added: number; existing: number };
  const asset = result.assets[0]!;
  expect(asset.sourcePath).toBe(originalPath);
  expect(writes).toEqual([
    { url: '/api/media/register-paths', body: { paths: [originalPath] }, type: 'application/json' },
  ]);
  expect(result.added + result.existing).toBe(1);
  // A complete import closes the dialog and returns focus to its trigger.
  await expect(dialog).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(page.getByRole('button', { name: `Add ${asset.name} to timeline`, exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([asset.id]);
  expect(memory.snapshot().clips).toEqual([]);
  await page.reload();
  await expect(page.locator('.media-item')).toHaveCount(1);
  dialog = await openImport(page);
  const repeated = page.waitForResponse((reply) => reply.url().endsWith('/api/media/register-paths'));
  // Double-clicking a recording imports just that one, like a native file dialog.
  await dialog.getByText('browse-camera-1.mp4', { exact: true }).dblclick();
  expect(await (await repeated).json()).toMatchObject({ added: 0, existing: 1, jobs: [] });
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: `Add ${asset.name} to timeline`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().status)).toBe('paused');
  const after = await stat(originalPath);
  expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
  expect(await readdir(path.dirname(originalPath))).toEqual(sourceNames);
  const cacheFiles = await readdir(fixtureCache);
  expect(cacheFiles).not.toContain('imported-sources');
  expect(cacheFiles).not.toContain('uploads');
});

test('one folder view lists folders, video and music recordings; filters and selection send paths only and never import on browse', async ({
  page,
}) => {
  const posts: { pathname: string; body: unknown }[] = [];
  const initial = directory([
    { kind: 'directory', name: 'Flight 2', path: '/approved/Flight 2', size: null },
    { kind: 'video', name: 'Clip 2.mp4', path: '/approved/Clip 2.mp4', size: 250 * 1024 ** 2 },
    { kind: 'video', name: 'Clip 10.MOV', path: '/approved/Clip 10.MOV', size: 600 * 1024 ** 2 },
  ]);
  const nested = directory(
    [{ kind: 'video', name: 'Other.MP4', path: '/approved/Flight 2/Other.MP4', size: 100 }],
    '/approved/Flight 2',
    '/approved',
  );
  await mockBrowsing(
    page,
    (url) => (url.searchParams.get('directory') === nested.directory ? nested : initial),
    [root],
    (url) =>
      url.searchParams.get('directory') === nested.directory
        ? []
        : [{ kind: 'audio', name: 'Theme.mp3', path: '/approved/Theme.mp3', size: 5 * 1024 ** 2 }],
  );
  page.on('request', (request) => {
    if (request.method() === 'POST')
      posts.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.route('**/api/media/register-paths', (route) =>
    route.fulfill({
      status: 202,
      json: { assets: [ready], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] },
    }),
  );
  await page.route('**/api/audio/register-selected', (route) =>
    route.fulfill({ status: 202, json: { asset: song, job: audioJob } }),
  );
  const dialog = await openImport(page);
  const entries = dialog.getByRole('list', { name: 'Folders and recordings' }).locator('li');
  await expect(dialog.getByRole('button', { name: 'Up one folder' })).toBeDisabled();
  await expect(entries).toHaveText([
    'Flight 2Folder›',
    'Clip 2.mp4Video250 MB',
    'Clip 10.MOVVideo600 MB',
    'Theme.mp3Music5 MB',
  ]);
  await dialog.getByRole('button', { name: 'Music', exact: true }).click();
  await expect(entries).toHaveText(['Flight 2Folder›', 'Theme.mp3Music5 MB']);
  await dialog.getByRole('button', { name: 'Video', exact: true }).click();
  await expect(entries).toHaveCount(3);
  await dialog.getByRole('button', { name: 'All', exact: true }).click();
  await dialog.getByRole('searchbox', { name: 'Filter this folder' }).fill('Clip 2');
  await dialog.getByRole('checkbox', { name: 'Select all recordings in this folder' }).check();
  await dialog.getByRole('searchbox', { name: 'Filter this folder' }).fill('');
  await dialog.getByRole('button', { name: 'Open folder Flight 2' }).click();
  await expect(dialog.getByRole('navigation', { name: 'Folder path' })).toHaveText('Approved recordingsFlight 2');
  await dialog.getByRole('checkbox', { name: 'Select Other.MP4' }).check();
  await expect(dialog.locator('.import-selection')).toHaveText('2 video recordings selected');
  await dialog
    .getByRole('navigation', { name: 'Folder path' })
    .getByRole('button', { name: 'Approved recordings' })
    .click();
  await expect(dialog.getByRole('checkbox', { name: 'Select Clip 2.mp4' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Select Theme.mp3' }).check();
  await expect(dialog.locator('.import-selection')).toHaveText('2 video recordings and 1 music recording selected');
  expect(posts).toEqual([]);
  await dialog.getByRole('button', { name: 'Import selected recordings' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toEqual([
    {
      pathname: '/api/media/register-paths',
      body: { paths: ['/approved/Clip 2.mp4', '/approved/Flight 2/Other.MP4'] },
    },
    { pathname: '/api/audio/register-selected', body: { path: '/approved/Theme.mp3' } },
  ]);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media).toEqual({ videoIds: [ready.id], audioIds: [song.id] });
  expect(memory.snapshot().music).toEqual([]);
});

test('Shift-click selects and deselects a range of recordings, with the Import button always visible', async ({
  page,
}) => {
  const names = ['A.mp4', 'B.mp4', 'C.mp4', 'D.mp4', 'E.mp4', 'F.mp4', 'G.mp4', 'H.mp4', 'I.mp4', 'J.mp4'];
  await mockBrowsing(
    page,
    directory(names.map((name) => ({ kind: 'video', name, path: `/approved/${name}`, size: 1024 ** 2 }))),
  );
  const dialog = await openImport(page);
  const box = (name: string) => dialog.getByRole('checkbox', { name: `Select ${name}` });
  const summary = dialog.locator('.import-selection');
  await box('B.mp4').click();
  await box('E.mp4').click({ modifiers: ['Shift'] });
  await expect(summary).toHaveText('4 video recordings selected');
  await box('J.mp4').click({ modifiers: ['Shift'] });
  await expect(summary).toHaveText('9 video recordings selected');
  await box('G.mp4').click({ modifiers: ['Shift'] });
  await expect(summary).toHaveText('5 video recordings selected');
  await expect(box('H.mp4')).not.toBeChecked();
  await expect(box('G.mp4')).not.toBeChecked();
  await expect(box('F.mp4')).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Import selected recordings' })).toBeInViewport({ ratio: 1 });

  // Clicking the file name (the row label) range-selects too.
  await dialog.getByText('H.mp4', { exact: true }).click();
  await dialog.getByText('J.mp4', { exact: true }).click({ modifiers: ['Shift'] });
  await expect(summary).toHaveText('8 video recordings selected');
  await expect(box('I.mp4')).toBeChecked();
});

test('partial registration and queue failures keep accepted sources, report the rest and keep rejected recordings selected', async ({
  page,
}) => {
  let posts = 0;
  await mockBrowsing(
    page,
    directory([
      { kind: 'video', name: 'Good.mp4', path: '/approved/Good.mp4', size: 400 },
      { kind: 'video', name: 'Missing.mov', path: '/approved/Missing.mov', size: 300 },
    ]),
  );
  await page.route('**/api/media/register-paths', async (route) => {
    posts++;
    await route.fulfill({
      status: 202,
      json: {
        assets: [ready],
        errors: [{ path: '/approved/Missing.mov', message: 'Original is disconnected.' }],
        ignored: 0,
        added: 1,
        existing: 0,
        jobs: [],
        queueErrors: [{ mediaId: ready.id, message: 'Worker busy. Retry explicitly.' }],
      },
    });
  });
  const dialog = await openImport(page);
  await dialog.getByRole('checkbox', { name: 'Select all recordings in this folder' }).check();
  await dialog.getByRole('button', { name: 'Import selected recordings' }).click();
  const report = dialog.getByRole('region', { name: 'Import results' });
  await expect(report).toContainText('Imported 1 video recording');
  await expect(report).toContainText('Missing.mov: Original is disconnected');
  await expect(report).toContainText('Not queued: pattern-a.mp4: Worker busy');
  await expect(dialog.getByRole('checkbox', { name: 'Select Missing.mov' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Select Good.mp4' })).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([ready.id]);
  expect(memory.snapshot().clips).toEqual([]);
  expect(posts).toBe(1);
});

test('failed registration keeps selections and the current project without retrying or closing the dialog', async ({
  page,
}) => {
  let posts = 0;
  await mockBrowsing(
    page,
    directory([{ kind: 'video', name: 'Original.mp4', path: '/approved/Original.mp4', size: 300 }]),
  );
  await page.route('**/api/media/register-paths', async (route) => {
    posts++;
    await route.fulfill({
      status: 503,
      json: { error: 'Cannot read originals right now. Mount the drive and retry.' },
    });
  });
  const dialog = await openImport(page);
  await dialog.getByRole('checkbox', { name: 'Select Original.mp4' }).check();
  await dialog.getByRole('button', { name: 'Import selected recordings' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Mount the drive');
  await expect(dialog.getByRole('region', { name: 'Import results' })).toContainText(
    '1 video recording was not imported',
  );
  await expect(dialog.getByRole('checkbox', { name: 'Select Original.mp4' })).toBeChecked();
  expect(posts).toBe(1);
  expect(memory.snapshot().media.videoIds).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(trigger(page)).toBeFocused();
});

test('a typed path imports a recording or a folder outside the locations, through its own unrestricted endpoint', async ({
  page,
}) => {
  const posts: { pathname: string; body: unknown }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST')
      posts.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await page.route('**/api/media/register', (route) =>
    route.fulfill({ status: 202, json: { asset: ready, job: null } }),
  );
  await page.route('**/api/media/import', (route) =>
    route.fulfill({
      status: 202,
      json: { assets: [], errors: [], ignored: 4, added: 0, existing: 0, jobs: [], queueErrors: [] },
    }),
  );
  let dialog = await openImport(page);
  await dialog.getByText('Other location', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'File or folder path' }).fill('/outside/Flight/DJI_0001.MP4');
  await dialog.getByRole('button', { name: 'Import path', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  dialog = await openImport(page);
  await dialog.getByText('Other location', { exact: true }).click();
  await dialog.getByRole('textbox', { name: 'File or folder path' }).fill('/outside/Empty folder');
  await dialog.getByRole('button', { name: 'Import path', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Import results' })).toContainText(
    'No video recordings found in /outside/Empty folder',
  );
  expect(posts).toEqual([
    { pathname: '/api/media/register', body: { path: '/outside/Flight/DJI_0001.MP4' } },
    { pathname: '/api/media/import', body: { directory: '/outside/Empty folder' } },
  ]);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([ready.id]);
});

test('unavailable locations explain configuration and open the typed-path form', async ({ page }) => {
  const unavailable = { ...root, available: false, error: 'Drive disconnected.' };
  await mockBrowsing(page, directory([]), [unavailable]);
  const dialog = await openImport(page);
  await expect(dialog.getByText('No media locations are available', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('PASCAP_MEDIA_ROOTS');
  await expect(dialog).toContainText('Drive disconnected');
  await expect(
    dialog.getByRole('navigation', { name: 'Media locations' }).getByRole('button', { name: 'Approved recordings' }),
  ).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Import selected recordings' })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: 'File or folder path' })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test('read failures refresh only metadata and can recover without starting an import', async ({ page }) => {
  let reads = 0;
  const posts = postCount(page);
  await mockBrowsing(
    page,
    directory([{ kind: 'video', name: 'Recovered.mp4', path: '/approved/Recovered.mp4', size: 50 }]),
  );
  await page.route('**/api/footage/roots', async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({ status: 503, json: { error: 'Footage service is temporarily unavailable.' } });
    else await route.fulfill({ json: { roots: [root] } });
  });
  const dialog = await openImport(page);
  await expect(dialog.getByRole('alert')).toContainText('temporarily unavailable');
  await dialog.getByRole('button', { name: 'Refresh folder' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Select Recovered.mp4' })).toBeVisible();
  expect(reads).toBe(2);
  expect(posts()).toBe(0);
  expect(memory.saves).toBe(0);
});

test('changing locations discards stale reads and clears selections from the previous location', async ({ page }) => {
  const second: FootageRoot = { ...root, id: 'root-1', name: 'Other drive', path: '/other' };
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await mockBrowsing(
    page,
    async (url) => {
      if (url.searchParams.get('rootId') === 'root-0') {
        started();
        await delayed;
        return directory([{ kind: 'video', name: 'Stale.mp4', path: '/approved/Stale.mp4', size: 20 }]);
      }
      return directory(
        [{ kind: 'video', name: 'Current.mp4', path: '/other/Current.mp4', size: 30 }],
        '/other',
        null,
        'root-1',
      );
    },
    [root, second],
  );
  const dialog = await openImport(page);
  const places = dialog.getByRole('navigation', { name: 'Media locations' });
  try {
    await loading;
    await places.getByRole('button', { name: 'Other drive' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Select Current.mp4' })).toBeVisible();
    release();
    await expect(dialog.getByRole('checkbox', { name: 'Select Stale.mp4' })).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: 'Select Current.mp4' }).check();
    await places.getByRole('button', { name: 'Approved recordings' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Select Stale.mp4' })).toBeVisible();
    await expect(dialog.locator('.import-selection')).toHaveText('Select recordings, or double-click one to import it');
  } finally {
    release();
  }
});

test('filesystem drops are rejected without any upload, optional copy picker or browser navigation', async ({
  page,
}) => {
  const posts = postCount(page);
  await externalDrop(page, '.media-panel');
  await expect(page.getByRole('alert')).toContainText('Dropping files is not supported');
  await expect(page.locator('.media-file-drop')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss file import error' }).click();
  await externalDrop(page, '.preview-column');
  await expect(page).toHaveURL(/project=no-copy-browser/);
  await openImport(page);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(posts()).toBe(0);
  expect(memory.snapshot().media.videoIds).toEqual([]);
});

test('listing truncation and per-entry warnings are explicit and browsing remains read-only', async ({ page }) => {
  const posts = postCount(page);
  await mockBrowsing(page, {
    ...directory([]),
    truncated: true,
    ignored: 3,
    warnings: ['Cannot inspect disconnected folder.'],
  });
  const dialog = await openImport(page);
  await expect(dialog).toContainText('too many entries');
  await dialog.getByText('Some entries could not be read', { exact: true }).click();
  await expect(dialog).toContainText('Cannot inspect disconnected folder');
  expect(posts()).toBe(0);
  expect(memory.saves).toBe(0);
});

test('the import dialog fits the minimum viewport without horizontal overflow', async ({ page }) => {
  await mockBrowsing(
    page,
    directory([
      {
        kind: 'video',
        name: 'A very long footage filename with spaces that keeps going and going.mp4',
        path: '/approved/A very long footage filename with spaces that keeps going and going.mp4',
        size: 500 * 1024 ** 2,
      },
    ]),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  const dialog = await openImport(page);
  await expect(
    dialog.getByRole('checkbox', {
      name: 'Select A very long footage filename with spaces that keeps going and going.mp4',
    }),
  ).toBeVisible();
  await dialog.getByText('Other location', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Import path', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Import selected recordings', exact: true })).toBeInViewport();
});
