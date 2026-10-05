import { expect, test, type Locator, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { AudioDirectory, FootageRoot } from '../../src/shared/footage.js';
import type { MediaJob } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { inspectorTab } from './editor-helpers.js';
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
    const audio = await response.json() as { assets: AudioAsset[] };
    const prepared = audio.assets.find((asset) => asset.name === 'test-music.wav' && asset.status === 'ready');
    if (!prepared || prepared.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/test-music.wav')) {
        throw new Error('Music browsing uses only the existing prepared synthetic WAV; no private source or fixture reset is permitted.');
    }
    music = prepared;
    const rootsResponse = await request.get('/api/audio/roots');
    expect(rootsResponse.ok()).toBe(true);
    const { roots } = await rootsResponse.json() as { roots: FootageRoot[] };
    expect(roots).toHaveLength(1);
    const root = roots.find((item) => item.available && item.path === path.resolve('.pascap/browser-footage/synthetic-sources'));
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

async function audioControls(page: Page): Promise<void> {
    const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
    if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
    await inspectorTab(page, 'Audio');
    const section = page.getByRole('button', { name: 'Music section', exact: true });
    if (await section.getAttribute('aria-expanded') === 'false') await section.click();
    await expect(page.getByRole('button', { name: 'Browse music files', exact: true })).toBeVisible();
}

async function openBrowser(page: Page, enterFixture = true): Promise<Locator> {
    await audioControls(page);
    await page.getByRole('button', { name: 'Browse music files', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Browse music files', exact: true });
    await expect(modal).toBeVisible();
    if (enterFixture) {
        await modal.getByRole('button', { name: `Open music folder ${path.basename(testDirectory)}`, exact: true }).click();
        await expect(modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true })).toBeVisible();
    }
    return modal;
}

function posts(page: Page): { pathname: string; body: unknown }[] {
    const writes: { pathname: string; body: unknown }[] = [];
    page.on('request', (request) => {
        if (request.method() === 'POST') writes.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    return writes;
}

function directory(entries: AudioDirectory['entries'], selected = testDirectory, parent: string | null = approved.path, rootId = approved.id): AudioDirectory {
    return { rootId, directory: selected, parent, entries, ignored: 0, truncated: false, warnings: [] };
}

function acceptedJob(): MediaJob {
    return { id: 'music-browser-accepted', kind: 'audio', label: 'Confirmed synthetic music', state: 'completed', progress: 1, message: 'Prepared synthetic fixture reused', createdAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:00:01Z', outputUrl: null, receiptUrl: null };
}

test('browse, select, Cancel and Escape never POST or edit, and return focus without losing the manual path draft', async ({ page }) => {
    const writes = posts(page);
    await audioControls(page);
    const manual = page.getByRole('textbox', { name: 'Music file path', exact: true });
    await manual.fill('/disposable/manual-music.wav');
    const before = memory.snapshot();
    const modal = await openBrowser(page);
    expect(await modal.evaluate((element: HTMLDialogElement) => element.open && element.matches(':modal'))).toBe(true);
    await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
    await modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true }).check();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Browse music files', exact: true });
    await expect(trigger).toBeFocused();
    await expect(manual).toHaveValue('/disposable/manual-music.wav');
    await trigger.press('Enter');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.footage-registration')).toContainText('No music file selected');
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(writes).toEqual([]); expect(memory.saves).toBe(0); expect(memory.snapshot()).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test('real guarded navigation, root/up, filtering and native radios keep exactly one audio selection without writes', async ({ page }) => {
    const writes = posts(page);
    const modal = await openBrowser(page, false);
    await expect(modal.getByRole('combobox', { name: 'Music location', exact: true })).toHaveValue(approved.id);
    await expect(modal.getByRole('button', { name: 'Up one music folder', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Music root folder', exact: true })).toBeDisabled();
    await expect(modal.getByRole('radio', { name: /browse-camera/ })).toHaveCount(0);
    await modal.getByRole('button', { name: `Open music folder ${path.basename(testDirectory)}`, exact: true }).click();
    const first = modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true });
    const other = modal.getByRole('radio', { name: `Select music ${otherName}`, exact: true });
    await expect(modal.getByRole('list', { name: 'Music entries' }).locator('li')).toHaveCount(3);
    expect(await modal.getByRole('list', { name: 'Music entries' }).locator('.footage-recording span').allTextContents()).toEqual([sourceName, otherName]);
    await first.check(); await other.check(); await expect(first).not.toBeChecked();
    await expect(modal.locator('input[type="radio"]:checked')).toHaveCount(1);
    await modal.getByRole('searchbox', { name: 'Search music files', exact: true }).fill('music 2');
    await expect(first).toBeVisible(); await expect(other).toHaveCount(0);
    await expect(modal.locator('.footage-registration')).toContainText(`Selected: ${otherName}`);
    await modal.getByRole('searchbox', { name: 'Search music files', exact: true }).fill('');
    await modal.getByRole('button', { name: 'Open music folder Nested', exact: true }).click();
    await modal.getByRole('radio', { name: `Select music ${nestedName}`, exact: true }).check();
    await modal.getByRole('button', { name: 'Up one music folder', exact: true }).click();
    await expect(modal.locator('.footage-registration')).toContainText(`Selected: ${nestedName}`);
    await expect(modal.locator('input[type="radio"]:checked')).toHaveCount(0);
    await modal.getByRole('button', { name: 'Music root folder', exact: true }).click();
    await expect(modal.locator('.footage-navigation output')).toHaveText(approved.path);
    await modal.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Refresh music locations', exact: true }).click();
    await expect(modal.getByRole('button', { name: `Open music folder ${path.basename(testDirectory)}`, exact: true })).toBeVisible();
    expect(writes).toEqual([]); expect(memory.saves).toBe(0);
});

test('real explicit confirmation persists only importing-project audio membership, survives reopen and leaves source bytes untouched', async ({ page, request }) => {
    const writes = posts(page);
    const canonicalBytes = await readFile(music.sourcePath);
    const selectedBytes = await readFile(firstPath);
    const before = await stat(firstPath);
    const names = await readdir(testDirectory);
    const beforeProject = memory.snapshot();
    const otherProject = { ...createProject('music-browser-other', 'Other memory project'), revision: 1 };
    memory.seed(otherProject);
    const modal = await openBrowser(page);
    await modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true }).check();
    expect(writes).toEqual([]);
    const confirmed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/audio/register-selected' && response.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Import selected music', exact: true }).click();
    const response = await confirmed; expect(response.status()).toBe(202);
    const result = await response.json() as { asset: AudioAsset; job: MediaJob };
    // Current identity includes inode/device/mtime; equal copied bytes do not
    // impersonate a separately registered source. Reimport that same path below.
    expect(result.asset.id).not.toBe(music.id); expect(result.asset.sourcePath).toBe(firstPath);
    const importedId = result.asset.id;
    expect(result.job.kind).toBe('audio');
    await expect(modal).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Browse music files', exact: true })).toBeFocused();
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.snapshot().media).toEqual({ videoIds: [], audioIds: [importedId] });
    expect(memory.snapshot().music).toBeNull(); expect(memory.snapshot().clips).toEqual([]);
    expect({ ...memory.snapshot(), revision: beforeProject.revision, media: beforeProject.media }).toEqual(beforeProject);
    expect(memory.snapshot(otherProject.id)).toEqual(otherProject);
    expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await expect(page.locator(`select[aria-label="Music recording"] option[value="${importedId}"]`)).toHaveJSProperty('disabled', false, { timeout: 20_000 });
    const registered = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.find((asset) => asset.id === importedId)!;
    const playback = path.resolve('.pascap/browser-tests/audio-assets', registered.fingerprint.digest, 'pcm16-48k-stereo-mono-unity-v3', 'playback.pcm');
    const cachedBytes = await readFile(playback); const cachedStat = await stat(playback);
    const reused = await request.post('/api/audio/register-selected', { headers: { 'x-pascap-client': 'preview-lab' }, data: { path: firstPath } });
    expect(reused.status()).toBe(202);
    const repeated = await reused.json() as { asset: AudioAsset; job: MediaJob };
    expect(repeated.asset.id).toBe(importedId);
    await expect.poll(async () => (await (await request.get(`/api/jobs/${repeated.job.id}`)).json() as { job: MediaJob }).job.state).toBe('completed');
    const reusedStat = await stat(playback);
    expect([reusedStat.ino, reusedStat.mtimeMs, reusedStat.size]).toEqual([cachedStat.ino, cachedStat.mtimeMs, cachedStat.size]);
    expect(await readFile(playback)).toEqual(cachedBytes);
    await page.reload(); await audioControls(page);
    await expect(page.getByRole('combobox', { name: 'Music recording', exact: true })).toHaveValue('');
    await expect(page.locator('select[aria-label="Music recording"] option')).toHaveCount(2);
    expect(memory.snapshot().media.audioIds).toEqual([importedId]);
    const after = await stat(firstPath);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
    expect(await readFile(firstPath)).toEqual(selectedBytes); expect(await readFile(music.sourcePath)).toEqual(canonicalBytes);
    expect(await readdir(testDirectory)).toEqual(names);
});

