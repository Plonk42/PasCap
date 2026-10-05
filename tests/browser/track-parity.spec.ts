import { expect, test, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import type { ExportProfile } from '../../src/shared/export.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';
import { closeOptions, expandedInspectorPreferences, inspectorTab, openOptions, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

const PROJECT_ID = 'track-parity-memory';
let assets: MediaAsset[];
let music: AudioAsset;
let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
    unexpected = [];
    const videoResponse = await request.get('/api/media');
    expect(videoResponse.ok()).toBe(true);
    const library = await videoResponse.json() as { assets: MediaAsset[] };
    assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
        const asset = library.assets.find((item) => item.name === name && item.status === 'ready' && item.prepared !== null);
        if (!asset || !asset.sourcePath.endsWith(`/synthetic-sources/${name}`)) throw new Error('Track parity requires existing prepared synthetic fixtures; no preparation is attempted.');
        expect(asset.metadata.frameCount).toBe(120);
        return asset;
    });
    const audioResponse = await request.get('/api/audio');
    expect(audioResponse.ok()).toBe(true);
    const audio = await audioResponse.json() as { assets: AudioAsset[] };
    const track = audio.assets.find((item) => item.name === 'test-music.wav' && item.status === 'ready');
    if (!track || !track.sourcePath.endsWith('/synthetic-sources/test-music.wav')) throw new Error('Track parity uses only the existing synthetic music fixture.');
    music = track;

    await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const method = route.request().method();
        const reads: Record<string, unknown> = {
            '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
            '/api/media': { assets }, '/api/audio': { assets: [music] }, '/api/jobs': { jobs: [] },
        };
        if (method === 'GET' && reads[pathname] !== undefined) { await route.fulfill({ json: reads[pathname] }); return; }
        if (method === 'POST' && pathname === '/api/exports/preflight') {
            const body = route.request().postDataJSON() as { document: unknown; profile: ExportProfile };
            await route.fulfill({
                json: {
                    space: {
                        directory: '/disposable/track-parity/renders', availableBytes: 64 * 1024 ** 3,
                        estimate: estimateExportSpace(projectSchema.parse(body.document), body.profile),
                        status: 'available', checkedAt: '2026-10-05T10:00:00Z',
                    }
                }
            });
            return;
        }
        const video = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
        const audioPlayback = /^\/api\/audio\/([^/]+)\/(?:playback|waveform)$/.exec(pathname);
        if (method === 'GET' && ((video && assets.some((asset) => asset.id === video[1])) || (audioPlayback && audioPlayback[1] === music.id))) { await route.continue(); return; }
        unexpected.push(`${method} ${pathname}`); await route.abort('blockedbyclient');
    });
    const document = twoTracks();
    memory = await memoryProjects(page, document);
    await expandedInspectorPreferences(page);
    await page.addInitScript('globalThis.__name = (fn) => fn;');
    await page.goto(`/?project=${PROJECT_ID}`);
    await ready(page, document);
});

test.afterEach(() => expect(unexpected, 'Only synthetic proxy reads, memory project CRUD and mocked storage preflight are allowed; never import, prepare or render').toEqual([]));

function twoTracks(): ProjectDocument {
    const document = createProject(PROJECT_ID, 'Uniform video tracks · memory-only');
    document.media.videoIds = assets.map((asset) => asset.id);
    document.layers.push(createLayer('upper', 'Video 2'));
    document.clips = [createClip('bottom', assets[0]!.id, 0, 120), createClip('upper-clip', assets[1]!.id, 0, 120, 'upper')];
    return projectSchema.parse(document);
}

