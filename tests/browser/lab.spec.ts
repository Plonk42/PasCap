import { expect, test, type Page } from '@playwright/test';
import type { ExportReceipt } from '../../src/server/export.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { planExportMusic } from '../../src/shared/export.js';
import { createClip, createLayer, createProject, projectSchema } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  clipAction,
  closeOptions,
  expandedInspectorPreferences,
  freshExportLinks,
  inspectorTab,
  openOptions,
  submitExport,
} from './editor-helpers.js';

test.beforeEach(async ({ page, request }) => {
  await expandedInspectorPreferences(page);
  // Reset only the dedicated synthetic project, never the user's saved edit.
  const registered = (await (await request.get('/api/media')).json()) as { assets: { id: string; name: string }[] };
  const audio = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  const saved = projectSchema.parse(
    ((await (await request.get('/api/projects/preview-lab')).json()) as { document: unknown }).document,
  );
  // Import specs deliberately extend the shared registry. This project's bin
  // must retain the exact twelve baseline fixtures, not adopt those imports.
  const videos = [
    'pattern-a.mp4',
    'pattern-b.mp4',
    ...Array.from({ length: 10 }, (_, index) => `recording-${String(index + 3).padStart(2, '0')}.mp4`),
  ].map((name) => {
    const matches = registered.assets.filter((asset) => asset.name === name);
    expect(matches, `Exactly one baseline recording ${name}`).toHaveLength(1);
    return matches[0]!;
  });
  let project = createProject('preview-lab', 'Synthetic editor · disposable');
  project.media = {
    videoIds: videos.map((asset) => asset.id),
    audioIds: audio.assets.map((asset) => asset.id),
  };
  for (const [index, name] of ['pattern-a.mp4', 'pattern-b.mp4'].entries()) {
    const asset = registered.assets.find((item) => item.name === name)!;
    project = applyCommand(project, {
      type: 'insert',
      clip: createClip(index === 0 ? 'clip-a' : 'clip-b', asset.id, 15, 105),
      index,
    });
  }
  project = applyCommand(project, {
    type: 'transition',
    transition: { leftId: 'clip-a', rightId: 'clip-b', type: 'cross-dissolve', duration: 18 },
  });
  const response = await request.put('/api/projects/preview-lab', {
    headers: { 'X-PasCap-Client': 'preview-lab' },
    data: { document: { ...project, revision: saved.revision }, expectedRevision: saved.revision },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

test('compact library handles 12 recordings and the editor fits the desktop viewport', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Media 12', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Video timeline' })).toBeInViewport();
  await expect(page.getByRole('article')).toHaveCount(12);
  await page.getByRole('textbox', { name: 'Search media' }).fill('pattern-a');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Search media' }).fill('');
  await openOptions(page, 'Media options');
  await page.getByRole('combobox', { name: 'Filter media' }).selectOption('ready');
  await expect(page.getByRole('article')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Filter media' }).selectOption('unprepared');
  await expect(page.getByRole('article')).toHaveCount(9);
  await page.getByRole('combobox', { name: 'Filter media' }).selectOption('all');
  await page.getByRole('combobox', { name: 'Sort media' }).selectOption('recent');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  await expect(page.locator('.media-items')).toHaveClass('media-items grid');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await closeOptions(page);
  expect(await page.locator('.media-items').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
});

test('removes fixed A/B slots, promotional text and default technical clutter', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Clip [AB]/ })).toHaveCount(0);
  await expect(page.getByText('One colour contract.')).toHaveCount(0);
  await expect(page.getByText('Local-first. Landscape-minded.')).toHaveCount(0);
  await expect(page.getByText('Find the feeling.')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle('PasCap');
});

test('seeks by clicking and dragging the timeline ruler without a duplicate position slider', async ({ page }) => {
  await expect(page.getByRole('slider', { name: 'Timeline position', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Timeline zoom', exact: true })).toBeVisible();
  const surface = page.locator('.timeline-surface');
  const ruler = page.locator('.timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
  const leading = Number(await surface.getAttribute('data-leading'));
  const scrollLeft = await page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft);
  const xAt = (frame: number): number => box.x + leading + frame * scale;
  const y = box.y + box.height / 2;

  await page.mouse.click(xAt(30), y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame };
      }),
    )
    .toEqual({ status: 'paused', frame: 30 });
  await page.mouse.move(xAt(30), y);
  await page.mouse.down();
  await page.mouse.move(xAt(90), y, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab!.engine.diagnostics();
        return { status: state.status, frame: state.frame };
      }),
    )
    .toEqual({ status: 'paused', frame: 90 });
  const playheadLeft = Number.parseFloat(
    await page.locator('.timeline-playhead').evaluate((element) => (element as HTMLElement).style.left),
  );
  expect(playheadLeft).toBeCloseTo(leading + 90 * scale);
  expect(await page.locator('.timeline-scroll').evaluate((element) => element.scrollLeft)).toBe(scrollLeft);

  await page.getByRole('button', { name: 'Next frame', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(91);
});

