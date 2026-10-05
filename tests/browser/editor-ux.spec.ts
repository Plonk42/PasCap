import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AudioAsset } from '../../src/shared/audio.js';
import { estimateExportSpace, formatStorageBytes, MIN_EXPORT_FREE_BYTES, type ExportPreflight } from '../../src/shared/export-space.js';
import type { ExportProfile } from '../../src/shared/export.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { openOptions, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let assets: MediaAsset[];
let audio: AudioAsset[];
let memory: MemoryProjects;
let unexpected: string[];
let freeBytes: number;
let storageError: string;
let checks: ExportProfile[];
let submissions: ExportProfile[];
let jobs: MediaJob[];

function spaceFor(document: ProjectDocument, profile: ExportProfile): ExportPreflight {
  const estimate = estimateExportSpace(document, profile);
  let status: ExportPreflight['status'] = 'available';
  if (freeBytes < MIN_EXPORT_FREE_BYTES) status = 'blocked';
  else if (freeBytes < estimate.totalBytes) status = 'tight';
  return { directory: '/disposable/editor-cache/renders', availableBytes: freeBytes, estimate, status, checkedAt: '2026-10-04T10:00:00Z' };
}

test.beforeEach(async ({ page, request }) => {
  unexpected = []; checks = []; submissions = []; jobs = []; storageError = ''; freeBytes = 64 * 1024 ** 3;
  const library = await (await request.get('/api/media')).json() as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find((item) => item.name === name && item.status === 'ready' && item.prepared !== null);
    if (!asset) throw new Error('Editor UX checks require existing prepared synthetic fixtures; never prepare user media.');
    return asset;
  });
  audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.filter((asset) => asset.status === 'ready');
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const reads: Record<string, unknown> = {
      '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
      '/api/media': { assets }, '/api/audio': { assets: audio }, '/api/jobs': { jobs },
    };
    if (method === 'GET' && reads[pathname] !== undefined) { await route.fulfill({ json: reads[pathname] }); return; }
    if (method === 'POST' && pathname === '/api/exports/preflight') {
      const body = route.request().postDataJSON() as { document: ProjectDocument; profile: ExportProfile }; checks.push(body.profile);
      if (storageError) { await route.fulfill({ status: 503, json: { error: storageError } }); return; }
      await route.fulfill({ json: { space: spaceFor(projectSchema.parse(body.document), body.profile) } }); return;
    }
    if (method === 'POST' && pathname === '/api/exports') {
      const body = route.request().postDataJSON() as { profile: ExportProfile }; submissions.push(body.profile);
      const job: MediaJob = { id: 'memory-export-job', kind: 'export', label: 'Memory-only export', state: 'queued', progress: 0, message: 'Mock queued export; no native work', createdAt: '2026-10-04T10:00:00Z', finishedAt: null, outputUrl: null, receiptUrl: null };
      jobs = [job]; await route.fulfill({ status: 202, json: { job } }); return;
    }
    const video = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    const music = /^\/api\/audio\/([^/]+)\/(?:playback|waveform)$/.exec(pathname);
    if (method === 'GET' && ((video && assets.some((asset) => asset.id === video[1])) || (music && audio.some((asset) => asset.id === music[1])))) { await route.continue(); return; }
    if (method === 'HEAD' && music && pathname.endsWith('/playback') && audio.some((asset) => asset.id === music[1])) { await route.continue(); return; }
    unexpected.push(`${method} ${pathname}`); await route.abort('blockedbyclient');
  });
  const document = createProject('editor-ux-memory', 'Editor UX · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [createClip('ux-clip', assets[0]!.id, 0, 120)];
  memory = await memoryProjects(page, document);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

test.afterEach(() => expect(unexpected, 'Only explicit mock exports and existing synthetic media reads/music metadata HEADs are allowed').toEqual([]));

async function current(page: Page): Promise<ProjectDocument> { return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())); }
async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
}