test('importing moved music creates a new bin entry without relinking the old source or placing music', async ({ page, request }) => {
    const oldPath = path.join(testDirectory, 'Before move.wav');
    const movedPath = path.join(testDirectory, 'After move.wav');
    await copyFile(music.sourcePath, oldPath);
    const sourceBytes = await readFile(oldPath);
    const registered = await request.post('/api/audio/register-selected', { headers: { 'x-pascap-client': 'preview-lab' }, data: { path: oldPath } });
    expect(registered.status()).toBe(202);
    const previous = await registered.json() as { asset: AudioAsset; job: MediaJob };
    await expect.poll(async () => (await (await request.get(`/api/jobs/${previous.job.id}`)).json() as { job: MediaJob }).job.state).toBe('completed');
    const before = { ...memory.snapshot(), media: { videoIds: [], audioIds: [previous.asset.id] } };
    memory.seed(before);
    await rename(oldPath, movedPath);
    await page.reload();
    const writes = posts(page);
    const modal = await openBrowser(page);
    await modal.getByRole('radio', { name: 'Select music After move.wav', exact: true }).check();
    const confirmed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/audio/register-selected' && response.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Import selected music', exact: true }).click();
    const response = await confirmed; expect(response.status()).toBe(202);
    const imported = await response.json() as { asset: AudioAsset; job: MediaJob };
    expect(imported.asset.id).not.toBe(previous.asset.id);
    expect(imported.asset.sourcePath).toBe(movedPath);
    expect(imported.asset.fingerprint).toEqual(previous.asset.fingerprint);
    await expect(modal).toHaveCount(0);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(memory.snapshot().media.audioIds).toEqual([previous.asset.id, imported.asset.id]);
    expect(memory.snapshot().music).toBeNull();
    expect({ ...memory.snapshot(), revision: before.revision, media: before.media }).toEqual(before);
    await expect(page.locator(`select[aria-label="Music recording"] option[value="${previous.asset.id}"]`)).toHaveJSProperty('disabled', true);
    await expect(page.locator(`select[aria-label="Music recording"] option[value="${imported.asset.id}"]`)).toHaveJSProperty('disabled', false, { timeout: 20_000 });
    const listed = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets;
    const old = listed.find((asset) => asset.id === previous.asset.id)!;
    expect(old.sourcePath).toBe(oldPath); expect(old.fingerprint).toEqual(previous.asset.fingerprint);
    expect(old.status).toBe('error'); expect(old.error).toContain('original recording is missing');
    expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: movedPath } }]);
    expect(await readFile(movedPath)).toEqual(sourceBytes);
});