test('GPU matches CPU for neutral, each control and a combined grade', async ({ page }) => {
  const settings = [
    NEUTRAL_COLOUR,
    ...[
      { exposure: 1 },
      { brightness: 0.1 },
      { contrast: 1.3 },
      { hue: 45 },
      { saturation: 0.4 },
      { highlights: -0.5 },
      { shadows: 0.3 },
    ].map((change) => ({ ...NEUTRAL_COLOUR, ...change })),
    {
      ...NEUTRAL_COLOUR,
      exposure: 0.6,
      brightness: 0.02,
      contrast: 1.1,
      hue: 12,
      saturation: 1.2,
      highlights: -0.2,
      shadows: 0.15,
    },
  ];
  const results = await page.evaluate(
    (grades) => grades.map((grade) => window.pascapLab!.verifyColour(grade)),
    settings,
  );
  for (const result of results) {
    expect(result.meanAbsoluteError8Bit).toBeLessThan(0.35);
    expect(result.maxError8Bit).toBeLessThan(0.7);
  }
});

test('paused grading changes pixels immediately and saves/reloads the selected clip', async ({ page }) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(30));
  const before = await page.evaluate(() =>
    Array.from(window.pascapLab!.engine.capturePixels().slice(100_000, 100_004)),
  );
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.7');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().colourLatencyMs !== null);
  const after = await page.evaluate(() => Array.from(window.pascapLab!.engine.capturePixels().slice(100_000, 100_004)));
  expect(after).not.toEqual(before);
  await page.evaluate(() => window.pascapLab!.flush());
  await expect(page.getByRole('status', { name: 'Saved on this device' })).toContainText('Saved locally');
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0.7');
  await page.getByRole('button', { name: 'Reset colour' }).click();
  await page.evaluate(() => window.pascapLab!.flush());
});

test('seeks before, inside and after every transition and cancels obsolete scrubs', async ({ page }) => {
  await inspectorTab(page, 'Sequence');
  for (const type of ['cut', 'fade-through-black', 'cross-dissolve']) {
    await page.getByRole('combobox', { name: 'Transition type' }).selectOption(type);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    const positions = type === 'cross-dissolve' ? [60, 75, 100] : [60, 89, 90, 110];
    for (const frame of positions) {
      const result = await page.evaluate(async (position) => {
        const engine = window.pascapLab!.engine;
        await engine.seek(position);
        return engine.diagnostics();
      }, frame);
      expect(result.frame).toBe(frame);
      expect(result.status).toBe('paused');
    }
  }
  await page.evaluate(async () => {
    const engine = window.pascapLab!.engine;
    await Promise.all([engine.seek(1), engine.seek(60), engine.seek(120)]);
  });
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(120);
});

test('playback and colour updates run outside React, shortcuts ignore text inputs', async ({ page }) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(10));
  await page.getByRole('textbox', { name: 'Search media' }).focus();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().playing)).toBe(false);
  await page.getByRole('button', { name: 'Play preview' }).click();
  await page.waitForFunction(() => (window.pascapLab?.engine.diagnostics().frame ?? 0) > 20);
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('0.2');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().colourLatencyMs !== null);
  await page.getByRole('button', { name: 'Pause preview' }).click();
  await page.getByRole('button', { name: 'Reset colour' }).click();
  await page.evaluate(() => window.pascapLab!.flush());
});

test('disposal removes both decoder elements and stops engine playback', async ({ page }) => {
  await page.evaluate(() => window.pascapLab!.engine.dispose());
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(0);
  await expect(page.locator('audio[data-pascap-music]')).toHaveCount(0);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().status)).toBe('disposed');
});

