import { expect, test, type Locator, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { FootageRoot } from '../../src/shared/footage.js';
import type { MediaJob } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { expandPanel, inspectorTab, isWritePost } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let music: AudioAsset;
let approved: FootageRoot;
let testDirectory = '';
let nestedDirectory: string;
let firstPath: string;
const projectId = 'music-browser-memory';
const title = 'Music browsing · memory-only';
const sourceName = 'Music 2.WAV';
const otherName = 'Music 10.wav';
const nestedName = 'Nested music.wav';

test.beforeAll(async ({ request }) => {
  const response = await request.get('/api/audio');
  expect(response.ok()).toBe(true);
  const audio = (await response.json()) as { assets: AudioAsset[] };
  const prepared = audio.assets.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
  if (!prepared || prepared.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav')) {
    throw new Error(
      'Music browsing uses only the existing prepared synthetic WAV; no private source or fixture reset is permitted.',
    );
  }
  music = prepared;
  const rootsResponse = await request.get('/api/footage/roots');
  expect(rootsResponse.ok()).toBe(true);
  const { roots } = (await rootsResponse.json()) as { roots: FootageRoot[] };
  expect(roots).toHaveLength(1);
  const root = roots.find(
    (item) => item.available && item.path === path.resolve('.pascap/browser-footage/synthetic-sources'),
  );
  if (!root) throw new Error('Expected the isolated browser fixture root configured by Playwright.');
  approved = root;
  // The prepared WAV lives in the excluded cache. Only generated test bytes are
  // copied into this uniquely owned folder, never an owner original or fixture reset.
  testDirectory = await mkdtemp(path.join(approved.path, 'music-browser-'));
  nestedDirectory = path.join(testDirectory, 'Nested');
  firstPath = path.join(testDirectory, sourceName);
  await mkdir(nestedDirectory);
  await copyFile(music.sourcePath, firstPath);
  await copyFile(music.sourcePath, path.join(testDirectory, otherName));
  await copyFile(music.sourcePath, path.join(nestedDirectory, nestedName));
});

test.afterAll(async () => {
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  memory = await memoryProjects(page, { ...createProject(projectId, title), revision: 1 });
  await page.goto(`/?project=${projectId}`);
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(title);
  await page.waitForFunction((id) => window.pascapLab?.project()?.id === id, projectId);
});

function trigger(page: Page): Locator {
  return page.getByRole('button', { name: 'Import music', exact: true });
}

async function audioControls(page: Page): Promise<void> {
  const expand = expandPanel(page, 'Properties');
  if (await expand.isVisible()) await expand.click();
  await inspectorTab(page, 'Audio');
  const section = page.getByRole('button', { name: 'Music section', exact: true });
  if ((await section.getAttribute('aria-expanded')) === 'false') await section.click();
  await expect(trigger(page)).toBeVisible();
}

async function openBrowser(page: Page, enterFixture = true): Promise<Locator> {
  await audioControls(page);
  await trigger(page).click();
  const modal = page.getByRole('dialog', { name: 'Import media', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Music', exact: true })).toHaveAttribute('aria-pressed', 'true');
  if (enterFixture) {
    await modal.getByRole('button', { name: `Open folder ${path.basename(testDirectory)}`, exact: true }).click();
    await expect(modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true })).toBeVisible();
  }
  return modal;
}

function posts(page: Page): { pathname: string; body: unknown }[] {
  const writes: { pathname: string; body: unknown }[] = [];
  page.on('request', (request) => {
    if (isWritePost(request)) writes.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  return writes;
}

function acceptedJob(): MediaJob {
  return {
    id: 'music-browser-accepted',
    kind: 'audio',
    label: 'Confirmed synthetic music',
    state: 'completed',
    progress: 1,
    message: 'Prepared synthetic fixture reused',
    createdAt: '2026-10-05T10:00:00Z',
    finishedAt: '2026-10-05T10:00:01Z',
    outputUrl: null,
    receiptUrl: null,
  };
}

test('Import music opens the shared dialog on music; browse, select, Cancel and Escape never POST or edit', async ({
  page,
}) => {
  const writes = posts(page);
  const before = memory.snapshot();
  const modal = await openBrowser(page, false);
  expect(await modal.evaluate((element: HTMLDialogElement) => element.open && element.matches(':modal'))).toBe(true);
  await expect(modal.getByRole('checkbox', { name: /browse-camera/ })).toHaveCount(0);
  await modal.getByRole('button', { name: 'All', exact: true }).click();
  await expect(modal.getByRole('checkbox', { name: 'Select browse-camera-1.mp4', exact: true })).toBeVisible();
  await modal.getByRole('button', { name: 'Music', exact: true }).click();
  await modal.getByRole('button', { name: `Open folder ${path.basename(testDirectory)}`, exact: true }).click();
  await expect(modal.getByRole('button', { name: 'Import selected recordings', exact: true })).toBeDisabled();
  await modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true }).check();
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).press('Enter');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.import-selection')).toHaveText('Select recordings, or double-click one to import it');
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(writes).toEqual([]);
  expect(memory.saves).toBe(0);
  expect(memory.snapshot()).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test('real guarded navigation, breadcrumbs, filtering and multiple selection across folders without writes', async ({
  page,
}) => {
  const writes = posts(page);
  const modal = await openBrowser(page, false);
  const places = modal.getByRole('navigation', { name: 'Media locations' });
  await expect(places.getByRole('button', { name: approved.name, exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await expect(modal.getByRole('button', { name: 'Up one folder', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: `Open folder ${path.basename(testDirectory)}`, exact: true }).click();
  const first = modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true });
  const other = modal.getByRole('checkbox', { name: `Select ${otherName}`, exact: true });
  const entries = modal.getByRole('list', { name: 'Folders and recordings' }).locator('li');
  await expect(entries).toHaveCount(3);
  expect(await entries.locator('.import-file > span:nth-child(3)').allTextContents()).toEqual([sourceName, otherName]);
  await first.check();
  await other.check();
  await modal.getByRole('searchbox', { name: 'Filter this folder', exact: true }).fill('music 2');
  await expect(first).toBeVisible();
  await expect(other).toHaveCount(0);
  await modal.getByRole('searchbox', { name: 'Filter this folder', exact: true }).fill('');
  await modal.getByRole('button', { name: 'Open folder Nested', exact: true }).click();
  await modal.getByRole('checkbox', { name: `Select ${nestedName}`, exact: true }).check();
  await modal.getByRole('button', { name: 'Up one folder', exact: true }).click();
  await expect(first).toBeChecked();
  await expect(modal.locator('.import-selection')).toHaveText('3 music recordings selected');
  await modal
    .getByRole('navigation', { name: 'Folder path' })
    .getByRole('button', { name: approved.name, exact: true })
    .click();
  await expect(modal.getByRole('button', { name: 'Up one folder', exact: true })).toBeDisabled();
  await modal.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(
    modal.getByRole('button', { name: `Open folder ${path.basename(testDirectory)}`, exact: true }),
  ).toBeVisible();
  await expect(modal.locator('.import-selection')).toHaveText('3 music recordings selected');
  expect(writes).toEqual([]);
  expect(memory.saves).toBe(0);
});

test('real explicit import persists only importing-project audio membership, survives reopen and leaves source bytes untouched', async ({
  page,
  request,
}) => {
  const writes = posts(page);
  const canonicalBytes = await readFile(music.sourcePath);
  const selectedBytes = await readFile(firstPath);
  const before = await stat(firstPath);
  const names = await readdir(testDirectory);
  const beforeProject = memory.snapshot();
  const otherProject = { ...createProject('music-browser-other', 'Other memory project'), revision: 1 };
  memory.seed(otherProject);
  const modal = await openBrowser(page);
  await modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true }).check();
  expect(writes).toEqual([]);
  const confirmed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/audio/register-selected' && response.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
  const response = await confirmed;
  expect(response.status()).toBe(202);
  const result = (await response.json()) as { asset: AudioAsset; job: MediaJob };
  // Current identity includes inode/device/mtime; equal copied bytes do not
  // impersonate a separately registered source. Reimport that same path below.
  expect(result.asset.id).not.toBe(music.id);
  expect(result.asset.sourcePath).toBe(firstPath);
  const importedId = result.asset.id;
  expect(result.job.kind).toBe('audio');
  await expect(modal).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media).toEqual({ videoIds: [], audioIds: [importedId] });
  expect(memory.snapshot().music).toEqual([]);
  expect(memory.snapshot().clips).toEqual([]);
  expect({ ...memory.snapshot(), revision: beforeProject.revision, media: beforeProject.media }).toEqual(beforeProject);
  expect(memory.snapshot(otherProject.id)).toEqual(otherProject);
  expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator(`[data-music-media-id="${importedId}"]`)).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  const registered = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.find(
    (asset) => asset.id === importedId,
  )!;
  const playback = path.resolve(
    '.pascap/browser-tests/audio-assets',
    registered.id,
    'pcm16-48k-stereo-mono-unity-v3',
    'playback.pcm',
  );
  const cachedBytes = await readFile(playback);
  const cachedStat = await stat(playback);
  const reused = await request.post('/api/audio/register-selected', {
    headers: { 'x-pascap-client': 'preview-lab' },
    data: { path: firstPath },
  });
  expect(reused.status()).toBe(202);
  const repeated = (await reused.json()) as { asset: AudioAsset; job: MediaJob };
  expect(repeated.asset.id).toBe(importedId);
  await expect
    .poll(
      async () => ((await (await request.get(`/api/jobs/${repeated.job.id}`)).json()) as { job: MediaJob }).job.state,
    )
    .toBe('completed');
  const reusedStat = await stat(playback);
  expect([reusedStat.ino, reusedStat.mtimeMs, reusedStat.size]).toEqual([
    cachedStat.ino,
    cachedStat.mtimeMs,
    cachedStat.size,
  ]);
  expect(await readFile(playback)).toEqual(cachedBytes);
  await page.reload();
  await audioControls(page);
  await expect(page.getByRole('combobox', { name: 'Music track', exact: true })).toHaveValue('');
  await expect(page.locator('[data-music-media-id]')).toHaveCount(1);
  expect(memory.snapshot().media.audioIds).toEqual([importedId]);
  const after = await stat(firstPath);
  expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
  expect(await readFile(firstPath)).toEqual(selectedBytes);
  expect(await readFile(music.sourcePath)).toEqual(canonicalBytes);
  expect(await readdir(testDirectory)).toEqual(names);
});

