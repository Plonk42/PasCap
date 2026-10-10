import { expect, test, type Page } from '@playwright/test';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FootageDirectory, FootageRoot } from '../../src/shared/footage.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let ready: MediaAsset;
const originalPath = path.resolve('.pascap/browser-footage/synthetic-sources/browse-camera-1.mp4');
const fixtureCache = path.resolve('.pascap/browser-tests');
const root: FootageRoot = {
  id: 'root-0',
  name: 'Approved recordings',
  path: '/approved',
  available: true,
  error: null,
};

test.beforeEach(async ({ page, request }) => {
  const { assets } = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  ready = assets.find((asset) => asset.name === 'pattern-a.mp4')!;
  memory = await memoryProjects(page, {
    ...createProject('no-copy-browser', 'Originals in place · memory-only'),
    revision: 1,
  });
  await page.goto('/?project=no-copy-browser');
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(
    'Originals in place · memory-only',
  );
});

async function openImport(page: Page): Promise<void> {
  await page.locator('button[aria-label="Import folder"]').click();
  await expect(page.getByRole('dialog', { name: 'Import recordings', exact: true })).toBeVisible();
}

function directory(
  entries: FootageDirectory['entries'],
  selected = '/approved',
  parent: string | null = null,
  rootId = 'root-0',
): FootageDirectory {
  return { rootId, directory: selected, parent, entries, ignored: 0, truncated: false, warnings: [] };
}

async function mockDirectory(
  page: Page,
  listing: FootageDirectory,
  roots: readonly FootageRoot[] = [root],
): Promise<void> {
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots } }));
  await page.route(/\/api\/footage\?/, (route) => route.fulfill({ json: listing }));
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

test('browse and register original paths, prepare verified proxies, persist project membership and reuse ready work without copying', async ({
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
  await openImport(page);
  const checkbox = page.getByRole('checkbox', { name: 'Select recording browse-camera-1.mp4', exact: true });
  await expect(checkbox).toBeVisible();
  expect(writes).toEqual([]);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await checkbox.check();
  expect(writes).toEqual([]);
  const accepted = page.waitForResponse((response) => response.url().endsWith('/api/media/register-paths'));
  await page.getByRole('button', { name: 'Register selected recordings', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const result = (await response.json()) as { assets: MediaAsset[]; jobs: unknown[]; added: number; existing: number };
  const asset = result.assets[0]!;
  expect(asset.sourcePath).toBe(originalPath);
  expect(writes).toEqual([
    { url: '/api/media/register-paths', body: { paths: [originalPath] }, type: 'application/json' },
  ]);
  expect(result.added + result.existing).toBe(1);
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText(
    `${result.added} recordings registered`,
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: `Add ${asset.name} to timeline`, exact: true })).toBeEnabled({
    timeout: 20_000,
  });
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([asset.id]);
  expect(memory.snapshot().clips).toEqual([]);
  await page.reload();
  await expect(page.locator('.media-item')).toHaveCount(1);
  await openImport(page);
  await checkbox.check();
  const repeated = page.waitForResponse((reply) => reply.url().endsWith('/api/media/register-paths'));
  await page.getByRole('button', { name: 'Register selected recordings', exact: true }).click();
  expect(await (await repeated).json()).toMatchObject({ added: 0, existing: 1, jobs: [] });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: `Add ${asset.name} to timeline`, exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().status)).toBe('paused');
  const after = await stat(originalPath);
  expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
  expect(await readdir(path.dirname(originalPath))).toEqual(sourceNames);
  const cacheFiles = await readdir(fixtureCache);
  expect(cacheFiles).not.toContain('imported-sources');
  expect(cacheFiles).not.toContain('uploads');
});