test('rejects a trim beyond the registered recording without persisting it', async ({ page }) => {
  const original = await page.getByRole('spinbutton', { name: 'Source OUT frame' }).inputValue();
  await page.getByRole('spinbutton', { name: 'Source OUT frame' }).fill('999');
  await page.getByRole('spinbutton', { name: 'Source OUT frame' }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Enter 120 or less');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceOut)).toBe(Number(original));
  await page.getByRole('spinbutton', { name: 'Source OUT frame' }).press('Escape');
  await expect(page.getByRole('spinbutton', { name: 'Source OUT frame' })).toHaveValue(original);
});

async function dragTrim(page: Page, clipId: string, edge: 'in' | 'out', delta: number): Promise<void> {
  const snap = page.getByRole('button', { name: 'Toggle snapping' });
  if ((await snap.getAttribute('aria-pressed')) === 'true') await snap.click();
  const handle = page.locator(`[data-clip-id="${clipId}"] [data-trim-handle="${edge}"]`);
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta * scale, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
}

test('drag handles trim non-destructively, restore both ends, ripple and undo one gesture', async ({ page }) => {
  await dragTrim(page, 'clip-a', 'in', 30);
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips[0]).toMatchObject({ sourceIn: 45, sourceOut: 105 });
  expect(calculateLayout(project).clips[1]?.start).toBe(42);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('15');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('45');
  await dragTrim(page, 'clip-a', 'out', -15);
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips[0]).toMatchObject({ sourceIn: 45, sourceOut: 90 });
  await dragTrim(page, 'clip-a', 'in', -45);
  await dragTrim(page, 'clip-a', 'out', 30);
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips[0]).toMatchObject({ sourceIn: 0, sourceOut: 120 });
  expect(project.clips[1]).toMatchObject({ sourceIn: 15, sourceOut: 105 });
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(page.getByRole('spinbutton', { name: 'Source OUT frame' })).toHaveValue('120');
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('0');
});

test('trim drafts do not change the committed project or autosave; Escape cancels', async ({ page }) => {
  const handle = page.locator('[data-clip-id="clip-a"] [data-trim-handle="in"]');
  const box = (await handle.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  let saves = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/projects/')) saves++;
  });
  await page.mouse.move(box.x + 5, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 5 + 30 * scale, box.y + 25, { steps: 6 });
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('45');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceIn)).toBe(15);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('15');
  expect(saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('creates, renames and reopens distinct projects without losing unsaved edits', async ({ page, request }) => {
  await page.getByRole('textbox', { name: 'Project title' }).fill('First flight renamed');
  await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('textbox', { name: 'New project title' }).fill('Second flight');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue('Second flight');
  const second = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(second.media).toEqual({ videoIds: [], audioIds: [] });
  // Deliberately seed this editing fixture's bin; a new project does not inherit global media.
  const registered = (await (await request.get('/api/media')).json()) as { assets: { id: string; name: string }[] };
  second.media.videoIds = [registered.assets.find((asset) => asset.name === 'pattern-a.mp4')!.id];
  await page.evaluate((document) => window.pascapLab!.setDocument(document), second);
  await page.evaluate(() => window.pascapLab!.flush());
  await page.getByRole('button', { name: 'Add pattern-a.mp4 to timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Open projects' }).click();
  await page.getByRole('button', { name: 'Open First flight renamed', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue('First flight renamed');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(2);
  await page.getByRole('button', { name: 'Open projects' }).click();
  // Titles are not unique; repeated isolated runs may retain another "Second flight".
  await page.getByRole('searchbox', { name: 'Search projects', exact: true }).fill(second.id);
  await page.getByRole('button', { name: 'Open Second flight', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue('Second flight');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(1);
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue('Second flight');
});

test('snaps ruler and directly dragged playhead to boundaries, with a toggle', async ({ page }) => {
  const ruler = page.locator('.timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const leading = Number(await page.locator('.timeline-surface').getAttribute('data-leading'));
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await page.mouse.click(box.x + leading + 70 * scale, box.y + 18);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(72);
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
  await page.mouse.click(box.x + leading + 70 * scale, box.y + 18);
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(70);
  const handle = page.getByRole('button', { name: 'Drag playhead' });
  const head = (await handle.boundingBox())!;
  await page.mouse.move(head.x + head.width / 2, head.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + leading + 110 * scale, head.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(110);
});

test('constant speed retimes only the selected clip and split respects mapped source frames', async ({ page }) => {
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).fill('0.5');
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).press('Enter');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips[0]?.speed).toEqual({ mode: 'constant', rate: 0.5 });
  expect(project.clips[1]?.speed).toEqual({ mode: 'constant', rate: 1 });
  expect(calculateLayout(project).duration).toBe(252);
  await page.evaluate(() => window.pascapLab!.engine.seek(60));
  await clipAction(page, 'Split at playhead');
  project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips).toHaveLength(3);
  expect(project.clips[0]?.sourceOut).toBe(45);
  expect(project.clips[1]?.sourceIn).toBe(45);
  expect(project.clips[1]?.speed).toEqual({ mode: 'constant', rate: 0.5 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).fill('2');
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).press('Enter');
  expect(calculateLayout(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()))).duration).toBe(
    117,
  );
});

test('each ramp curve saves and restores along with shared row Colour', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Speed mode' }).selectOption('ramp-up');
  for (const curve of ['linear', 'ease-in', 'ease-out', 'smooth']) {
    await page.getByRole('combobox', { name: 'Ramp curve' }).selectOption(curve);
    await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
    const state = await page.evaluate(async () => {
      const engine = window.pascapLab!.engine;
      await engine.seek(30);
      engine.capturePixels();
      return engine.diagnostics();
    });
    expect(state.status, state.message).toBe('paused');
    expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.speed.mode)).toBe('ramp');
  }
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.6');
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(page.getByRole('combobox', { name: 'Ramp curve' })).toHaveValue('smooth');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0.6');
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.colour.exposure)).toBe(0.6);
});

