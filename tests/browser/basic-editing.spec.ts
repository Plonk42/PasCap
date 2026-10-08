import { expect, test, type Page } from '@playwright/test';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { closeOptions, inspectorTab, openOptions, sharedPoint } from './editor-helpers.js';

let saved: ProjectDocument;
let assets: MediaAsset[];
test.beforeEach(async ({ page, request }) => {
  assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  saved = createProject('preview-lab', 'Basic editing · memory-only');
  saved.media.videoIds = assets.map((asset) => asset.id);
  saved = applyCommand(saved, {
    type: 'insert',
    clip: createClip('base', assets.find((asset) => asset.name === 'pattern-a.mp4')!.id, 0, 120),
    index: 0,
  });
  await page.route('**/api/projects', (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: saved.id,
            title: saved.title,
            revision: saved.revision,
            clipCount: saved.clips.length,
            duration: calculateLayout(saved).duration,
            updatedAt: '2026-10-03T10:00:00Z',
            compatible: true,
            error: null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/projects/preview-lab', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { document: saved } });
      return;
    }
    const body = route.request().postDataJSON() as { document: unknown; expectedRevision: number };
    if (body.expectedRevision !== saved.revision) {
      await route.fulfill({ status: 409, json: { error: 'Fixture revision mismatch' } });
      return;
    }
    saved = projectSchema.parse({ ...projectSchema.parse(body.document), revision: saved.revision + 1 });
    await route.fulfill({ json: { document: saved } });
  });
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}
async function installOverlay(page: Page, start = 20): Promise<void> {
  let document = await current(page);
  document = applyCommand(document, { type: 'layer-add', layer: createLayer('upper', 'Video 2', false) });
  document = applyCommand(document, {
    type: 'insert',
    clip: {
      ...createClip('moving', assets.find((asset) => asset.name === 'pattern-b.mp4')!.id, 15, 45),
      layerId: 'upper',
      start,
    },
    index: 1,
  });
  await page.evaluate((next) => window.pascapLab!.setDocument(next), document);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await page.locator('[data-clip-id="moving"] .timeline-clip-body').click();
  await page.evaluate(() => window.pascapLab!.flush());
}

async function beginMove(page: Page, desiredStart: number, grab = 12, alt = false, layerId = 'upper'): Promise<number> {
  const clip = page.locator('[data-clip-id="moving"]');
  await clip.scrollIntoViewIfNeeded();
  const box = (await clip.boundingBox())!;
  const surface = page.locator('.timeline-surface');
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  const origin = (await surface.boundingBox())!.x + Number(await surface.getAttribute('data-leading'));
  const lane = (await page.locator(`[data-layer-lane="${layerId}"]`).boundingBox())!;
  const targetY = lane.y + 38;
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.move(box.x + grab * scale, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + grab * scale + 12, box.y + 30, { steps: 3 });
  await page.mouse.move(origin + (desiredStart + grab) * scale, targetY, { steps: 8 });
  await page.mouse.move(origin + (desiredStart + grab) * scale, targetY);
  await expect(page.locator('.timeline-drop-preview')).toBeVisible();
  return Number(await page.locator('.timeline-drop-preview').getAttribute('data-drop-start'));
}

