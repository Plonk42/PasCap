import { expect, test, type Locator, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { openOptions, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

// Headless Chrome hides scrollbars by default. These cases exercise the real thumb
// and both scrollbar gutters as well as native wheel/focus scrolling.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--autoplay-policy=no-user-gesture-required'] } });

let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
    unexpected = [];
    const library = await (await request.get('/api/media')).json() as { assets: MediaAsset[] };
    const assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
        const asset = library.assets.find((item) => item.name === name && item.status === 'ready' && item.prepared !== null);
        if (!asset) throw new Error('Layer access uses existing prepared synthetic fixtures, never owner media.');
        return asset;
    });
    await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const method = route.request().method();
        const reads: Record<string, unknown> = {
            '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
            '/api/media': { assets }, '/api/audio': { assets: [] }, '/api/jobs': { jobs: [] },
        };
        if (method === 'GET' && reads[pathname] !== undefined) { await route.fulfill({ json: reads[pathname] }); return; }
        const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
        if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) { await route.continue(); return; }
        unexpected.push(`${method} ${pathname}`); await route.abort('blockedbyclient');
    });
    const document = createProject('layer-access-memory', 'Layer access · memory-only');
    document.media.videoIds = assets.map((asset) => asset.id);
    for (let index = 2; index <= 8; index++) document.layers.push({ id: `row-${index}`, name: `Video ${index}`, enabled: true, opacity: 1, keyframes: [] });
    document.layers[6]!.keyframes = [sharedPoint(10, { exposure: 0.2 })];
    document.clips = [createClip('base', assets[0]!.id, 0, 120), { ...createClip('overlay', assets[1]!.id, 15, 45), layerId: 'row-4', start: 30 }];
    memory = await memoryProjects(page, document);
    await page.addInitScript('globalThis.__name = (fn) => fn;');
    await page.goto(`/?project=${document.id}`);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

test.afterEach(() => expect(unexpected, 'Layer access must not import, prepare, render or issue unowned requests').toEqual([]));

async function current(page: Page): Promise<ProjectDocument> { return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())); }
async function resetVertical(viewport: Locator): Promise<void> {
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
}
async function wheelOver(page: Page, viewport: Locator, delta: number): Promise<void> {
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, delta);
}
async function alignedRows(page: Page, count = 8): Promise<void> {
    await expect.poll(() => page.evaluate(() => {
        return Array.from(globalThis.document.querySelectorAll<HTMLElement>('[data-layer-id]')).map((header) => {
            const id = header.dataset['layerId'];
            const lane = globalThis.document.querySelector<HTMLElement>(`[data-layer-lane="${id}"]`);
            if (!lane) throw new Error('Each layer header must have its matching timeline lane.');
            return Math.round((header.getBoundingClientRect().top - lane.getBoundingClientRect().top) * 100) / 100;
        });
    })).toEqual(Array(count).fill(5));
}