test('music waveform, placement, looping, gain, fades and audio-clock preview work', async ({ page, request }) => {
  await inspectorTab(page, 'Audio');
  const audio = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  await page.getByRole('combobox', { name: 'Music recording' }).selectOption(audio.assets[0]!.id);
  await page.getByText('Placement & fades', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Music timeline start' }).fill('10');
  await page.getByRole('spinbutton', { name: 'Music timeline start' }).press('Enter');
  await page.getByRole('checkbox', { name: 'Loop music' }).check();
  await page.getByRole('spinbutton', { name: 'Music source OUT' }).fill('90');
  await page.getByRole('spinbutton', { name: 'Music source OUT' }).press('Enter');
  await page.getByRole('spinbutton', { name: 'Music duration', exact: true }).fill('140');
  await page.getByRole('spinbutton', { name: 'Music duration', exact: true }).press('Enter');
  await page.getByRole('spinbutton', { name: 'Music gain', exact: true }).fill('-6');
  await page.getByRole('spinbutton', { name: 'Music gain', exact: true }).press('Enter');
  await page.getByRole('spinbutton', { name: 'Music fade in', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Music fade in', exact: true }).press('Enter');
  await page.getByRole('spinbutton', { name: 'Music fade out', exact: true }).fill('15');
  await page.getByRole('spinbutton', { name: 'Music fade out', exact: true }).press('Enter');
  await expect(page.getByRole('img', { name: 'Waveform for music track 1:', exact: false })).toBeVisible();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await page.evaluate(async () => {
    await window.pascapLab!.engine.seek(50);
    await window.pascapLab!.engine.play();
  });
  await page.waitForFunction(() => (window.pascapLab?.engine.diagnostics().frame ?? 0) > 105, undefined, {
    timeout: 12_000,
  });
  await page.getByRole('button', { name: 'Pause preview' }).click();
  const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
  expect(state.audioClock).toBe(true);
  expect(state.status, state.message).not.toBe('error');
  await page.evaluate(() => window.pascapLab!.flush());
  await page.reload();
  await inspectorTab(page, 'Audio');
  await expect(page.getByRole('spinbutton', { name: 'Music gain' })).toHaveValue('-6');
  await expect(page.getByRole('checkbox', { name: 'Loop music' })).toBeChecked();
});

test('music drag placement is one undoable edit and Escape discards its draft', async ({ page, request }) => {
  await inspectorTab(page, 'Audio');
  const audio = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  await page.getByRole('combobox', { name: 'Music recording' }).selectOption(audio.assets[0]!.id);
  await page.getByRole('button', { name: 'Toggle snapping' }).click();
  const body = page.getByRole('button', { name: 'Move music track 1:', exact: false });
  const box = (await body.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await page.mouse.move(box.x + 25, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 25 + 20 * scale, box.y + 25, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.pascapLab!.project()!.music[0]!.start)).toBe(20);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await page.evaluate(() => window.pascapLab!.project()!.music[0]!.start)).toBe(0);
  const restored = (await body.boundingBox())!;
  await page.mouse.move(restored.x + 25, restored.y + 25);
  await page.mouse.down();
  await page.mouse.move(restored.x + 25 + 10 * scale, restored.y + 25, { steps: 3 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await page.evaluate(() => window.pascapLab!.project()!.music[0]!.start)).toBe(0);
});

test('plays both ramp directions across dissolves and music source wraps on repeated playback', async ({
  page,
  request,
}) => {
  test.setTimeout(40_000);
  const audio = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  await page.getByRole('button', { name: 'Add recording-03.mp4 to timeline' }).click();
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  for (const [index, clip] of project.clips.entries()) {
    project = applyCommand(project, { type: 'trim', clipId: clip.id, sourceIn: 15, sourceOut: 75 });
    project = applyCommand(project, {
      type: 'speed',
      clipId: clip.id,
      speed: {
        mode: 'ramp',
        startRate: index === 1 ? 2 : 0.5,
        endRate: index === 1 ? 0.5 : 2,
        curve: index === 0 ? 'linear' : index === 1 ? 'smooth' : 'ease-out',
        anchorIn: 15,
        anchorOut: 75,
      },
    });
  }
  for (const boundary of project.layers[0]!.transitions)
    project = applyCommand(project, {
      type: 'transition',
      transition: { leftId: boundary.leftId, rightId: boundary.rightId, type: 'cross-dissolve', duration: 12 },
    });
  const duration = calculateLayout(project).duration;
  project = applyCommand(project, {
    type: 'music',
    music: [
      {
        id: 'ramp-music',
        mediaId: audio.assets[0]!.id,
        sourceIn: 30,
        sourceOut: 60,
        start: 10,
        duration: duration - 10,
        gainDb: -9,
        fadeIn: 6,
        fadeOut: 12,
        loop: true,
      },
    ],
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  for (let pass = 0; pass < 2; pass++) {
    await page.evaluate(async () => {
      const engine = window.pascapLab!.engine;
      await engine.seek(0);
      await engine.play();
    });
    await page.waitForFunction(
      () => {
        const state = window.pascapLab!.engine.diagnostics();
        return (
          state.status === 'error' ||
          (state.status === 'paused' && !state.playing && state.frame === state.duration - 1)
        );
      },
      undefined,
      { timeout: 15_000 },
    );
    const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
    expect(state.status, state.message).toBe('paused');
    expect(state.frame).toBe(duration - 1);
    expect(state.audioClock).toBe(true);
    expect(state.decoderCount).toBe(2);
  }
});

test('speed changes while playing pause and reload the mapped frame without losing the grade', async ({ page }) => {
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.4');
  await page.getByRole('button', { name: 'Play preview' }).click();
  await page.waitForFunction(() => (window.pascapLab?.engine.diagnostics().frame ?? 0) >= 20);
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).fill('1.5');
  await page.getByRole('spinbutton', { name: 'Clip speed rate' }).press('Enter');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  const project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips[0]?.speed).toEqual({ mode: 'constant', rate: 1.5 });
  expect(project.layers[0]?.colour.exposure).toBe(0.4);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().playing)).toBe(false);
});

test('exports a multi-clip retimed/graded music edit and serves verified snapshot outputs', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const audio = (await (await request.get('/api/audio')).json()) as { assets: { id: string }[] };
  await page.getByRole('button', { name: 'Add recording-03.mp4 to timeline' }).click();
  let project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  for (const clip of project.clips)
    project = applyCommand(project, { type: 'trim', clipId: clip.id, sourceIn: 15, sourceOut: 45 });
  project = applyCommand(project, {
    type: 'speed',
    clipId: project.clips[0]!.id,
    speed: { mode: 'constant', rate: 0.5 },
  });
  project = applyCommand(project, {
    type: 'music',
    music: [
      {
        id: 'export-music',
        mediaId: audio.assets[0]!.id,
        sourceIn: 0,
        sourceOut: 30,
        start: 10,
        duration: 102,
        gainDb: -6,
        fadeIn: 5,
        fadeOut: 10,
        loop: true,
      },
    ],
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const accepted = await submitExport(page);
  const { outputUrl: file, receiptUrl } = await freshExportLinks(page, request, accepted, 60_000);
  const receipt = (await (await request.get(receiptUrl)).json()) as ExportReceipt;
  expect(receipt.verification.frameCount).toBe(calculateLayout(project).duration);
  expect(receipt.verification.width).toBe(1280);
  expect(receipt.verification.audio).toMatchObject({ codec: 'aac', sampleRate: 48_000, channels: 2 });
  expect(receipt.musicSources.map((source) => source.id)).toEqual([audio.assets[0]!.id]);
  expect(receipt.settings.audio).toEqual(
    project.music.map((track) => planExportMusic(track, calculateLayout(project).duration)),
  );
  expect(receipt).not.toHaveProperty('musicSource');
  expect(projectSchema.parse(receipt.snapshot).clips[0]?.speed).toEqual({ mode: 'constant', rate: 0.5 });
  expect((await request.get(file, { headers: { Range: 'bytes=0-99' } })).status()).toBe(206);
  const parsed = projectSchema.parse(receipt.snapshot);
  await page.getByRole('textbox', { name: 'Project title', exact: true }).fill('Later edit does not change render');
  const again = (await (await request.get(receiptUrl)).json()) as { snapshot: unknown };
  expect(projectSchema.parse(again.snapshot)).toEqual(parsed);
});

test('export cancellation stops native work and publishes no incomplete output link', async ({ page, request }) => {
  test.setTimeout(60_000);
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('radio', { name: '4K final', exact: true }).check();
  const accepted = await submitExport(page);
  const cancel = page.getByRole('button', { name: `Cancel ${accepted.label}`, exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.locator('.activity-job').filter({ hasText: accepted.label }).first()).toHaveAttribute(
    'data-state',
    'cancelled',
    { timeout: 15_000 },
  );
  const queue = (await (await request.get('/api/jobs')).json()) as {
    jobs: { id: string; kind: string; state: string; outputUrl: string | null; receiptUrl: string | null }[];
  };
  expect(queue.jobs.find((job) => job.id === accepted.id)).toMatchObject({
    kind: 'export',
    state: 'cancelled',
    outputUrl: null,
    receiptUrl: null,
  });
});

test('rejects transition-overlapping drag and stops outward handles at source limits', async ({ page }) => {
  await dragTrim(page, 'clip-a', 'out', -85);
  await expect(page.getByRole('alert')).toContainText('Fade/transition regions overlap');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceOut)).toBe(105);
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await dragTrim(page, 'clip-a', 'out', 140);
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[0]!.sourceOut)).toBe(120);
});