test('importing moved music creates a new bin entry without relinking the old source or placing music', async ({
  page,
  request,
}) => {
  const oldPath = path.join(testDirectory, 'Before move.wav');
  const movedPath = path.join(testDirectory, 'After move.wav');
  await copyFile(music.sourcePath, oldPath);
  const sourceBytes = await readFile(oldPath);
  const registered = await request.post('/api/audio/register-selected', {
    headers: { 'x-pascap-client': 'preview-lab' },
    data: { path: oldPath },
  });
  expect(registered.status()).toBe(202);
  const previous = (await registered.json()) as { asset: AudioAsset; job: MediaJob };
  await expect
    .poll(
      async () => ((await (await request.get(`/api/jobs/${previous.job.id}`)).json()) as { job: MediaJob }).job.state,
    )
    .toBe('completed');
  const before = { ...memory.snapshot(), media: { videoIds: [], audioIds: [previous.asset.id] } };
  memory.seed(before);
  await rename(oldPath, movedPath);
  await page.reload();
  const writes = posts(page);
  const modal = await openBrowser(page);
  await modal.getByRole('checkbox', { name: 'Select After move.wav', exact: true }).check();
  const confirmed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/audio/register-selected' && response.request().method() === 'POST',
  );
  await modal.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
  const response = await confirmed;
  expect(response.status()).toBe(202);
  const imported = (await response.json()) as { asset: AudioAsset; job: MediaJob };
  expect(imported.asset.id).not.toBe(previous.asset.id);
  expect(imported.asset.sourcePath).toBe(movedPath);
  expect(imported.asset.fingerprint).toEqual(previous.asset.fingerprint);
  await expect(modal).toHaveCount(0);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.snapshot().media.audioIds).toEqual([previous.asset.id, imported.asset.id]);
  expect(memory.snapshot().music).toEqual([]);
  expect({ ...memory.snapshot(), revision: before.revision, media: before.media }).toEqual(before);
  await expect(page.locator(`[data-music-media-id="${previous.asset.id}"]`)).not.toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect(page.locator(`[data-music-media-id="${imported.asset.id}"]`)).toHaveAttribute('data-status', 'ready', {
    timeout: 20_000,
  });
  const listed = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets;
  const old = listed.find((asset) => asset.id === previous.asset.id)!;
  expect(old.sourcePath).toBe(oldPath);
  expect(old.fingerprint).toEqual(previous.asset.fingerprint);
  expect(old.status).toBe('error');
  expect(old.error).toContain('original recording is missing');
  expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: movedPath } }]);
  expect(await readFile(movedPath)).toEqual(sourceBytes);
});