async function current(page: Page): Promise<ProjectDocument> { return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())); }
async function ready(page: Page, document: ProjectDocument): Promise<void> {
    await expect.poll(() => page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { status: state?.status, duration: state?.duration, playing: state?.playing };
    })).toEqual({ status: document.clips.length ? 'paused' : 'empty', duration: calculateLayout(document).duration, playing: false });
}
async function fixture(page: Page, document: ProjectDocument): Promise<void> {
    await page.evaluate(() => window.pascapLab!.flush());
    memory.seed(document); await page.reload(); await ready(page, document);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
}
async function undoOnce(page: Page, before: ProjectDocument): Promise<void> {
    await closeOptions(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await current(page)).toEqual(before); await ready(page, before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
}
function trackGeometry(document: ProjectDocument, layerId: string) {
    return calculateLayout(document).clips.filter((placed) => placed.clip.layerId === layerId).map((placed) => [placed.clip.id, placed.start, placed.end]);
}
async function selectClip(page: Page, id: string): Promise<void> {
    const button = page.locator(`[data-clip-id="${id}"] .timeline-clip-body`);
    await button.click(); await expect(button).toHaveAttribute('aria-pressed', 'true');
    await ready(page, await current(page));
}
async function commitNumber(page: Page, name: string, value: number): Promise<void> {
    const field = page.getByRole('spinbutton', { name, exact: true });
    await field.fill(String(value)); await field.press('Enter'); await field.press('Tab');
}
async function captureAt(page: Page, frame: number) {
    const captured = await page.evaluate(async (position) => {
        const engine = window.pascapLab!.engine; await engine.seek(position);
        const pixels = engine.capturePixels(); let sum = 0;
        for (let index = 0; index < pixels.length; index += 4) sum += pixels[index]! + pixels[index + 1]! + pixels[index + 2]!;
        return { state: engine.diagnostics(), sum, sample: Array.from(pixels.slice(100_000, 100_512)) };
    }, frame);
    expect(captured.state.status, captured.state.message).toBe('paused');
    expect(captured.state.frame).toBe(frame); expect(captured.state.playing).toBe(false);
    return captured;
}

test('the initial track and every newly added track default to Ripple on with independent strict schema-6 fields', async ({ page }) => {
    const before = await current(page);
    for (const layer of before.layers) {
        expect(layer).toMatchObject({ ripple: true, transitions: [], openingFade: 0, closingFade: 0 });
        await openOptions(page, `Layer options ${layer.name}`);
        await expect(page.getByRole('checkbox', { name: `Ripple on layer ${layer.name}`, exact: true })).toBeChecked();
        await expect(page.getByRole('textbox', { name: `Rename layer ${layer.name}`, exact: true })).toBeEnabled();
        await expect(page.getByRole('slider', { name: `Opacity of layer ${layer.name}`, exact: true })).toBeEnabled();
        await closeOptions(page);
    }
    await page.getByRole('button', { name: 'Add video layer', exact: true }).click();
    const added = await current(page); await ready(page, added);
    expect(added.schemaVersion).toBe(6);
    for (const field of ['transitions', 'openingFade', 'closingFade']) expect(added).not.toHaveProperty(field);
    expect(added.layers.slice(0, 2)).toEqual(before.layers); expect(added.clips).toEqual(before.clips);
    expect(added.layers[2]).toEqual(createLayer(added.layers[2]!.id, 'Video 3'));
    await openOptions(page, 'Layer options Video 3');
    await expect(page.getByRole('checkbox', { name: 'Ripple on layer Video 3', exact: true })).toBeChecked();
    await expect(page.locator('.layer-control.selected')).toHaveAttribute('data-layer-id', added.layers[2]!.id);
    await undoOnce(page, before);
});

for (const row of [0, 1]) {
    test(`enabling Ripple on row ${row + 1} packs only that track from its nonzero anchor and preserves its dissolve in one Undo`, async ({ page }) => {
        const document = twoTracks();
        document.clips = [];
        for (const [index, layer] of document.layers.entries()) {
            layer.ripple = false; layer.openingFade = 2; layer.closingFade = 3;
            layer.keyframes = [sharedPoint(15, { exposure: 0.2 }), sharedPoint(500, { layerOpacity: 0.8 }, 'hold')];
            const anchor = index === 0 ? 40 : 200;
            document.clips.push(
                { ...createClip(`a-${index}`, assets[0]!.id, 0, 30, layer.id), start: anchor },
                { ...createClip(`b-${index}`, assets[1]!.id, 30, 60, layer.id), start: anchor + 60 },
                { ...createClip(`c-${index}`, assets[0]!.id, 60, 90, layer.id), start: anchor + 80 },
            );
            layer.transitions = [
                { leftId: `a-${index}`, rightId: `b-${index}`, type: 'cut', duration: 0 },
                { leftId: `b-${index}`, rightId: `c-${index}`, type: 'cross-dissolve', duration: 10 },
            ];
        }
        document.media.audioIds = [music.id];
        document.music = { mediaId: music.id, sourceIn: 0, sourceOut: 60, start: 17, duration: 90, gainDb: -9, fadeIn: 4, fadeOut: 5, loop: true };
        await fixture(page, document);
        const before = await current(page); const saves = memory.saves;
        const layer = before.layers[row]!; const anchor = row === 0 ? 40 : 200;
        await openOptions(page, `Layer options ${layer.name}`);
        await page.getByRole('checkbox', { name: `Ripple on layer ${layer.name}`, exact: true }).check();
        const packed = await current(page); await ready(page, packed);
        expect(trackGeometry(packed, layer.id)).toEqual([[`a-${row}`, anchor, anchor + 30], [`b-${row}`, anchor + 30, anchor + 60], [`c-${row}`, anchor + 50, anchor + 80]]);
        expect(packed.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, ripple: true } : item));
        expect(packed.clips).toEqual(before.clips.map((clip) => clip.layerId === layer.id ? { ...clip, start: ({ [`a-${row}`]: anchor, [`b-${row}`]: anchor + 30, [`c-${row}`]: anchor + 50 })[clip.id]! } : clip));
        expect(trackGeometry(packed, before.layers[1 - row]!.id)).toEqual(trackGeometry(before, before.layers[1 - row]!.id));
        expect(packed.music).toEqual(before.music); expect(packed.media).toEqual(before.media);
        await page.evaluate(() => window.pascapLab!.flush()); expect(memory.saves).toBe(saves + 1);
        expect(memory.snapshot().layers).toEqual(packed.layers); expect(memory.snapshot().clips).toEqual(packed.clips);
        await undoOnce(page, before);
        await page.getByRole('button', { name: 'Redo', exact: true }).click(); expect(await current(page)).toEqual(packed);
        await page.evaluate(() => window.pascapLab!.flush()); await page.reload(); await ready(page, packed);
        const reopened = await current(page); expect(reopened.layers).toEqual(packed.layers); expect(reopened.clips).toEqual(packed.clips); expect(reopened.music).toEqual(before.music);
    });

    test(`row ${row + 1} allows the first Ripple anchor but disables later starts/nudges only until Ripple is turned off`, async ({ page }) => {
        const document = twoTracks(); document.clips = [];
        for (const [index, layer] of document.layers.entries()) {
            document.clips.push({ ...createClip(`first-${index}`, assets[0]!.id, 0, 40, layer.id), start: 7 }, { ...createClip(`later-${index}`, assets[1]!.id, 40, 80, layer.id), start: 47 });
            layer.transitions = [{ leftId: `first-${index}`, rightId: `later-${index}`, type: 'cut', duration: 0 }];
        }
        await fixture(page, document); const before = await current(page); const layer = before.layers[row]!;
        await selectClip(page, `first-${row}`);
        const start = page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true });
        await expect(start).toBeEnabled(); await expect(start).toHaveValue('7');
        await openOptions(page, 'Clip actions');
        for (const name of ['Move clip one frame earlier', 'Move clip one frame later']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
        await closeOptions(page);
        await commitNumber(page, 'Clip timeline start', 13);
        const anchored = await current(page);
        expect(trackGeometry(anchored, layer.id)).toEqual([[`first-${row}`, 13, 53], [`later-${row}`, 53, 93]]);
        expect(anchored.clips).toEqual(before.clips.map((clip) => clip.layerId === layer.id ? { ...clip, start: clip.id === `first-${row}` ? 13 : 53 } : clip));
        expect(anchored.layers).toEqual(before.layers);
        await undoOnce(page, before);
        await selectClip(page, `later-${row}`);
        await expect(start).toBeDisabled(); await expect(start).toHaveAccessibleDescription(/Ripple is on: this start follows the packed sequence/);
        await openOptions(page, 'Clip actions');
        for (const name of ['Move clip one frame earlier', 'Move clip one frame later']) {
            await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
            await expect(page.getByRole('button', { name, exact: true })).toHaveAccessibleDescription(/Ripple is on/);
        }
        await closeOptions(page); await openOptions(page, `Layer options ${layer.name}`);
        await page.getByRole('checkbox', { name: `Ripple on layer ${layer.name}`, exact: true }).uncheck();
        const positioned = await current(page);
        expect(positioned.clips).toEqual(before.clips);
        expect(positioned.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, ripple: false } : item));
        await closeOptions(page); await ready(page, positioned);
        await openOptions(page, 'Clip actions');
        for (const name of ['Move clip one frame earlier', 'Move clip one frame later']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
        await closeOptions(page);
        await expect(start).toBeEnabled(); await commitNumber(page, 'Clip timeline start', 72);
        const moved = await current(page);
        expect(moved.clips).toEqual(positioned.clips.map((clip) => clip.id === `later-${row}` ? { ...clip, start: 72 } : clip));
        expect(moved.layers).toEqual(positioned.layers);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await current(page)).toEqual(positioned);
        await undoOnce(page, before);
    });
}