test('dragging a Media multi-selection inserts every recording into Ripple-on and Ripple-off rows as one undo step', async ({
  page,
}) => {
  const base = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const rippleId = base.layers[0]!.id;
  await page.evaluate(
    (document) => window.pascapLab!.setDocument(document),
    applyCommand(base, { type: 'layer-add', layer: createLayer('positioned', 'Positioned', false) }),
  );
  await page.getByRole('checkbox', { name: 'Select pattern-a.mp4', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select pattern-b.mp4', exact: true }).check();
  const summary = page.locator('.library-summary');
  await expect(summary).toContainText('2 selected');
  await expect(page.getByRole('button', { name: 'Add selected' })).toHaveCount(0);
  await expect(page.getByText('Insert into')).toHaveCount(0);
  await expect(summary.getByRole('button', { name: 'Clear selected', exact: true })).toBeVisible();
  const ids = base.media.videoIds.slice(0, 2);
  const source = page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: 'Review pattern-b.mp4', exact: true }) });
  const surface = page.locator('.timeline-surface');
  const drop = async (layerId: string, frame: number): Promise<void> => {
    const leading = Number(await surface.getAttribute('data-leading'));
    const scale = Number(await surface.getAttribute('data-pixels-per-frame'));
    const area = (await surface.boundingBox())!;
    const lane = (await page.locator(`[data-layer-lane="${layerId}"]`).boundingBox())!;
    await source.dragTo(surface, {
      targetPosition: { x: leading + frame * scale, y: lane.y - area.y + lane.height / 2 },
    });
  };
  const added = async (layerId: string) => {
    const project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
    return calculateLayout(project)
      .clips.filter((placed) => placed.clip.layerId === layerId)
      .filter((placed) => !base.clips.some((clip) => clip.id === placed.clip.id))
      .map((placed) => ({
        mediaId: placed.clip.mediaId,
        range: [placed.clip.sourceIn, placed.clip.sourceOut],
        placed,
      }));
  };

  await drop(rippleId, calculateLayout(base).duration + 20);
  let inserted = await added(rippleId);
  expect(inserted.map((item) => item.mediaId).sort()).toEqual([...ids].sort());
  expect(inserted.map((item) => item.range)).toEqual([
    [0, 120],
    [0, 120],
  ]);
  expect(inserted[1]!.placed.start).toBe(inserted[0]!.placed.end);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await added(rippleId)).toEqual([]);

  await drop('positioned', 30);
  inserted = await added('positioned');
  expect(inserted.map((item) => item.mediaId).sort()).toEqual([...ids].sort());
  expect(inserted.map((item) => item.placed.start)).toEqual([30, inserted[0]!.placed.end]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await added('positioned')).toEqual([]);
  expect(projectSchema.parse(await page.evaluate(() => window.pascapLab!.project())).layers).toHaveLength(2);

  await summary.getByRole('button', { name: 'Clear selected', exact: true }).click();
  await expect(summary).toContainText('Select all');
});