test('native wheel scrolling over the timeline reaches hidden rows and music without seeking, editing or saving', async ({ page }) => {
    const before = await current(page);
    const viewport = page.locator('.timeline-scroll');
    await resetVertical(viewport);
    const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
    await wheelOver(page, viewport, 400);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await wheelOver(page, viewport, 2000);
    await expect(page.getByRole('button', { name: 'Timeline lane Video 1', exact: true })).toBeInViewport();
    await expect(page.locator('.music-track-empty')).toBeInViewport();
    await alignedRows(page);
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('wheel scrolling over layer headers reaches all eight rows and keeps the clips synchronized', async ({ page }) => {
    const before = await current(page);
    const viewport = page.locator('.timeline-scroll');
    const headers = page.getByRole('complementary', { name: 'Video layers', exact: true });
    await resetVertical(viewport);
    await expect(page.getByRole('button', { name: 'Select layer Video 8', exact: true })).toBeInViewport();
    await wheelOver(page, headers, 400);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await alignedRows(page);
    await wheelOver(page, headers, 2000);
    await expect(page.getByRole('button', { name: 'Select layer Video 1', exact: true })).toBeInViewport();
    await expect.poll(() => headers.evaluate((element) => element.scrollTop)).toBe(await viewport.evaluate((element) => element.scrollTop));
    await wheelOver(page, headers, -2000);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole('button', { name: 'Select layer Video 8', exact: true })).toBeInViewport();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('the native vertical scrollbar reveals the primary sequence and synchronized header', async ({ page }) => {
    const before = await current(page);
    const viewport = page.locator('.timeline-scroll');
    await resetVertical(viewport);
    const bounds = (await viewport.boundingBox())!;
    const size = await viewport.evaluate((element) => ({ height: element.clientHeight, extent: element.scrollHeight, gutter: (element as HTMLElement).offsetWidth - element.clientWidth }));
    expect(size.gutter).toBeGreaterThan(0);
    const thumbHalf = size.height * size.height / size.extent / 2;
    await page.mouse.move(bounds.x + bounds.width - size.gutter / 2, bounds.y + thumbHalf);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - size.gutter / 2, bounds.y + size.height - 8, { steps: 5 }); await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Select layer Video 1', exact: true })).toBeInViewport();
    await expect(page.locator('.music-track-empty')).toBeInViewport();
    await alignedRows(page);
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('native keyboard focus reveals hidden headers, selects their own row, and synchronizes without a seek or edit', async ({ page }) => {
    const before = await current(page);
    const frame = await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame);
    const viewport = page.locator('.timeline-scroll');
    await resetVertical(viewport);
    const primary = page.getByRole('button', { name: 'Select layer Video 1', exact: true });
    await primary.focus(); await expect(primary).toBeFocused(); await expect(primary).toBeInViewport();
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await alignedRows(page);
    await page.keyboard.press('Tab');
    await expect(page.locator('summary[aria-label="Layer options Video 1"]')).toBeFocused();
    const top = page.getByRole('button', { name: 'Select layer Video 8', exact: true });
    await top.focus(); await top.press('Enter');
    await expect(top).toHaveAttribute('aria-pressed', 'true'); await expect(top).toBeInViewport();
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
    await alignedRows(page);
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(frame);
});

test('horizontal scrolling remains independent and synchronized vertical extents exclude the horizontal scrollbar', async ({ page }) => {
    const document = await current(page);
    document.clips[0]!.speed = { mode: 'constant', rate: 0.5 };
    memory.seed(document); await page.reload();
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    await page.getByRole('slider', { name: 'Timeline zoom', exact: true }).fill('180');
    const viewport = page.locator('.timeline-scroll');
    const headers = page.getByRole('complementary', { name: 'Video layers', exact: true });
    await expect.poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
    const bounds = (await viewport.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(400, 0);
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const left = await viewport.evaluate((element) => element.scrollLeft);
    await resetVertical(viewport); await wheelOver(page, headers, 2000);
    await expect.poll(() => headers.evaluate((element) => element.scrollTop)).toBe(await viewport.evaluate((element) => element.scrollHeight - element.clientHeight));
    expect(await headers.evaluate((element) => ({ height: element.clientHeight, max: element.scrollHeight - element.clientHeight }))).toEqual(await viewport.evaluate((element) => ({ height: element.clientHeight, max: element.scrollHeight - element.clientHeight })));
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBe(left);
    expect(await headers.evaluate((element) => element.scrollLeft)).toBe(0);
    await alignedRows(page);
    expect(await current(page)).toEqual(document); expect(memory.saves).toBe(0);
});

for (const { width, height } of [{ width: 1440, height: 900 }, { width: 1024, height: 720 }, { width: 720, height: 720 }, { width: 640, height: 600 }, { width: 1440, height: 480 }]) {
    test(`all eight rows remain reachable and aligned in the ${width}×${height} workspace`, async ({ page }) => {
        const before = await current(page);
        await page.setViewportSize({ width, height });
        const viewport = page.locator('.timeline-scroll');
        const headers = page.getByRole('complementary', { name: 'Video layers', exact: true });
        await resetVertical(viewport); await wheelOver(page, headers, 2000);
        await expect(page.getByRole('button', { name: 'Select layer Video 1', exact: true })).toBeInViewport();
        await expect(page.locator('.music-track-empty')).toBeInViewport();
        await alignedRows(page);
        await wheelOver(page, viewport, -2000);
        await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0);
        await expect(page.getByRole('button', { name: 'Select layer Video 8', exact: true })).toBeInViewport();
        await alignedRows(page);
        expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    });
}

test('primary and stack-edge restrictions explain their disabled state while valid overlay actions remain enabled', async ({ page }) => {
    const before = await current(page);
    await openOptions(page, 'Layer options Video 1');
    await expect(page.getByText('Primary sequence · fixed bottom row. Delete excerpts, not this layer.', { exact: true })).toBeVisible();
    for (const action of ['Raise', 'Lower', 'Delete']) {
        const button = page.getByRole('button', { name: `${action} layer Video 1`, exact: true });
        await expect(button).toBeDisabled(); await expect(button).toHaveAccessibleDescription(/primary sequence/i);
    }
    await page.keyboard.press('Escape'); await openOptions(page, 'Layer options Video 8');
    await expect(page.getByRole('button', { name: 'Raise layer Video 8', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Raise layer Video 8', exact: true })).toHaveAccessibleDescription('This overlay is already the top layer.');
    await expect(page.getByRole('button', { name: 'Lower layer Video 8', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Delete layer Video 8', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape'); await openOptions(page, 'Layer options Video 2');
    await expect(page.getByRole('button', { name: 'Lower layer Video 2', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Lower layer Video 2', exact: true })).toHaveAccessibleDescription(/cannot move below/);
    await expect(page.getByRole('button', { name: 'Raise layer Video 2', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Delete layer Video 2', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape'); await openOptions(page, 'Layer options Video 4');
    for (const action of ['Raise', 'Lower', 'Delete']) await expect(page.getByRole('button', { name: `${action} layer Video 4`, exact: true })).toBeEnabled();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('overlay raise, lower and delete each keep other data unchanged and require exactly one Undo through synchronized scrolling', async ({ page }) => {
    const before = await current(page);
    for (const [action, order] of [
        ['Raise', ['Video 1', 'Video 2', 'Video 3', 'Video 5', 'Video 4', 'Video 6', 'Video 7', 'Video 8']],
        ['Lower', ['Video 1', 'Video 2', 'Video 4', 'Video 3', 'Video 5', 'Video 6', 'Video 7', 'Video 8']],
    ] as const) {
        await openOptions(page, 'Layer options Video 4');
        await page.getByRole('button', { name: `${action} layer Video 4`, exact: true }).click();
        const after = await current(page);
        expect(after.layers.map((layer) => layer.name)).toEqual(order); expect(after.clips).toEqual(before.clips);
        expect([...after.layers].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...before.layers].sort((a, b) => a.id.localeCompare(b.id)));
        await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Undo', exact: true }).click();
        expect(await current(page)).toEqual(before); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
        await alignedRows(page);
    }
    await wheelOver(page, page.locator('.timeline-scroll'), 2000);
    await openOptions(page, 'Layer options Video 4');
    await page.getByRole('button', { name: 'Delete layer Video 4', exact: true }).click();
    const after = await current(page);
    expect(after.layers).toEqual(before.layers.filter((layer) => layer.id !== 'row-4'));
    expect(after.clips).toEqual(before.clips.filter((clip) => clip.layerId !== 'row-4'));
    await alignedRows(page, 7);
    await expect.poll(() => page.locator('.layer-sidebar').evaluate((element) => element.scrollTop)).toBe(await page.locator('.timeline-scroll').evaluate((element) => element.scrollTop));
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(before); await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await alignedRows(page);
});

test('active shared-point capture still blocks layer mutations and Escape restores its complete unsaved draft', async ({ page }) => {
    const before = await current(page);
    const marker = page.getByRole('button', { name: 'Layer keyframe 10 on Video 7', exact: true });
    await marker.scrollIntoViewIfNeeded();
    const bounds = (await marker.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 16, bounds.y + bounds.height / 2, { steps: 3 });
    await expect(page.locator('.timeline-surface')).toHaveClass(/keyframe-drafting/);
    for (const action of ['Raise', 'Lower', 'Delete']) {
        const button = page.getByRole('button', { name: `${action} layer Video 7`, exact: true, includeHidden: true });
        await expect(button).toBeDisabled(); await expect(button).toHaveAccessibleDescription(/Finish or cancel the active edit/);
    }
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.timeline-surface')).not.toHaveClass(/keyframe-drafting/);
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});