test('a contextually invalid Ripple enable is rejected as a whole without changing fades, points, history or saves', async ({ page }) => {
    const document = twoTracks(); const upper = document.layers[1]!;
    upper.ripple = false; upper.closingFade = 10;
    upper.keyframes = [sharedPoint(0, { speed: 8, exposure: 0.4 }, 'hold'), sharedPoint(100, { speed: 0.5 }, 'hold')];
    upper.transitions = [{ leftId: 'fast', rightId: 'slow', type: 'cut', duration: 0 }];
    document.clips = [document.clips[0]!, { ...createClip('fast', assets[0]!.id, 0, 30, upper.id), start: 20 }, { ...createClip('slow', assets[1]!.id, 30, 60, upper.id), start: 100 }];
    await fixture(page, document); const before = await current(page); const saves = memory.saves;
    await openOptions(page, 'Layer options Video 2');
    const ripple = page.getByRole('checkbox', { name: 'Ripple on layer Video 2', exact: true });
    await ripple.click(); await expect(ripple).not.toBeChecked();
    await expect(page.locator('.error-banner')).toContainText('Fade/transition regions overlap or exceed clip slow.');
    expect(await current(page)).toEqual(before);
    await page.evaluate(() => window.pascapLab!.flush()); expect(memory.saves).toBe(saves); expect(memory.snapshot()).toEqual(before);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

function boundaries(): ProjectDocument {
    const document = twoTracks(); document.clips = [];
    for (const [index, layer] of document.layers.entries()) {
        layer.ripple = false; layer.openingFade = 2 + index * 4; layer.closingFade = 4 + index * 4;
        document.clips.push({ ...createClip(`left-${index}`, assets[0]!.id, 0, 60, layer.id), start: index * 20 }, { ...createClip(`right-${index}`, assets[1]!.id, 0, 60, layer.id), start: index * 20 + 60 });
        layer.transitions = [{ leftId: `left-${index}`, rightId: `right-${index}`, type: 'cut', duration: 0 }];
    }
    return projectSchema.parse(document);
}

test('each row has its own boundary button and Sequence edits target only the selected track fades and transition', async ({ page }) => {
    await fixture(page, boundaries()); const before = await current(page);
    const buttons = page.locator('.boundary-button'); await expect(buttons).toHaveCount(2);
    for (const [index, layer] of before.layers.entries()) {
        const boundary = page.locator(`.boundary-button[data-transition-layer="${layer.id}"]`);
        await expect(boundary).toHaveCount(1); await expect(boundary).toHaveText('Cut');
        const buttonTop = await boundary.evaluate((element) => Number.parseFloat((element as HTMLElement).style.top));
        const laneTop = await page.locator(`[data-layer-lane="${layer.id}"]`).evaluate((element) => Number.parseFloat((element as HTMLElement).style.top));
        expect(buttonTop - laneTop).toBe(9);
        await boundary.click();
        // Boundary controls sit above the seam, but the trim handle's centre
        // must still be a real pointer target rather than covered by the button.
        for (const [clipId, edge] of [[`left-${index}`, 'out'], [`right-${index}`, 'in']] as const) {
            const handle = page.locator(`[data-clip-id="${clipId}"] [data-trim-handle="${edge}"]`);
            await handle.scrollIntoViewIfNeeded();
            expect(await handle.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return globalThis.document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('[data-trim-handle]') === element;
            })).toBe(true);
        }
        await expect(page.getByRole('tab', { name: 'Sequence', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.layer-control.selected')).toHaveAttribute('data-layer-id', layer.id);
        await expect(page.getByRole('spinbutton', { name: 'Opening fade', exact: true })).toHaveValue(String(layer.openingFade));
        await expect(page.getByRole('spinbutton', { name: 'Closing fade', exact: true })).toHaveValue(String(layer.closingFade));
        await commitNumber(page, 'Opening fade', 12);
        const faded = await current(page);
        expect(faded.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, openingFade: 12 } : item));
        expect(faded.clips).toEqual(before.clips); await undoOnce(page, before);
        await boundary.click(); await commitNumber(page, 'Closing fade', 14);
        const closed = await current(page);
        expect(closed.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, closingFade: 14 } : item));
        expect(closed.clips).toEqual(before.clips); await undoOnce(page, before);
        await boundary.click();
        await page.getByRole('combobox', { name: 'Transition type', exact: true }).selectOption('cross-dissolve');
        const dissolved = await current(page);
        expect(dissolved.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, transitions: [{ leftId: `left-${index}`, rightId: `right-${index}`, type: 'cross-dissolve', duration: 30 }] } : item));
        expect(dissolved.clips).toEqual(before.clips.map((clip) => clip.id === `right-${index}` ? { ...clip, start: index * 20 + 30 } : clip));
        expect(trackGeometry(dissolved, before.layers[1 - index]!.id)).toEqual(trackGeometry(before, before.layers[1 - index]!.id));
        await expect(boundary).toHaveText('Dissolve'); await undoOnce(page, before);
        await boundary.click();
        await page.getByRole('combobox', { name: 'Transition type', exact: true }).selectOption('fade-through-black');
        const blackFade = await current(page);
        expect(blackFade.layers).toEqual(before.layers.map((item) => item.id === layer.id ? { ...item, transitions: [{ leftId: `left-${index}`, rightId: `right-${index}`, type: 'fade-through-black', duration: 30 }] } : item));
        expect(blackFade.clips).toEqual(before.clips); await expect(boundary).toHaveText('Fade');
        await undoOnce(page, before);
    }
});