for (const failure of [
  {
    name: 'probe rejection',
    status: 422,
    message: 'Selected source has no standalone audio stream. Choose a standalone music file.',
  },
  {
    name: 'selected path access rejection',
    status: 403,
    message: 'Selected music is no longer inside an approved readable root. Check the mounted location.',
  },
]) {
  test(`${failure.name} retains actual error and selection without false success or retry`, async ({ page }) => {
    const writes = posts(page);
    await page.route('**/api/audio/register-selected', (route) =>
      route.fulfill({ status: failure.status, json: { error: failure.message } }),
    );
    const modal = await openBrowser(page);
    const selected = modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true });
    await selected.check();
    await modal.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText(failure.message);
    await expect(modal.getByRole('region', { name: 'Import results' })).toContainText(`${sourceName} was not imported`);
    await expect(selected).toBeChecked();
    await expect(modal).toBeVisible();
    await expect(page.locator('[data-music-media-id]')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Refresh folder', exact: true }).click();
    await expect(selected).toBeChecked();
    expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
    expect(memory.saves).toBe(0);
    expect(memory.snapshot().media.audioIds).toEqual([]);
    await modal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(trigger(page)).toBeFocused();
  });
}

test('an uncertain write retains selection, shows the actual transport uncertainty and never retries on metadata Refresh', async ({
  page,
}) => {
  const writes = posts(page);
  await page.route('**/api/audio/register-selected', (route) => route.abort('connectionreset'));
  const modal = await openBrowser(page);
  const selected = modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true });
  await selected.check();
  await modal.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('operation may still have completed');
  await expect(modal.getByRole('alert')).toContainText('before repeating');
  await expect(selected).toBeChecked();
  await modal.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(selected).toBeChecked();
  await expect(modal).toBeVisible();
  expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
  expect(memory.saves).toBe(0);
  expect(memory.snapshot().media.audioIds).toEqual([]);
  expect(memory.snapshot().music).toEqual([]);
});