test('navigation, natural names, filtering and selection send paths only and never import on browse', async ({
  page,
}) => {
  let posts = 0;
  let sent: unknown;
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
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots: [root] } }));
  await page.route(/\/api\/footage\?/, (route) =>
    route.fulfill({
      json: new URL(route.request().url()).searchParams.get('directory') === nested.directory ? nested : initial,
    }),
  );
  await page.route('**/api/media/register-paths', async (route) => {
    posts++;
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      json: { assets: [ready], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] },
    });
  });
  await openImport(page);
  await expect(page.getByRole('button', { name: 'Up one recording folder' })).toBeDisabled();
  await expect(page.getByRole('list', { name: 'Recording entries' }).locator('li')).toHaveText([
    'Flight 2›',
    'Clip 2.mp4250 MiB',
    'Clip 10.MOV600 MiB',
  ]);
  await page.getByRole('searchbox', { name: 'Search recordings' }).fill('Clip 2');
  await page.getByRole('checkbox', { name: 'Select visible original recordings' }).check();
  await page.getByRole('searchbox', { name: 'Search recordings' }).fill('');
  await page.getByRole('button', { name: 'Open recording folder Flight 2' }).click();
  await page.getByRole('checkbox', { name: 'Select recording Other.MP4' }).check();
  await expect(page.locator('.footage-registration')).toContainText('2 selected');
  expect(posts).toBe(0);
  await page.getByRole('button', { name: 'Up one recording folder' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select recording Clip 2.mp4' })).toBeChecked();
  await page.getByRole('button', { name: 'Register selected recordings' }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toBeVisible();
  expect(sent).toEqual({ paths: ['/approved/Clip 2.mp4', '/approved/Flight 2/Other.MP4'] });
  expect(posts).toBe(1);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([ready.id]);
});

test('Shift-click selects and deselects a range of recordings, with the registration bar always visible', async ({
  page,
}) => {
  const names = ['A.mp4', 'B.mp4', 'C.mp4', 'D.mp4', 'E.mp4', 'F.mp4', 'G.mp4', 'H.mp4', 'I.mp4', 'J.mp4'];
  const listing = directory(names.map((name) => ({ kind: 'video', name, path: `/approved/${name}`, size: 1024 ** 2 })));
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots: [root] } }));
  await page.route(/\/api\/footage\?/, (route) => route.fulfill({ json: listing }));
  await openImport(page);
  const box = (name: string) => page.getByRole('checkbox', { name: `Select recording ${name}` });
  await box('B.mp4').click();
  await box('E.mp4').click({ modifiers: ['Shift'] });
  await expect(page.locator('.footage-registration')).toContainText('4 selected');
  await box('J.mp4').click({ modifiers: ['Shift'] });
  await expect(page.locator('.footage-registration')).toContainText('9 selected');
  await box('G.mp4').click({ modifiers: ['Shift'] });
  await expect(page.locator('.footage-registration')).toContainText('5 selected');
  await expect(box('H.mp4')).not.toBeChecked();
  await expect(box('G.mp4')).not.toBeChecked();
  await expect(box('F.mp4')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Register selected recordings' })).toBeInViewport({ ratio: 1 });
});

test('partial registration and queue failures preserve accepted sources and report missing originals without a hidden retry', async ({
  page,
}) => {
  let posts = 0;
  await mockDirectory(
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
  await openImport(page);
  await page.getByRole('checkbox', { name: 'Select visible original recordings' }).check();
  await page.getByRole('button', { name: 'Register selected recordings' }).click();
  const report = page.getByRole('region', { name: 'Import results' });
  await expect(report).toContainText('1 recordings registered');
  await expect(report).toContainText('1 files rejected');
  await page.getByText('Rejected files', { exact: true }).click();
  await expect(report).toContainText('Missing.mov: Original is disconnected');
  await page.getByText('Proxy queue issues', { exact: true }).click();
  await expect(report).toContainText('Worker busy');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.videoIds).toEqual([ready.id]);
  expect(memory.snapshot().clips).toEqual([]);
  expect(posts).toBe(1);
});

test('failed registration keeps selections and the current project without retrying or closing the dialog', async ({
  page,
}) => {
  let posts = 0;
  await mockDirectory(
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
  await openImport(page);
  await page.getByRole('checkbox', { name: 'Select recording Original.mp4' }).check();
  await page.getByRole('button', { name: 'Register selected recordings' }).click();
  const modal = page.getByRole('dialog', { name: 'Import recordings' });
  await expect(modal.getByRole('alert')).toContainText('Mount the drive');
  await expect(page.getByRole('checkbox', { name: 'Select recording Original.mp4' })).toBeChecked();
  expect(posts).toBe(1);
  expect(memory.snapshot().media.videoIds).toEqual([]);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('button[aria-label="Import folder"]')).toBeFocused();
});