test('default editor keeps rare options, speed/layer details, track settings and music out of clip context', async ({
  page,
}) => {
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Speed mode', exact: true })).toBeHidden();
  await expect(page.getByLabel('Placement section', { exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Clip timeline start', exact: true })).toBeHidden();
  await expect(page.getByRole('slider', { name: 'Layer opacity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Opening fade', exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Music track', exact: true })).toBeHidden();
  await expect(page.getByRole('combobox', { name: 'Filter media' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Prepare selected' })).toHaveCount(0);
  await openOptions(page, 'Media options');
  await expect(page.getByRole('combobox', { name: 'Filter media' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('summary[aria-label="Media options"]')).toBeFocused();
  await inspectorTab(page, 'Track');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toHaveValue('1');
  await expect(page.getByRole('spinbutton', { name: 'Opening fade' })).toBeVisible();
  await expect(page.getByLabel('Placement section', { exact: true })).toBeHidden();
  await inspectorTab(page, 'Audio');
  await expect(page.getByRole('combobox', { name: 'Music track', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Opening fade' })).toBeHidden();
});

test('overlay drop keeps the grabbed source position under the mouse and commits exactly its ghost in one undo step', async ({
  page,
}) => {
  await installOverlay(page);
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
  const before = await current(page);
  const preview = await beginMove(page, 85);
  expect(preview).toBe(85);
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-layer', 'upper');
  expect((await current(page)).clips[1]?.start).toBe(20);
  await page.mouse.up();
  await expect.poll(async () => (await current(page)).clips.find((clip) => clip.id === 'moving')?.start).toBe(preview);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
});

test('snaps either edge to the shown guide, bypasses with Alt, and never snaps to its old start', async ({ page }) => {
  await installOverlay(page);
  await page.evaluate(() => window.pascapLab!.engine.seek(80));
  const endSnap = await beginMove(page, 92);
  expect(endSnap).toBe(90);
  const guide = page.locator('.snap-guide');
  await expect(guide).toBeVisible();
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  const leading = Number(await page.locator('.timeline-surface').getAttribute('data-leading'));
  expect(Number.parseFloat(await guide.evaluate((element) => (element as HTMLElement).style.left))).toBeCloseTo(
    leading + 120 * scale,
  );
  await page.mouse.up();
  expect((await current(page)).clips[1]?.start).toBe(90);
  const bypass = await beginMove(page, 92, 12, true);
  expect(bypass).toBe(92);
  await expect(guide).toHaveCount(0);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect((await current(page)).clips[1]?.start).toBe(92);
  await page.evaluate(() => window.pascapLab!.engine.seek(80));
  const away = await beginMove(page, 94);
  expect(away).toBe(90); // End still snaps to the other clip's 120 boundary, not old 92.
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await current(page)).clips[1]?.start).toBe(92);
});

test('invalid overlap is visibly rejected and cancelled movement never changes the source or placement', async ({
  page,
}) => {
  await installOverlay(page);
  let document = await current(page);
  document = applyCommand(document, {
    type: 'insert',
    clip: { ...createClip('occupied', assets[0]!.id, 0, 30), layerId: 'upper', start: 70 },
    index: 2,
  });
  await page.evaluate((next) => window.pascapLab!.setDocument(next), document);
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
  const before = await current(page);
  await beginMove(page, 80);
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-valid', 'false');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.timeline-drop-preview')).toHaveCount(0);
  expect(await current(page)).toEqual(before);
});

test('a Ripple track marker is the exact final start after removal, including movement across video rows', async ({
  page,
}) => {
  await installOverlay(page);
  const start = await beginMove(page, 100, 12, false, 'video-1');
  expect(start).toBe(120);
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-layer', 'video-1');
  await expect(page.locator('.timeline-drop-preview')).toContainText('Ripple insert');
  await page.mouse.up();
  const document = await current(page);
  expect(document.clips.find((clip) => clip.id === 'moving')?.layerId).toBe('video-1');
  expect(calculateLayout(document).clips.find((clip) => clip.clip.id === 'moving')?.start).toBe(start);
});

test('media overlay drop uses the same snapped ghost and copies the applied source excerpt', async ({ page }) => {
  await installOverlay(page);
  await page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Source IN', exact: true }).fill('15');
  await page.getByRole('spinbutton', { name: 'Source OUT', exact: true }).fill('45');
  await page.getByRole('button', { name: 'Apply source range' }).click();
  const button = page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true });
  const box = (await button.boundingBox())!;
  const surface = page.locator('.timeline-surface');
  const bounds = (await surface.boundingBox())!;
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  const leading = Number(await surface.getAttribute('data-leading'));
  const lane = (await page.locator('[data-layer-lane="upper"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(bounds.x + leading + 118 * scale, lane.y + 38, { steps: 8 });
  await page.mouse.move(bounds.x + leading + 118 * scale, lane.y + 38);
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-start', '120');
  await expect(page.locator('.timeline-drop-preview')).toHaveAttribute('data-drop-layer', 'upper');
  await page.mouse.up();
  await expect.poll(async () => (await current(page)).clips.length).toBe(3);
  expect((await current(page)).clips[2]).toMatchObject({ layerId: 'upper', start: 120, sourceIn: 15, sourceOut: 45 });
});

test('duplicate preserves static settings without copying row points, and overlay nudge remains exact and context guarded', async ({
  page,
}) => {
  await installOverlay(page);
  let document = await current(page);
  document = applyCommand(document, {
    type: 'colour',
    layerId: document.clips[1]!.layerId,
    colour: {
      ...document.layers.find((layer) => layer.id === document.clips[1]!.layerId)!.colour,
      contrast: 1.3,
      saturation: 0.7,
    },
  });
  document = applyCommand(document, { type: 'opacity', layerId: document.clips[1]!.layerId, opacity: 0.6 });
  document = applyCommand(document, {
    type: 'layer-update',
    layer: {
      ...document.layers[1]!,
      keyframes: [sharedPoint(10, { exposure: -0.2 }), sharedPoint(70, { exposure: 0.4 }, 'smooth')],
    },
  });
  await page.evaluate((next) => window.pascapLab!.setDocument(next), document);
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('Control+d');
  const duplicated = await current(page);
  const copy = duplicated.clips[2]!;
  expect(copy.id).not.toBe('moving');
  expect(copy).toEqual({ ...duplicated.clips[1]!, id: copy.id, start: 50 });
  expect(copy).not.toHaveProperty('animation');
  expect(duplicated.layers[1]?.keyframes).toEqual(document.layers[1]?.keyframes);
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('Alt+Shift+ArrowRight');
  expect((await current(page)).clips[2]?.start).toBe(60);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips[2]?.start).toBe(50);
  await page.getByRole('textbox', { name: 'Project title', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect((await current(page)).clips[2]?.start).toBe(50);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).clips).toHaveLength(2);
  expect((await current(page)).layers[1]?.keyframes).toEqual(document.layers[1]?.keyframes);
});

test('layer rename drafts cancel or commit without affecting ranges/order, and restore with Undo', async ({ page }) => {
  await installOverlay(page);
  const before = await current(page);
  await openOptions(page, 'Layer options Video 2');
  const name = page.getByRole('textbox', { name: 'Rename layer Video 2', exact: true });
  await name.fill('Scenic overlay');
  await name.press('Escape');
  expect((await current(page)).layers[1]?.name).toBe('Video 2');
  await openOptions(page, 'Layer options Video 2');
  await name.fill('Scenic overlay');
  await name.press('Enter');
  expect((await current(page)).layers[1]?.name).toBe('Scenic overlay');
  expect((await current(page)).clips).toEqual(before.clips);
  await closeOptions(page);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await current(page)).layers[1]?.name).toBe('Video 2');
});

test('partial proxy admission errors preserve import success and accepted jobs without repeating the request', async ({
  page,
}) => {
  const job: MediaJob = {
    id: 'auto-queue-preview',
    label: 'pattern-a.mp4',
    kind: 'prepare',
    state: 'queued',
    progress: 0,
    message: 'Queued',
    createdAt: '2026-10-03T10:00:00Z',
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
  };
  let calls = 0;
  await page.route('**/api/media/import', async (route) => {
    calls++;
    await route.fulfill({
      status: 202,
      json: {
        assets: [assets[0]],
        errors: [],
        ignored: 0,
        added: 1,
        existing: 0,
        jobs: [job],
        queueErrors: [{ mediaId: assets[0]!.id, message: 'Queue persistence unavailable; retry explicitly.' }],
      },
    });
  });
  await page.route('**/api/jobs', (route) => route.fulfill({ json: { jobs: [job] } }));
  await page.getByRole('button', { name: 'Import folder', exact: true }).click();
  await page.getByText('Import a whole folder by path', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Absolute folder path on this machine' }).fill('/tmp/disposable-source');
  await page.getByRole('button', { name: 'Register recordings' }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText('Recordings were kept');
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText(
    '1 editing proxies queued automatically',
  );
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Open activity' }).click();
  await expect(page.getByRole('region', { name: 'Active jobs' })).toContainText('pattern-a.mp4');
  expect(calls).toBe(1);
});