test('pending registration blocks Escape, Cancel and duplicate submit; accepted work is not reclassified by a failed status read', async ({
  page,
}) => {
  const writes = posts(page);
  let accepted = false;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const registering = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/audio/register-selected', async (route) => {
    started();
    await delayed;
    accepted = true;
    await route.fulfill({ status: 202, json: { asset: music, job: acceptedJob() } });
  });
  await page.route('**/api/audio', (route) =>
    accepted
      ? route.fulfill({ status: 503, json: { error: 'Synthetic accepted-import status read failed.' } })
      : route.fulfill({ json: { assets: [music], missing: [] } }),
  );
  const modal = await openBrowser(page);
  await modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true }).check();
  try {
    // Same-event submissions exercise the ref, before React's disabled render.
    await modal
      .getByRole('button', { name: 'Import selected recordings', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await registering;
    await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Import selected recordings', exact: true })).toBeDisabled();
    await expect(
      modal.getByRole('navigation', { name: 'Media locations' }).getByRole('button', { name: approved.name }),
    ).toBeDisabled();
    await expect(modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    expect(writes).toHaveLength(1);
    release();
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.snapshot().media.audioIds).toEqual([music.id]);
    expect(memory.snapshot().music).toEqual([]);
    await expect(page.locator('.activity-footer-error')).toContainText('request was accepted');
    await page.getByRole('button', { name: 'Open activity', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Activity', exact: true });
    await expect(activity).toContainText('Confirmed synthetic music');
    await expect(activity).toContainText('Synthetic accepted-import status read failed');
    expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
  } finally {
    release();
  }
});

test('native keyboard selection and focus trapping stay reachable at the minimum viewport without timeline shortcuts or horizontal overflow', async ({
  page,
}) => {
  const writes = posts(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const modal = await openBrowser(page);
  const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
  const first = modal.getByRole('checkbox', { name: `Select ${sourceName}`, exact: true });
  await first.focus();
  await first.press('Space');
  await expect(first).toBeChecked();
  await page.keyboard.press('Tab');
  const other = modal.getByRole('checkbox', { name: `Select ${otherName}`, exact: true });
  await expect(other).toBeFocused();
  await other.press('Space');
  await expect(modal.locator('.import-selection')).toHaveText('2 music recordings selected');
  const confirm = modal.getByRole('button', { name: 'Import selected recordings', exact: true });
  await confirm.focus();
  await expect(confirm).toBeInViewport();
  expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(28);
  await page.keyboard.press('Tab');
  // Native Chrome may visit browser chrome (represented by body) at the end
  // of a modal's tab sequence; it must never focus an inert editor control.
  expect(
    await modal.evaluate(
      (element) =>
        globalThis.document.activeElement === globalThis.document.body ||
        element.contains(globalThis.document.activeElement),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
  expect(writes).toEqual([]);
  expect(memory.saves).toBe(0);
});