test('a roots read failure can be refreshed without registration, project edits or an implicit read retry', async ({ page }) => {
    const writes = posts(page); let reads = 0;
    await page.route('**/api/audio/roots', async (route) => {
        reads++;
        if (reads === 1) await route.fulfill({ status: 503, json: { error: 'Synthetic music locations unavailable. Restore the service and refresh.' } });
        else await route.fulfill({ json: { roots: [approved] } });
    });
    const modal = await openBrowser(page, false);
    await expect(modal.getByRole('alert')).toContainText('Restore the service');
    await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
    expect(reads).toBe(1);
    await modal.getByRole('button', { name: 'Refresh music locations', exact: true }).click();
    await expect(modal.getByRole('button', { name: `Open music folder ${path.basename(testDirectory)}`, exact: true })).toBeVisible();
    await expect(modal.getByRole('alert')).toHaveCount(0);
    expect(reads).toBe(2); expect(writes).toEqual([]); expect(memory.saves).toBe(0);
});

test('the retained manual path uses its separate unrestricted endpoint and adds a bin entry without placing music', async ({ page }) => {
    const writes = posts(page);
    await page.route('**/api/audio/register', (route) => route.fulfill({ status: 202, json: { asset: music, job: acceptedJob() } }));
    await audioControls(page);
    const manualPath = '/disposable-outside-browser-roots/manual.wav';
    await page.getByRole('textbox', { name: 'Music file path', exact: true }).fill(manualPath);
    await page.getByRole('button', { name: 'Import audio', exact: true }).click();
    await expect(page.locator('select[aria-label="Music recording"] option')).toHaveCount(2);
    await page.evaluate(() => window.pascapLab!.flush());
    expect(writes).toEqual([{ pathname: '/api/audio/register', body: { path: manualPath } }]);
    expect(memory.snapshot().media.audioIds).toEqual([music.id]); expect(memory.snapshot().music).toBeNull();
    await expect(page.getByRole('textbox', { name: 'Music file path', exact: true })).toHaveValue(manualPath);
});