test('a positioned gap disables non-cut boundary choices until explicit Ripple packing closes that track only', async ({ page }) => {
    const document = boundaries(); document.clips.find((clip) => clip.id === 'right-1')!.start = 100;
    await fixture(page, document); const before = await current(page);
    const boundary = page.locator('.boundary-button[data-transition-layer="upper"]'); await boundary.click();
    const type = page.getByRole('combobox', { name: 'Transition type', exact: true });
    for (const value of ['fade-through-black', 'cross-dissolve']) await expect(type.locator(`option[value="${value}"]`)).toHaveJSProperty('disabled', true);
    await expect(page.getByText('These clips have a gap. Close it explicitly, or enable this track’s Ripple in Layer options, before adding a fade or dissolve.', { exact: true })).toBeVisible();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(0);
    await openOptions(page, 'Layer options Video 2'); await page.getByRole('checkbox', { name: 'Ripple on layer Video 2', exact: true }).check();
    await closeOptions(page); await boundary.click();
    for (const value of ['fade-through-black', 'cross-dissolve']) await expect(type.locator(`option[value="${value}"]`)).toHaveJSProperty('disabled', false);
    const packed = await current(page);
    expect(trackGeometry(packed, 'upper')).toEqual([['left-1', 20, 80], ['right-1', 80, 140]]);
    expect(packed.layers).toEqual(before.layers.map((layer) => layer.id === 'upper' ? { ...layer, ripple: true } : layer));
    expect(packed.clips).toEqual(before.clips.map((clip) => clip.id === 'right-1' ? { ...clip, start: 80 } : clip));
    await undoOnce(page, before);
});