test('the selection header keeps Prepare and Clear keyboard reachable without starting work', async ({ page }) => {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') posts.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const summary = page.locator('.library-summary');
  await expect(summary.getByRole('button', { name: 'Prepare selected' })).toHaveCount(0);
  // Both are deliberately unprepared fixtures, so Prepare must confirm before any job.
  await page.getByRole('checkbox', { name: 'Select recording-05.mp4', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select recording-06.mp4', exact: true }).check();
  await expect(summary).toContainText('2 selected');
  await page.getByRole('checkbox', { name: 'Select visible recordings', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(summary.getByRole('button', { name: 'Prepare selected', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('group', { name: 'Prepare 2 editing proxies?', exact: true });
  await expect(confirm).toBeVisible();
  await expect(summary.getByRole('button', { name: 'Prepare selected', exact: true })).toBeDisabled();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await summary.getByRole('button', { name: 'Clear selected', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(summary).toContainText('Select all');
  await expect(summary.getByRole('button', { name: 'Clear selected' })).toHaveCount(0);
  expect(posts).toEqual([]);
});

test('drags a source between excerpts, keeps the full recording, then reorders it', async ({ page }) => {
  const source = page
    .getByRole('article')
    .filter({ has: page.getByRole('button', { name: 'Add recording-03.mp4 to timeline', exact: true }) });
  const target = page.locator('.timeline-surface');
  const project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  const scale = Number(await target.getAttribute('data-pixels-per-frame'));
  const leading = Number(await target.getAttribute('data-leading'));
  await source.dragTo(target, { targetPosition: { x: leading + 70 * scale, y: 95 } });
  const inserted = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(inserted.clips).toHaveLength(3);
  expect(inserted.clips[1]).toMatchObject({ sourceIn: 0, sourceOut: 120 });
  expect(inserted.clips[0]?.id).toBe(project.clips[0]?.id);
  const body = page.locator(`[data-clip-id="${inserted.clips[1]!.id}"] .timeline-clip-body`);
  await body.dragTo(target, { targetPosition: { x: leading + 4, y: 95 } });
  const reordered = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(reordered.clips[0]?.id).toBe(inserted.clips[1]?.id);
});

test('seeks across five excerpts including a new recording using only two reusable decoders', async ({ page }) => {
  await page.getByRole('button', { name: 'Add recording-03.mp4 to timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Add pattern-a.mp4 to timeline', exact: true }).click();
  await page.getByRole('button', { name: 'Add pattern-b.mp4 to timeline', exact: true }).click();
  const project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.clips).toHaveLength(5);
  const layout = calculateLayout(project);
  for (const placed of [...layout.clips, ...[...layout.clips].reverse()]) {
    const frame = placed.start + 35;
    const state = await page.evaluate(async (position) => {
      const engine = window.pascapLab!.engine;
      await engine.seek(position);
      engine.capturePixels();
      return engine.diagnostics();
    }, frame);
    expect(state.status).toBe('paused');
    expect(state.frame).toBe(frame);
    expect(state.assignedClipIds).toContain(placed.clip.id);
    expect(state.decoderCount).toBe(2);
  }
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
});

test('split, delete and undo work on named timeline clips', async ({ page }) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(30));
  await clipAction(page, 'Split at playhead');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(3);
  await clipAction(page, 'Delete selected clip');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips.length)).toBe(3);
});

test('an empty or single-clip timeline works without the old two-clip requirement', async ({ page }) => {
  await clipAction(page, 'Delete selected clip');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  const one = await page.evaluate(async () => {
    await window.pascapLab!.engine.seek(20);
    window.pascapLab!.engine.capturePixels();
    return window.pascapLab!.engine.diagnostics();
  });
  expect(one.duration).toBe(90);
  expect(one.decoderCount).toBe(2);
  await clipAction(page, 'Delete selected clip');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'empty');
  await expect(page.getByRole('button', { name: 'Play preview', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add pattern-a.mp4 to timeline', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().duration)).toBe(120);
});

test('changing a later boundary preserves independent excerpts while Colour applies to their shared row', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Add pattern-a.mp4 to timeline', exact: true }).click();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.8');
  await page.getByRole('button', { name: 'Transition after pattern-b.mp4, excerpt 2 on Video 1', exact: true }).click();
  await page.getByRole('combobox', { name: 'Transition type' }).selectOption('cross-dissolve');
  const project = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  expect(project.layers[0]?.colour.exposure).toBe(0.8);
  expect(project.clips.every((clip) => !('colour' in clip) && !('correction' in clip))).toBe(true);
  expect(project.layers[0]!.transitions[0]?.duration).toBe(18);
  expect(project.layers[0]!.transitions[1]).toMatchObject({ type: 'cross-dissolve', duration: 30 });
  const region = calculateLayout(project).transitions[1]!;
  const state = await page.evaluate(
    async (position) => {
      const engine = window.pascapLab!.engine;
      await engine.seek(position);
      engine.capturePixels();
      return engine.diagnostics();
    },
    Math.floor((region.start + region.end) / 2),
  );
  expect(state.status).toBe('paused');
  expect(state.assignedClipIds).toContain(project.clips[1]!.id);
  expect(state.assignedClipIds).toContain(project.clips[2]!.id);
});

test('playback crosses different recordings and dissolves with only two decoder elements', async ({ page }) => {
  // This is an end-frame/decoder-ownership check, not target-GPU throughput.
  // A CPU-rendered runner can advance correctly while repeatedly reanchoring.
  test.setTimeout(60_000);
  await page.getByRole('button', { name: 'Add recording-03.mp4 to timeline', exact: true }).click();
  const base = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  let project = base;
  for (const clip of base.clips)
    project = applyCommand(project, { type: 'trim', clipId: clip.id, sourceIn: 15, sourceOut: 75 });
  project = applyCommand(project, {
    type: 'transition',
    transition: { leftId: project.clips[1]!.id, rightId: project.clips[2]!.id, type: 'cross-dissolve', duration: 18 },
  });
  await page.evaluate((document) => window.pascapLab!.setDocument(document), project);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await page.evaluate(async () => {
    await window.pascapLab!.engine.seek(0);
    await window.pascapLab!.engine.play();
  });
  try {
    await page.waitForFunction(
      () => {
        const state = window.pascapLab!.engine.diagnostics();
        return state.status === 'error' || (!state.playing && state.frame === state.duration - 1);
      },
      undefined,
      { timeout: 45_000 },
    );
  } finally {
    // Synthetic diagnostics only: renderer, frame progress and element state.
    // Preserve useful evidence even when the bounded completion check fails.
    const diagnostics = await page.evaluate(() => ({
      preview: window.pascapLab!.engine.diagnostics(),
      decoders: Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'), (video) => ({
        index: video.dataset['pascapDecoder'],
        currentTime: video.currentTime,
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking,
        readyState: video.readyState,
        error: video.error?.message ?? null,
      })),
    }));
    console.log('Synthetic bounded playback diagnostics:', JSON.stringify(diagnostics));
    await test.info().attach('bounded-playback-diagnostics', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    });
  }
  const state = await page.evaluate(() => window.pascapLab!.engine.diagnostics());
  expect(state.status, state.message).not.toBe('error');
  expect(state.frame).toBe(143);
  expect(state.decoderCount).toBe(2);
  await expect(page.locator('video[data-pascap-decoder]')).toHaveCount(2);
});

test('pointer cancellation restores the committed source range', async ({ page }) => {
  const handle = page.locator('[data-clip-id="clip-a"] [data-trim-handle="in"]');
  const box = (await handle.boundingBox())!;
  const scale = Number(await page.locator('.timeline-surface').getAttribute('data-pixels-per-frame'));
  await page.mouse.move(box.x + 5, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 5 + 20 * scale, box.y + 20, { steps: 4 });
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('35');
  await handle.dispatchEvent('pointercancel');
  await page.mouse.up();
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame' })).toHaveValue('15');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