for (const unavailable of [false, true]) {
    test(`${unavailable ? 'unavailable' : 'empty'} roots explain configuration, disable confirmation and retain manual import`, async ({ page }) => {
        const writes = posts(page);
        const roots = unavailable ? [{ ...approved, available: false, error: 'Synthetic drive disconnected.' }] : [];
        await page.route('**/api/audio/roots', (route) => route.fulfill({ json: { roots } }));
        const modal = await openBrowser(page, false);
        await expect(modal).toContainText('No readable music locations');
        await expect(modal).toContainText('PASCAP_MEDIA_ROOTS');
        await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
        if (unavailable) {
            await expect(modal.locator('option[value="root-0"]')).toHaveJSProperty('disabled', true);
            await modal.getByText('Unavailable music locations', { exact: true }).click();
            await expect(modal).toContainText('Synthetic drive disconnected');
        }
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Music file path', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Import audio', exact: true })).toBeVisible();
        expect(writes).toEqual([]); expect(memory.saves).toBe(0);
    });
}

test('access errors and Refresh are read-only; recovered truncation and access warnings are explicit', async ({ page }) => {
    const writes = posts(page); let reads = 0;
    await page.route(/\/api\/audio\/browse\?/, async (route) => {
        reads++;
        if (reads === 1) await route.fulfill({ status: 403, json: { error: 'Synthetic music folder is not readable. Check permissions and refresh.' } });
        else await route.fulfill({ json: { ...directory([{ kind: 'audio', name: sourceName, path: firstPath, size: 100 }], approved.path, null), truncated: true, warnings: ['Cannot inspect disconnected synthetic subfolder.'] } });
    });
    const modal = await openBrowser(page, false);
    await expect(modal.getByRole('alert')).toContainText('Check permissions');
    await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Refresh music locations', exact: true }).click();
    await expect(modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true })).toBeVisible();
    await expect(modal).toContainText('entry listing limit'); await expect(modal).toContainText('smaller subfolder');
    await modal.getByText('Folder access warnings', { exact: true }).click();
    await expect(modal).toContainText('Cannot inspect disconnected synthetic subfolder');
    expect(reads).toBe(2); expect(writes).toEqual([]); expect(memory.saves).toBe(0);
});