test('a top-track opening black fade keeps opaque coverage instead of fading or revealing the lower track', async ({ page }) => {
    const document = twoTracks(); document.layers[1]!.openingFade = 4; document.clips[1]!.start = 20;
    await fixture(page, document); const before = await current(page);
    const sampled = sampleTimeline(before, 20);
    expect(sampled.map((source) => [source.layerId, source.brightness, source.opacity, source.layerOpacity])).toEqual([['video-1', 1, 1, 1], ['upper', 0, 1, 1]]);
    expect((await captureAt(page, 20)).sum).toBe(0);
    await page.getByRole('button', { name: 'Hide layer Video 2', exact: true }).click();
    expect((await captureAt(page, 20)).sum).toBeGreaterThan(0);
    const hidden = await current(page);
    expect(hidden.layers).toEqual(before.layers.map((layer) => layer.id === 'upper' ? { ...layer, enabled: false } : layer));
    expect(hidden.clips).toEqual(before.clips); await undoOnce(page, before);
    expect((await captureAt(page, 20)).sum).toBe(0);
});

test('Raise and Lower cross the old initial-layer boundary and display the new bottom-to-top order without changing track data', async ({ page }) => {
    const before = await current(page); const originalPixels = (await captureAt(page, 20)).sample;
    for (const [action, name] of [['Lower', 'Video 2'], ['Raise', 'Video 1']] as const) {
        await openOptions(page, `Layer options ${name}`); await page.getByRole('button', { name: `${action} layer ${name}`, exact: true }).click();
        const after = await current(page); await ready(page, after);
        expect(after.layers).toEqual([before.layers[1], before.layers[0]]); expect(after.clips).toEqual(before.clips);
        expect(await page.locator('[data-layer-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-layer-id')))).toEqual(['upper', 'video-1']);
        const laneTops = await page.locator('[data-layer-lane]').evaluateAll((rows) => rows.map((row) => Number.parseFloat((row as HTMLElement).style.top)));
        expect(laneTops).toEqual([53, 141]);
        expect((await captureAt(page, 20)).sample).not.toEqual(originalPixels);
        await undoOnce(page, before);
        expect((await captureAt(page, 20)).sample).toEqual(originalPixels);
    }
});

