import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import type { ExportProfile } from '../../src/shared/export.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
    unexpected = [];
    const library = await (await request.get('/api/media')).json() as { assets: MediaAsset[] };
    const assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
        const asset = library.assets.find((item) => item.name === name && item.status === 'ready' && item.prepared !== null);
        if (!asset) throw new Error('Help checks require existing prepared synthetic fixtures, never owner media.');
        return asset;
    });
    const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.filter((asset) => asset.status === 'ready');
    await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const method = route.request().method();
        const reads: Record<string, unknown> = {
            '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
            '/api/media': { assets }, '/api/audio': { assets: audio }, '/api/jobs': { jobs: [] },
        };
        if (method === 'GET' && reads[pathname] !== undefined) { await route.fulfill({ json: reads[pathname] }); return; }
        if (method === 'POST' && pathname === '/api/exports/preflight') {
            const body = route.request().postDataJSON() as { document: ProjectDocument; profile: ExportProfile };
            await route.fulfill({ json: { space: { directory: '/disposable/help-cache/renders', availableBytes: 64 * 1024 ** 3, estimate: estimateExportSpace(projectSchema.parse(body.document), body.profile), status: 'available', checkedAt: '2026-10-04T10:00:00Z' } } });
            return;
        }
        const video = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
        const music = /^\/api\/audio\/([^/]+)\/(?:playback|waveform)$/.exec(pathname);
        if (method === 'GET' && ((video && assets.some((asset) => asset.id === video[1])) || (music && audio.some((asset) => asset.id === music[1])))) { await route.continue(); return; }
        unexpected.push(`${method} ${pathname}`); await route.abort('blockedbyclient');
    });
    const document = createProject('help-popover-memory', 'Inline help · memory-only');
    document.media.videoIds = assets.map((asset) => asset.id);
    document.clips = [createClip('help-left', assets[0]!.id, 0, 120), createClip('help-right', assets[1]!.id, 0, 120)];
    document.transitions = [{ leftId: 'help-left', rightId: 'help-right', type: 'cut', duration: 0 }];
    document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0 }), sharedPoint(90, { exposure: 0.8 })];
    const track = audio[0];
    if (!track) throw new Error('Help checks require the dedicated prepared synthetic audio fixture.');
    document.media.audioIds = [track.id];
    document.music = { mediaId: track.id, sourceIn: 0, sourceOut: Math.min(60, track.metadata.frameCount), start: 0, duration: 240, gainDb: 0, fadeIn: 0, fadeOut: 0, loop: true };
    memory = await memoryProjects(page, document);
    await expandedInspectorPreferences(page);
    await page.addInitScript('globalThis.__name = (fn) => fn;');
    await page.goto(`/?project=${document.id}`);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

test.afterEach(() => expect(unexpected, 'Help must not import, prepare, render or issue an unowned request').toEqual([]));

async function current(page: Page): Promise<ProjectDocument> { return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())); }
async function panelFor(page: Page, trigger: Locator): Promise<Locator> {
    const id = await trigger.getAttribute('aria-controls');
    if (!id) throw new Error('Help must expose its controlled content.');
    return page.locator(`[id="${id}"]`);
}

test('hover help preserves focus, stays readable across the gap, and leaves without editing or saving', async ({ page }) => {
    const before = await current(page);
    const title = page.getByRole('textbox', { name: 'Project title', exact: true });
    await title.focus();
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.hover(); await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true'); await expect(trigger).toHaveAttribute('aria-pressed', 'false');
    await expect(title).toBeFocused();
    const box = (await panel.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20); await expect(panel).toBeVisible();
    await expect(panel).toContainText('All participating settings share one point');
    await page.mouse.move(600, 20); await expect(panel).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(title).toBeFocused();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('click pins an already-hovered panel until an outside click, without stealing the clicked control focus', async ({ page }) => {
    const before = await current(page);
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.hover(); await expect(panel).toBeVisible(); await trigger.click();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(600, 20); await expect(panel).toBeVisible();
    const outside = page.getByRole('button', { name: 'Toggle Media panel', exact: true });
    await outside.click(); await expect(panel).toBeHidden(); await expect(outside).toBeFocused();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('keyboard focus previews, Enter and Space pin, and help keys never fire timeline shortcuts', async ({ page }) => {
    const before = await current(page);
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.focus(); await expect(panel).toBeVisible();
    await trigger.press('Enter'); await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await trigger.press('s'); await trigger.press('ArrowRight'); await trigger.press('Delete');
    expect(await current(page)).toEqual(before);
    expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
    await trigger.press('ArrowDown'); await expect(panel).toBeFocused();
    await panel.press('s'); await panel.press('Escape');
    await expect(panel).toBeHidden(); await expect(trigger).toBeFocused();
    await trigger.press('Space'); await expect(panel).toBeVisible(); await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await trigger.press('Escape'); await expect(panel).toBeHidden();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('Escape closes a hover preview before cancelling an underlying invalid numeric draft', async ({ page }) => {
    const before = await current(page);
    const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
    await input.fill('0.5'); await input.press('Enter'); await expect(input).toHaveAttribute('aria-invalid', 'true');
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.hover(); await expect(panel).toBeVisible(); await expect(input).toBeFocused();
    await input.press('Escape'); await expect(panel).toBeHidden();
    await expect(input).toBeFocused(); await expect(input).toHaveValue('0.5');
    await input.press('Escape'); await expect(input).toHaveValue('0');
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
});

test('changing Inspector context without clicking dismisses help whose owner becomes hidden', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.click(); await expect(panel).toBeVisible();
    const clipTab = page.getByRole('tab', { name: 'Clip', exact: true });
    await clipTab.focus(); await clipTab.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Sequence', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel).toHaveJSProperty('popover', 'manual');
    await expect.poll(() => panel.evaluate((element) => element.matches(':popover-open'))).toBe(false);
    expect(memory.saves).toBe(0);
});

test('options retain click-only disclosure behavior rather than opening on hover', async ({ page }) => {
    const options = page.locator('summary[aria-label="Media options"]');
    await options.hover(); await expect(options).toHaveAttribute('aria-expanded', 'false');
    await options.click(); await expect(options).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(options).toBeFocused();
    expect(memory.saves).toBe(0);
});