test('empty and unavailable approved roots explain configuration and retain the explicit no-copy folder form', async ({
  page,
}) => {
  const unavailable = { ...root, available: false, error: 'Drive disconnected.' };
  await mockDirectory(page, directory([]), [unavailable]);
  await openImport(page);
  await expect(page.getByText('No readable recording locations', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Browse original recordings' })).toContainText('PASCAP_MEDIA_ROOTS');
  await expect(page.getByRole('region', { name: 'Browse original recordings' })).toContainText('Drive disconnected');
  await expect(page.getByRole('button', { name: 'Register selected recordings' })).toBeDisabled();
  await page.getByText('Import a whole folder by path', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Absolute folder path on this machine' })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test('read failures refresh only metadata and can recover without starting an import', async ({ page }) => {
  let reads = 0;
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await page.route('**/api/footage/roots', async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({ status: 503, json: { error: 'Footage service is temporarily unavailable.' } });
    else await route.fulfill({ json: { roots: [root] } });
  });
  await page.route(/\/api\/footage\?/, (route) =>
    route.fulfill({
      json: directory([{ kind: 'video', name: 'Recovered.mp4', path: '/approved/Recovered.mp4', size: 50 }]),
    }),
  );
  await openImport(page);
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await page.getByRole('button', { name: 'Refresh recording locations' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select recording Recovered.mp4' })).toBeVisible();
  expect(reads).toBe(2);
  expect(posts).toBe(0);
  expect(memory.saves).toBe(0);
});

test('changing roots discards stale reads and clears selections from the previous location', async ({ page }) => {
  const second: FootageRoot = { ...root, id: 'root-1', name: 'Other drive', path: '/other' };
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots: [root, second] } }));
  await page.route(/\/api\/footage\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('rootId') === 'root-0') {
      started();
      await delayed;
      await route
        .fulfill({ json: directory([{ kind: 'video', name: 'Stale.mp4', path: '/approved/Stale.mp4', size: 20 }]) })
        .catch(() => {});
    } else
      await route.fulfill({
        json: directory(
          [{ kind: 'video', name: 'Current.mp4', path: '/other/Current.mp4', size: 30 }],
          '/other',
          null,
          'root-1',
        ),
      });
  });
  await openImport(page);
  await loading;
  await page.getByRole('combobox', { name: 'Recording location' }).selectOption('root-1');
  await expect(page.getByRole('checkbox', { name: 'Select recording Current.mp4' })).toBeVisible();
  release();
  await expect(page.getByRole('checkbox', { name: 'Select recording Stale.mp4' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select recording Current.mp4' }).check();
  await page.getByRole('combobox', { name: 'Recording location' }).selectOption('root-0');
  await expect(page.getByRole('checkbox', { name: 'Select recording Stale.mp4' })).toBeVisible();
  await expect(page.locator('.footage-registration')).toContainText('0 selected');
});

test('filesystem drops are rejected without any upload, optional copy picker or browser navigation', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await externalDrop(page, '.media-panel');
  await expect(page.getByRole('alert')).toContainText('Filesystem drops are disabled');
  await expect(page.locator('.media-file-drop')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss file import error' }).click();
  await externalDrop(page, '.preview-column');
  await expect(page).toHaveURL(/project=no-copy-browser/);
  await openImport(page);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose recording files' })).toHaveCount(0);
  expect(posts).toBe(0);
  expect(memory.snapshot().media.videoIds).toEqual([]);
});

test('listing truncation and per-entry warnings are explicit and browsing remains read-only', async ({ page }) => {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await mockDirectory(page, {
    ...directory([]),
    truncated: true,
    ignored: 3,
    warnings: ['Cannot inspect disconnected folder.'],
  });
  await openImport(page);
  await expect(page.getByRole('region', { name: 'Browse original recordings' })).toContainText('listing limit');
  await page.getByText('Folder access warnings', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Browse original recordings' })).toContainText(
    'Cannot inspect disconnected folder',
  );
  expect(posts).toBe(0);
  expect(memory.saves).toBe(0);
});

test('the no-copy browser and explicit path form fit the minimum viewport without horizontal overflow', async ({
  page,
}) => {
  await mockDirectory(
    page,
    directory([
      {
        kind: 'video',
        name: 'A very long footage filename with spaces.mp4',
        path: '/approved/A very long footage filename with spaces.mp4',
        size: 500 * 1024 ** 2,
      },
    ]),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await openImport(page);
  await expect(
    page.getByRole('checkbox', { name: 'Select recording A very long footage filename with spaces.mp4' }),
  ).toBeVisible();
  await page.getByText('Import a whole folder by path', { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .getByRole('dialog', { name: 'Import recordings' })
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
});