test('the ordinary initial track can be removed; only deleting the last remaining track is forbidden and one Undo restores everything', async ({ page }) => {
    const before = await current(page);
    await openOptions(page, 'Layer options Video 1'); await page.getByRole('button', { name: 'Delete layer Video 1', exact: true }).click();
    const after = await current(page); await ready(page, after);
    expect(after.layers).toEqual([before.layers[1]]); expect(after.clips).toEqual([before.clips[1]]);
    expect(after.media).toEqual(before.media); expect(after.music).toEqual(before.music);
    await expect(page.locator('[data-layer-id]')).toHaveCount(1); await expect(page.locator('[data-layer-lane="video-1"]')).toHaveCount(0);
    await openOptions(page, 'Layer options Video 2');
    const remove = page.getByRole('button', { name: 'Delete layer Video 2', exact: true });
    await expect(remove).toBeDisabled(); await expect(remove).toHaveAccessibleDescription('Keep at least one video track. Delete its excerpts instead.');
    await expect(page.getByRole('checkbox', { name: 'Ripple on layer Video 2', exact: true })).toBeEnabled();
    await undoOnce(page, before);
});

test('eight concurrent track dissolves use exactly sixteen reusable decoder slots and releasing a track shrinks the pool', async ({ page }) => {
    const document = twoTracks(); document.layers = [createLayer('video-1', 'Video 1')]; document.clips = [];
    for (let index = 0; index < 8; index++) {
        const layer = index === 0 ? document.layers[0]! : createLayer(`row-${index + 1}`, `Video ${index + 1}`);
        if (index > 0) document.layers.push(layer);
        document.clips.push(createClip(`left-${index}`, assets[0]!.id, 0, 60, layer.id), { ...createClip(`right-${index}`, assets[1]!.id, 0, 60, layer.id), start: 40 });
        layer.transitions = [{ leftId: `left-${index}`, rightId: `right-${index}`, type: 'cross-dissolve', duration: 20 }];
    }
    await fixture(page, document); const before = await current(page);
    const expected = sampleTimeline(before, 50); expect(expected).toHaveLength(16);
    await captureAt(page, 50);
    const captured = await page.evaluate(() => ({
        state: window.pascapLab!.engine.diagnostics(),
        videos: Array.from(globalThis.document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'), (video) => ({ seeking: video.seeking, readyState: video.readyState, frame: Math.floor(video.currentTime * 30000 / 1001 + 1e-7) })),
    }));
    expect(captured.state.status, captured.state.message).toBe('paused'); expect(captured.state.frame).toBe(50); expect(captured.state.decoderCount).toBe(16);
    await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(16);
    expect(captured.state.assignedClipIds.filter((id) => id !== null).sort()).toEqual(expected.map((source) => source.clipId).sort());
    for (const source of expected) {
        const slot = captured.state.assignedClipIds.indexOf(source.clipId); expect(slot).toBeGreaterThanOrEqual(0);
        expect(captured.videos[slot]).toMatchObject({ seeking: false, frame: source.sourceFrame });
        expect(captured.videos[slot]!.readyState).toBeGreaterThanOrEqual(2);
    }
    await openOptions(page, 'Layer options Video 8'); await page.getByRole('button', { name: 'Delete layer Video 8', exact: true }).click();
    const after = await current(page); await ready(page, after);
    expect(after.layers).toEqual(before.layers.slice(0, 7)); expect(after.clips).toEqual(before.clips.filter((clip) => clip.layerId !== 'row-8'));
    await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(14);
    await undoOnce(page, before); await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(16);
});

test('export discloses three timeline representations and four 22-byte-per-pixel raw buffers without starting a render', async ({ page }) => {
    const before = await current(page); const saves = memory.saves;
    await inspectorTab(page, 'Clip'); await page.getByRole('button', { name: 'Export video', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
    await dialog.getByText('Rendering details', { exact: true }).click();
    const resources = dialog.locator('.activity-export-warning');
    await expect(resources).toContainText('Up to 2 lossless clips and 3 full-timeline representations.');
    await expect(resources).toContainText('4 reusable raw buffers use 20.3 MB at 1280 × 720; up to 2 LUTs add 6.6 MB.');
    await expect(resources).toContainText('Per-pass maxima: 1 original decoder, 2 intermediate readers, 1 encoder, and 3 video child processes in total. These maxima do not all occur together.');
    await dialog.getByRole('radio', { name: '4K final', exact: true }).check();
    await expect(resources).toContainText('4 reusable raw buffers use 182.5 MB at 3840 × 2160; up to 2 LUTs add 6.6 MB.');
    await expect(dialog.locator('.activity-export-snapshot')).toContainText('each track’s Ripple, transitions and fades, enabled layers, bottom-to-top composition order');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await current(page)).toEqual(before); expect(memory.saves).toBe(saves);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});