test('changing roots aborts stale listings and clears selection instead of showing the previous root response', async ({ page }) => {
    const writes = posts(page);
    const second: FootageRoot = { id: 'disposable-root-1', name: 'Other synthetic location', path: nestedDirectory, available: true, error: null };
    let release!: () => void; const delayed = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const loading = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/audio/roots', (route) => route.fulfill({ json: { roots: [approved, second] } }));
    await page.route(/\/api\/audio\/browse\?/, async (route) => {
        if (new URL(route.request().url()).searchParams.get('rootId') === approved.id) {
            started(); await delayed;
            await route.fulfill({ json: directory([{ kind: 'audio', name: 'Stale.wav', path: firstPath, size: 100 }], approved.path, null) }).catch(() => { /* The aborted read may no longer have a route. */ });
        } else await route.fulfill({ json: directory([{ kind: 'audio', name: nestedName, path: path.join(nestedDirectory, nestedName), size: 100 }], second.path, null, second.id) });
    });
    const modal = await openBrowser(page, false);
    try {
        await loading;
        await modal.getByRole('combobox', { name: 'Music location', exact: true }).selectOption(second.id);
        const current = modal.getByRole('radio', { name: `Select music ${nestedName}`, exact: true });
        await expect(current).toBeVisible(); await current.check(); release();
        await modal.getByRole('combobox', { name: 'Music location', exact: true }).selectOption(approved.id);
        await expect(modal.getByRole('radio', { name: 'Select music Stale.wav', exact: true })).toBeVisible();
        await expect(modal.locator('.footage-registration')).toContainText('No music file selected');
        await modal.getByRole('combobox', { name: 'Music location', exact: true }).selectOption(second.id);
        await expect(current).toBeVisible(); await expect(current).not.toBeChecked();
        await expect(modal.getByRole('radio', { name: 'Select music Stale.wav', exact: true })).toHaveCount(0);
        expect(writes).toEqual([]); expect(memory.saves).toBe(0);
    } finally { release(); }
});

test('Cancel aborts an outstanding roots read and reopening starts clean, with no write or stale error', async ({ page }) => {
    const writes = posts(page); let reads = 0;
    let release!: () => void; const delayed = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const loading = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/audio/roots', async (route) => {
        reads++;
        if (reads === 1) { started(); await delayed; await route.fulfill({ status: 503, json: { error: 'Stale closed-browser failure.' } }).catch(() => { }); }
        else await route.fulfill({ json: { roots: [approved] } });
    });
    const modal = await openBrowser(page, false);
    try {
        await loading; await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(modal).toHaveCount(0); release();
        await expect(page.getByRole('button', { name: 'Browse music files', exact: true })).toBeFocused();
        await openBrowser(page);
        await expect(modal.getByRole('alert')).toHaveCount(0);
        await expect(modal.locator('.footage-registration')).toContainText('No music file selected');
        expect(reads).toBe(2); expect(writes).toEqual([]); expect(memory.saves).toBe(0);
    } finally { release(); }
});

for (const failure of [
    { name: 'probe rejection', status: 422, message: 'Selected source has no standalone audio stream. Choose a standalone music file.' },
    { name: 'selected path access rejection', status: 403, message: 'Selected music is no longer inside an approved readable root. Check the mounted location.' },
]) {
    test(`${failure.name} retains actual error and selection without false success or retry`, async ({ page }) => {
        const writes = posts(page);
        await page.route('**/api/audio/register-selected', (route) => route.fulfill({ status: failure.status, json: { error: failure.message } }));
        const modal = await openBrowser(page);
        const selected = modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true });
        await selected.check(); await modal.getByRole('button', { name: 'Import selected music', exact: true }).click();
        await expect(modal.getByRole('alert')).toContainText(failure.message);
        await expect(modal.getByRole('alert')).toContainText('Check Activity');
        await expect(selected).toBeChecked(); await expect(modal).toBeVisible();
        await expect(page.locator('select[aria-label="Music recording"] option')).toHaveCount(1);
        await modal.getByRole('button', { name: 'Refresh music locations', exact: true }).click();
        await expect(selected).toBeChecked();
        expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
        expect(memory.saves).toBe(0); expect(memory.snapshot().media.audioIds).toEqual([]);
        await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Browse music files', exact: true })).toBeFocused();
    });
}

test('an uncertain write retains selection, shows the actual transport uncertainty and never retries on metadata Refresh', async ({ page }) => {
    const writes = posts(page);
    await page.route('**/api/audio/register-selected', (route) => route.abort('connectionreset'));
    const modal = await openBrowser(page);
    const selected = modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true });
    await selected.check(); await modal.getByRole('button', { name: 'Import selected music', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('operation may still have completed');
    await expect(modal.getByRole('alert')).toContainText('before repeating'); await expect(selected).toBeChecked();
    await modal.getByRole('button', { name: 'Refresh music locations', exact: true }).click();
    await expect(selected).toBeChecked(); await expect(modal).toBeVisible();
    expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
    expect(memory.saves).toBe(0); expect(memory.snapshot().media.audioIds).toEqual([]); expect(memory.snapshot().music).toBeNull();
});