test('panel and help controls are direct, keyboard accessible, and do not edit the project', async ({ page }) => {
  const before = await current(page);
  const media = page.getByRole('button', { name: 'Toggle Media panel', exact: true });
  await expect(media).toBeVisible(); await expect(media).toHaveAttribute('aria-controls', 'media-pane');
  await media.focus(); await media.press('Space');
  await expect(media).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('complementary', { name: 'Media library' })).toBeHidden();
  await media.press('Space'); await expect(page.getByRole('complementary', { name: 'Media library' })).toBeVisible();
  const help = page.getByRole('button', { name: 'Keyboard shortcuts', exact: true });
  await help.focus(); await help.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(help).toBeFocused();
  expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('partial media selection is mixed and active search/filter states can be cleared in place', async ({ page }) => {
  const before = await current(page);
  const all = page.getByRole('checkbox', { name: 'Select visible recordings' });
  await page.getByRole('checkbox', { name: 'Select pattern-a.mp4', exact: true }).check();
  expect(await all.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(true);
  await all.check(); await expect(all).toBeChecked();
  expect(await all.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(false);
  await page.getByRole('textbox', { name: 'Search media' }).fill('pattern-b');
  await expect(page.getByRole('button', { name: 'Clear media search' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear media search' }).click();
  await expect(page.getByRole('textbox', { name: 'Search media' })).toHaveValue('');
  await openOptions(page, 'Media options');
  await page.getByRole('combobox', { name: 'Filter media' }).selectOption('used'); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Clear media filter' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear media filter' }).click();
  await expect(page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add pattern-b.mp4 to timeline', exact: true })).toHaveCSS('opacity', '1');
  expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('selected context precedes compact animation controls and adjusted sections are visibly marked', async ({ page }) => {
  const selection = page.locator('.inspector-selection');
  await expect(selection).toContainText('pattern-a');
  expect(await selection.evaluate((element) => Boolean(element.compareDocumentPosition(globalThis.document.querySelector('.layer-keyframe-controls')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.locator('.layer-keyframe-scope')).toHaveCount(0);
  await expect(page.locator('.layer-keyed-control>.layer-setting-hint')).toHaveCount(0);
  const control = page.getByRole('button', { name: 'Keyframe Exposure', exact: true });
  await expect(control).toHaveAccessibleDescription(/static base/);
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.4');
  await expect(page.getByRole('button', { name: 'Colour section', exact: true }).locator('.inspector-section-modified')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Colour section', exact: true }).locator('.inspector-section-modified')).toHaveCount(0);
});

test('animated visual feedback retains explicit capture, native navigation order, and one Undo', async ({ page }) => {
  const document = await current(page);
  document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0 }), sharedPoint(90, { exposure: 0.8 })];
  memory.seed(document); await page.reload(); await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused'); await seek(page, 30);
  const diamond = page.getByRole('button', { name: 'Keyframe Exposure', exact: true });
  await expect(diamond).toHaveAttribute('aria-pressed', 'false'); await expect(diamond).toHaveCSS('border-style', 'dashed');
  await expect(diamond).toHaveAccessibleDescription(/whole row/);
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeDisabled();
  await diamond.focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Previous Exposure keyframe', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Next Exposure keyframe', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Animation help', exact: true }).click(); await expect(page.locator('.animation-legend')).toBeVisible();
  await page.keyboard.press('Escape'); expect(await current(page)).toEqual(document);
  await diamond.click(); await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled();
  expect((await current(page)).layers[0]!.keyframes).toEqual([document.layers[0]!.keyframes[0], sharedPoint(30, { exposure: 0.2 }), document.layers[0]!.keyframes[1]]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await current(page)).toEqual(document);
});

test('hiding the deferred inspector applies a blur draft once and retains its section state', async ({ page }) => {
  const before = await current(page);
  await page.getByRole('button', { name: 'Source range section', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('5');
  const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
  // Hiding a focused native input itself blurs it; the existing Enter/blur contract must still apply once.
  await toggle.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(input).toBeHidden(); expect((await current(page)).clips[0]!.sourceIn).toBe(5);
  await toggle.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(input).toBeVisible(); await expect(input).toHaveValue('5');
  await input.press('Enter'); expect((await current(page)).clips[0]!.sourceIn).toBe(5);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const width of [1440, 1024, 720, 640]) {
  test(`compact ${width}px toolbar keeps actions, marks and music pointer targets reachable`, async ({ page }) => {
    const music = audio[0]; if (!music) throw new Error('The dedicated synthetic audio fixture must already be prepared.');
    const document = await current(page);
    document.media.audioIds = [music.id];
    document.music = { mediaId: music.id, sourceIn: 0, sourceOut: Math.min(60, music.metadata.frameCount), start: 0, duration: 120, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: true };
    await page.evaluate((next) => window.pascapLab!.setDocument(next), document);
    await page.setViewportSize({ width, height: 720 }); await seek(page, 30);
    await page.getByRole('button', { name: 'Mark cut IN', exact: true }).click(); await seek(page, 40);
    await page.getByRole('button', { name: 'Mark cut OUT', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark cut IN', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.timeline-cut-selection')).toBeVisible();
    for (const name of ['Split at playhead', 'Trim start to playhead', 'Trim end to playhead', 'Delete selected clip', 'Mark cut IN', 'Mark cut OUT', 'Cut marked range', 'Clear cut marks', 'Toggle snapping', 'Add video layer']) {
      const button = page.getByRole('button', { name, exact: true }); await expect(button).toBeInViewport();
      const bounds = (await button.boundingBox())!; expect(bounds.width).toBeGreaterThanOrEqual(24); expect(bounds.height).toBeGreaterThanOrEqual(24);
    }
    const track = page.getByRole('button', { name: 'Move music track', exact: true });
    await expect(track).toBeInViewport();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 45, box.y + box.height / 2, { steps: 3 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    expect((await current(page)).music).toEqual(document.music);
  });
}

test('quality choices and storage meter are keyboard usable, with no render on dialog open or profile change', async ({ page }) => {
  const before = await current(page);
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Export storage' })).toContainText('Space checked');
  await expect(page.getByRole('meter', { name: 'Planning allowance compared with available storage' })).toBeVisible();
  const quality = page.getByRole('radio', { name: '720p draft', exact: true });
  await quality.focus(); await quality.press('ArrowRight'); await expect(page.getByRole('radio', { name: '4K final', exact: true })).toBeChecked();
  await expect.poll(() => checks).toEqual(['draft720', 'final4k']);
  expect(submissions).toEqual([]); expect(await current(page)).toEqual(before);
  await expect(page.getByText('Allowance, not a prediction or guaranteed upper bound.', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByText('Storage details', { exact: true }).click();
  await expect(page.locator('.export-storage-path')).toHaveText('/disposable/editor-cache/renders');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeFocused();
});

test('storage failure disables submission until an explicit read-only retry succeeds', async ({ page }) => {
  storageError = 'Storage mount is unavailable. Reconnect it and retry.';
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Reconnect it');
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeDisabled();
  storageError = ''; await page.getByRole('button', { name: 'Retry storage check', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeEnabled();
  expect(checks).toEqual(['draft720', 'draft720']); expect(submissions).toEqual([]);
});

test('zero-space recovery stays explicit and tight advisory space is not a false hard bound', async ({ page }) => {
  freeBytes = 0;
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Export storage' })).toHaveAttribute('data-status', 'blocked');
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeDisabled();
  freeBytes = MIN_EXPORT_FREE_BYTES;
  await page.getByRole('button', { name: 'Refresh storage check', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Export storage' })).toHaveAttribute('data-status', 'tight');
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export video' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Active jobs' })).toContainText('Memory-only export');
  expect(submissions).toEqual(['draft720']);
});

test('a cancelled stale quality check cannot overwrite the current quality or storage allowance', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let draftReceived = false; let draftReleased = false;
  await page.route('**/api/exports/preflight', async (route) => {
    const body = route.request().postDataJSON() as { document: ProjectDocument; profile: ExportProfile };
    if (body.profile === 'draft720') { draftReceived = true; await gate; }
    await route.fulfill({ json: { space: spaceFor(body.document, body.profile) } });
    if (body.profile === 'draft720') draftReleased = true;
  });
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await expect.poll(() => draftReceived).toBe(true); await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: '4K final', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeEnabled();
  const expected = formatStorageBytes(estimateExportSpace(await current(page), 'final4k').totalBytes);
  await expect(page.locator('.export-storage-values')).toContainText(expected);
  release(); await expect.poll(() => draftReleased).toBe(true);
  await expect(page.getByRole('radio', { name: '4K final', exact: true })).toBeChecked();
  await expect(page.locator('.export-storage-values')).toContainText(expected); expect(submissions).toEqual([]);
});

test('a failed deferred preview keeps the editor usable and saves pending edits before an explicit reload', async ({ page }) => {
  const before = await current(page);
  await page.route('**/assets/bootstrap-*.js', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play preview', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Keyframe Exposure', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue(before.title);
  expect(memory.snapshot()).toEqual(before); expect(memory.saves).toBe(0);
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  await title.fill('Retained while preview unavailable'); await title.press('Enter');
  await page.unroute('**/assets/bootstrap-*.js'); await page.getByRole('button', { name: 'Reload editor', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(await current(page)).toEqual({ ...before, title: 'Retained while preview unavailable', revision: before.revision + 1 });
  expect(memory.saves).toBe(1);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
});

test('a failed deferred inspector is contained and never discards the rest of the editor', async ({ page }) => {
  const before = await current(page);
  await page.route('**/assets/Inspector-*.js', (route) => route.abort('failed')); await page.reload();
  await expect(page.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(await current(page)).toEqual(before);
  await page.unroute('**/assets/Inspector-*.js'); await page.getByRole('button', { name: 'Reload editor', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('failed saving blocks module-recovery reload and the exact in-memory draft remains downloadable', async ({ page }) => {
  const before = await current(page);
  await page.route('**/assets/bootstrap-*.js', (route) => route.abort('failed')); await page.reload();
  await expect(page.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  let writes = 0;
  await page.route(`**/api/projects/${before.id}`, async (route) => {
    if (route.request().method() !== 'PUT') { await route.fallback(); return; }
    writes++; await route.fulfill({ status: 503, json: { error: 'Save storage is unavailable. Draft retained.' } });
  });
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  await title.fill('Downloadable pending edit'); await title.press('Enter');
  await page.getByRole('button', { name: 'Reload editor', exact: true }).click();
  await expect(page.locator('.save-recovery-banner')).toContainText('Draft retained');
  await expect(page.locator('.error-banner')).toContainText('could not be saved');
  await expect(title).toHaveValue('Downloadable pending edit'); expect(memory.snapshot()).toEqual(before); expect(writes).toBe(1);
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const file = await (await downloaded).path(); if (!file) throw new Error('The recovery download must be readable.');
  const draft = projectSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  expect(draft).toEqual({ ...before, title: 'Downloadable pending edit' });
  expect(memory.snapshot()).toEqual(before); expect(writes).toBe(1);
});

test('diagnostic code stays deferred until explicitly opened and does not change decoder ownership or the document', async ({ page }) => {
  const before = await current(page); const requested: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname.includes('/assets/Diagnostics-')) requested.push(request.url()); });
  await page.reload(); await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(requested).toEqual([]);
  await openOptions(page, 'Workspace options'); await page.getByRole('button', { name: 'Toggle diagnostics', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Diagnostics', exact: true })).toBeVisible();
  expect(requested).toHaveLength(1); expect(await current(page)).toEqual(before);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
  expect(submissions).toEqual([]); expect(memory.saves).toBe(0);
});