test('pending registration blocks Escape, Cancel and duplicate submit; accepted work is not reclassified by a failed status read', async ({ page }) => {
    const writes = posts(page); let accepted = false;
    let release!: () => void; const delayed = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void; const registering = new Promise<void>((resolve) => { started = resolve; });
    await page.route('**/api/audio/register-selected', async (route) => { started(); await delayed; accepted = true; await route.fulfill({ status: 202, json: { asset: music, job: acceptedJob() } }); });
    await page.route('**/api/audio', (route) => accepted
        ? route.fulfill({ status: 503, json: { error: 'Synthetic accepted-import status read failed.' } })
        : route.fulfill({ json: { assets: [music] } }));
    const modal = await openBrowser(page);
    await modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true }).check();
    try {
        // Same-event submissions exercise the ref, before React's disabled render.
        await modal.getByRole('button', { name: 'Import selected music', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await registering;
        await expect(modal.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
        await expect(modal.getByRole('button', { name: 'Import selected music', exact: true })).toBeDisabled();
        await expect(modal.getByRole('combobox', { name: 'Music location', exact: true })).toBeDisabled();
        await expect(modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true })).toBeDisabled();
        await page.keyboard.press('Escape'); await expect(modal).toBeVisible();
        expect(writes).toHaveLength(1); release();
        await expect(modal).toHaveCount(0); await page.evaluate(() => window.pascapLab!.flush());
        expect(memory.snapshot().media.audioIds).toEqual([music.id]); expect(memory.snapshot().music).toBeNull();
        await expect(page.locator('.activity-footer-error')).toContainText('request was accepted');
        await page.getByRole('button', { name: 'Open activity', exact: true }).click();
        const activity = page.getByRole('region', { name: 'Activity', exact: true });
        await expect(activity).toContainText('Confirmed synthetic music');
        await expect(activity).toContainText('Synthetic accepted-import status read failed');
        expect(writes).toEqual([{ pathname: '/api/audio/register-selected', body: { path: firstPath } }]);
    } finally { release(); }
});

for (const width of [640, 720]) {
    test(`compact ${width}px native keyboard navigation and focus trapping stay reachable without timeline shortcuts or horizontal overflow`, async ({ page }) => {
        const writes = posts(page);
        await page.setViewportSize({ width, height: 720 });
        await expect(page.getByRole('button', { name: 'Toggle Clip panel', exact: true })).toHaveAttribute('aria-pressed', 'false');
        const modal = await openBrowser(page);
        const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
        const location = modal.getByRole('combobox', { name: 'Music location', exact: true });
        await location.focus(); await page.keyboard.press('Tab');
        await expect(modal.getByRole('button', { name: 'Refresh music locations', exact: true })).toBeFocused();
        const first = modal.getByRole('radio', { name: `Select music ${sourceName}`, exact: true });
        await first.focus(); await first.press('Space'); await expect(first).toBeChecked();
        await first.press('ArrowDown'); await expect(modal.getByRole('radio', { name: `Select music ${otherName}`, exact: true })).toBeChecked();
        await expect(modal.locator('input[type="radio"]:checked')).toHaveCount(1);
        const cancel = modal.getByRole('button', { name: 'Cancel', exact: true });
        await cancel.focus(); await expect(cancel).toBeInViewport();
        await page.keyboard.press('Tab');
        // Native Chrome may visit browser chrome (represented by body) at the end
        // of a modal's tab sequence; it must never focus an inert editor control.
        expect(await modal.evaluate((element) => globalThis.document.activeElement === globalThis.document.body || element.contains(globalThis.document.activeElement))).toBe(true);
        await location.focus(); await page.keyboard.press('Shift+Tab'); await expect(cancel).toBeFocused();
        expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        const confirm = modal.getByRole('button', { name: 'Import selected music', exact: true });
        await confirm.focus(); await expect(confirm).toBeInViewport();
        expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(28);
        await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Browse music files', exact: true })).toBeFocused();
        expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
        expect(writes).toEqual([]); expect(memory.saves).toBe(0);
    });
}
