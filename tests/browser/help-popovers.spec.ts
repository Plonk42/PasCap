import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AudioAsset } from '../../src/shared/audio.js';
import { estimateExportSpace } from '../../src/shared/export-space.js';
import type { ExportProfile } from '../../src/shared/export.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences, inspectorTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];

test.beforeEach(async ({ page, request }) => {
  unexpected = [];
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  const assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset) throw new Error('Help checks require existing prepared synthetic fixtures, never owner media.');
    return asset;
  });
  const audio = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.filter(
    (asset) => asset.status === 'ready',
  );
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const reads: Record<string, unknown> = {
      '/api/health': { name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 },
      '/api/media': { assets },
      '/api/audio': { assets: audio },
      '/api/jobs': { jobs: [] },
    };
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (method === 'POST' && pathname === '/api/exports/preflight') {
      const body = route.request().postDataJSON() as { document: ProjectDocument; profile: ExportProfile };
      await route.fulfill({
        json: {
          space: {
            directory: '/disposable/help-cache/renders',
            availableBytes: 64 * 1024 ** 3,
            estimate: estimateExportSpace(projectSchema.parse(body.document), body.profile),
            status: 'available',
            checkedAt: '2026-10-04T10:00:00Z',
          },
        },
      });
      return;
    }
    const video = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
    const music = /^\/api\/audio\/([^/]+)\/(?:playback|waveform)$/.exec(pathname);
    if (
      method === 'GET' &&
      ((video && assets.some((asset) => asset.id === video[1])) ||
        (music && audio.some((asset) => asset.id === music[1])))
    ) {
      await route.continue();
      return;
    }
    if (method === 'HEAD' && music && pathname.endsWith('/playback') && audio.some((asset) => asset.id === music[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('help-popover-memory', 'Inline help · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.clips = [
    createClip('help-left', assets[0]!.id, 0, 120),
    { ...createClip('help-right', assets[1]!.id, 0, 120), start: 120 },
  ];
  document.layers[0]!.transitions = [{ leftId: 'help-left', rightId: 'help-right', type: 'cut', duration: 0 }];
  document.layers[0]!.keyframes = [sharedPoint(10, { exposure: 0 }), sharedPoint(90, { exposure: 0.8 })];
  const track = audio[0];
  if (!track) throw new Error('Help checks require the dedicated prepared synthetic audio fixture.');
  document.media.audioIds = [track.id];
  document.music = {
    mediaId: track.id,
    sourceIn: 0,
    sourceOut: Math.min(60, track.metadata.frameCount),
    start: 0,
    duration: 240,
    gainDb: 0,
    fadeIn: 0,
    fadeOut: 0,
    loop: true,
  };
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.addInitScript('globalThis.__name = (fn) => fn;');
  await page.goto(`/?project=${document.id}`);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

test.afterEach(() =>
  expect(unexpected, 'Help must not import, prepare, render or issue an unowned request').toEqual([]),
);

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}
async function panelFor(page: Page, trigger: Locator): Promise<Locator> {
  const id = await trigger.getAttribute('aria-controls');
  if (!id) throw new Error('Help must expose its controlled content.');
  return page.locator(`[id="${id}"]`);
}

test('bulk Clip expansion preserves other tabs, mixed state and preferences without document edits', async ({
  page,
}) => {
  const before = await current(page);
  const headers = page.locator(
    '[id$="-clip-panel"] .inspector-section > .disclosure-heading > h3 > .disclosure-trigger',
  );
  const collapse = page.getByRole('button', { name: 'Collapse all Inspector settings', exact: true });
  await collapse.focus();
  await collapse.press('Enter');
  await expect(page.getByRole('button', { name: 'Expand all Inspector settings', exact: true })).toBeFocused();
  expect(
    await headers.evaluateAll((nodes) => nodes.every((node) => node.getAttribute('aria-expanded') === 'false')),
  ).toBe(true);
  await inspectorTab(page, 'Sequence');
  await expect(page.getByRole('button', { name: 'Sequence fades section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: 'Sequence fades section', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(Expand|Collapse) all Inspector settings$/ })).toHaveCount(0);
  await inspectorTab(page, 'Audio');
  await expect(page.getByRole('button', { name: 'Music section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.getByRole('button', { name: 'Music section', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(Expand|Collapse) all Inspector settings$/ })).toHaveCount(0);
  await inspectorTab(page, 'Clip');
  await expect(page.getByRole('button', { name: 'Expand all Inspector settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand all Inspector settings', exact: true }).press('Space');
  await expect(collapse).toBeFocused();
  expect(
    await headers.evaluateAll((nodes) => nodes.every((node) => node.getAttribute('aria-expanded') === 'true')),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      ['source', 'layer-opacity', 'speed', 'colour', 'transition', 'fades', 'music'].map((id) =>
        localStorage.getItem(`pascap-section-${id}`),
      ),
    ),
  ).toEqual(['open', 'open', 'open', 'open', 'open', 'closed', 'closed']);
  await page.getByRole('button', { name: 'Source range section', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand all Inspector settings', exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(page.getByRole('button', { name: 'Source range section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Colour section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('bulk collapse retains invalid drafts, nested disclosure state and reachable heading help at compact widths', async ({
  page,
}) => {
  const before = await current(page);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true, includeHidden: true });
  await input.fill('0.5');
  await input.press('Enter');
  await inspectorTab(page, 'Layer keyframes');
  const list = page.getByRole('list', { name: 'Edit layer keys', exact: true, includeHidden: true });
  await expect(list).toBeVisible();
  const point = page.getByLabel('Edit layer keyframe 10', { exact: true });
  await point.click();
  await inspectorTab(page, 'Clip');
  await page.getByRole('button', { name: 'Collapse all Inspector settings', exact: true }).click();
  await expect(input).toBeAttached();
  await expect(input).toBeHidden();
  await expect(list).toBeAttached();
  await expect(point.locator('..')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Source timing help', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source range section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Expand all Inspector settings', exact: true }).click();
  await expect(input).toHaveValue('0.5');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  for (const width of [1024, 720, 640]) {
    await page.setViewportSize({ width, height: 720 });
    const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', width === 720 ? 'false' : 'true');
    if (width === 720) await toggle.click();
    const bulk = page.getByRole('button', { name: 'Collapse all Inspector settings', exact: true });
    await expect(bulk).toBeInViewport();
    expect((await bulk.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('bulk Inspector choices still work when preference writes are denied', async ({ page }) => {
  const before = await current(page);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Denied', 'SecurityError');
    };
  });
  await page.getByRole('button', { name: 'Collapse all Inspector settings', exact: true }).click();
  await expect(page.getByText('Section preferences cannot be saved in this browser.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Expand all Inspector settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source range section', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('hover help preserves focus, stays readable across the gap, and leaves without editing or saving', async ({
  page,
}) => {
  const before = await current(page);
  await inspectorTab(page, 'Layer keyframes');
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  await title.focus();
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.hover();
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger).toHaveAttribute('aria-pressed', 'false');
  await expect(title).toBeFocused();
  const box = (await panel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('All participating settings share one point');
  await page.mouse.move(600, 20);
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(title).toBeFocused();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('click pins an already-hovered panel until an outside click, without stealing the clicked control focus', async ({
  page,
}) => {
  const before = await current(page);
  await inspectorTab(page, 'Layer keyframes');
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.hover();
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(600, 20);
  await expect(panel).toBeVisible();
  const outside = page.getByRole('button', { name: 'Toggle Media panel', exact: true });
  await outside.click();
  await expect(panel).toBeHidden();
  await expect(outside).toBeFocused();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('keyboard focus previews, Enter and Space pin, and help keys never fire timeline shortcuts', async ({ page }) => {
  const before = await current(page);
  await inspectorTab(page, 'Layer keyframes');
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.focus();
  await expect(panel).toBeVisible();
  await trigger.press('Enter');
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await trigger.press('s');
  await trigger.press('ArrowRight');
  await trigger.press('Delete');
  expect(await current(page)).toEqual(before);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
  await trigger.press('ArrowDown');
  await expect(panel).toBeFocused();
  await panel.press('s');
  await panel.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.press('Space');
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await trigger.press('Escape');
  await expect(panel).toBeHidden();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('Escape closes a hover preview before cancelling an underlying invalid numeric draft', async ({ page }) => {
  const before = await current(page);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('0.5');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const trigger = page.getByRole('button', { name: 'Source timing help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.hover();
  await expect(panel).toBeVisible();
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(panel).toBeHidden();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('0.5');
  await input.press('Escape');
  await expect(input).toHaveValue('0');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('changing Inspector context without clicking dismisses help whose owner becomes hidden', async ({ page }) => {
  const clipTab = page.getByRole('tab', { name: 'Clip', exact: true });
  const keyframesTab = page.getByRole('tab', { name: 'Layer keyframes', exact: true });
  const sequenceTab = page.getByRole('tab', { name: 'Sequence', exact: true });
  const audioTab = page.getByRole('tab', { name: 'Audio', exact: true });
  await clipTab.focus();
  await clipTab.press('ArrowRight');
  await expect(keyframesTab).toHaveAttribute('aria-selected', 'true');
  await expect(keyframesTab).toBeFocused();
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.click();
  await expect(panel).toBeVisible();
  await keyframesTab.focus();
  await keyframesTab.press('ArrowRight');
  await expect(sequenceTab).toHaveAttribute('aria-selected', 'true');
  await expect(sequenceTab).toBeFocused();
  await expect(panel).toHaveJSProperty('popover', 'manual');
  await expect.poll(() => panel.evaluate((element) => element.matches(':popover-open'))).toBe(false);
  await sequenceTab.press('ArrowRight');
  await expect(audioTab).toHaveAttribute('aria-selected', 'true');
  await expect(audioTab).toBeFocused();
  expect(memory.saves).toBe(0);
});

test('options retain click-only disclosure behavior rather than opening on hover', async ({ page }) => {
  const options = page.locator('summary[aria-label="Media options"]');
  await options.hover();
  await expect(options).toHaveAttribute('aria-expanded', 'false');
  await options.click();
  await expect(options).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(options).toBeFocused();
  expect(memory.saves).toBe(0);
});

test('an outside pointer gesture dismisses pinned help before capture so Escape still cancels the gesture', async ({
  page,
}) => {
  const before = await current(page);
  await inspectorTab(page, 'Layer keyframes');
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.click();
  await expect(panel).toBeVisible();
  const resizer = page.getByRole('slider', { name: 'Resize Clip panel', exact: true });
  const initial = Number(await resizer.getAttribute('aria-valuenow'));
  const box = (await resizer.boundingBox())!;
  const grabbedX = box.x + box.width / 2;
  await page.mouse.move(grabbedX, box.y + 40);
  await page.mouse.down();
  await expect(panel).toBeHidden();
  await page.mouse.move(grabbedX - 20, box.y + 40, { steps: 3 });
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initial + 20));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initial));
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('pascap-workspace-layout'))).toBeNull();
});

const HELP_CONTEXTS = [
  { label: 'Source timing', tab: 'Clip', text: 'Original recording frames; OUT is exclusive.' },
  { label: 'Placement timing', tab: 'Clip', text: 'Opacity is in Colour and affects the whole row.' },
  { label: 'Colour animation', tab: 'Clip', text: 'Each diamond keys only its own setting' },
  { label: 'Speed timing', tab: 'Clip', text: 'Row keys override, rather than multiply' },
  { label: 'Animation', tab: 'Layer keyframes', text: 'Moving a point moves every participating setting.' },
  {
    label: 'Transition timing',
    tab: 'Sequence',
    text: 'Conflicts reject the complete edit, never shorten another fade or transition.',
  },
  { label: 'Fade timing', tab: 'Sequence', text: '0 disables a fade.' },
  { label: 'Audio timing', tab: 'Audio', text: 'Both fades must fit within Duration.' },
] as const;

const INSPECTOR_HELP_HEADINGS = [
  { title: 'Source range', help: 'Source timing', tab: 'Clip' },
  { title: 'Placement', help: 'Placement timing', tab: 'Clip' },
  { title: 'Speed', help: 'Speed timing', tab: 'Clip' },
  { title: 'Colour', help: 'Colour animation', tab: 'Clip' },
  { title: 'Transition', help: 'Transition timing', tab: 'Sequence' },
  { title: 'Sequence fades', help: 'Fade timing', tab: 'Sequence' },
] as const;

for (const context of INSPECTOR_HELP_HEADINGS) {
  test(`${context.title} title keeps adjacent help reachable when collapsed, without an accidental section toggle`, async ({
    page,
  }) => {
    const before = await current(page);
    await inspectorTab(page, context.tab);
    const section = page.getByRole('button', { name: `${context.title} section`, exact: true });
    const help = page.getByRole('button', { name: `${context.help} help`, exact: true });
    const panel = await panelFor(page, help);
    await section.scrollIntoViewIfNeeded();
    const header = section.locator('xpath=../..');
    expect(
      await help.evaluate((button) => button.parentElement?.parentElement?.classList.contains('disclosure-heading')),
    ).toBe(true);
    const headingBox = (await header.boundingBox())!;
    const helpBox = (await help.boundingBox())!;
    expect(Math.abs(helpBox.y + helpBox.height / 2 - headingBox.y - headingBox.height / 2)).toBeLessThanOrEqual(1);
    expect(helpBox.x + helpBox.width).toBeLessThanOrEqual(headingBox.x + headingBox.width);
    await section.press('Space');
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    const contentId = await section.getAttribute('aria-controls');
    if (!contentId) throw new Error('Section buttons must own their mounted content.');
    await expect(page.locator(`[id="${contentId}"]`)).toBeHidden();
    await expect(help).toBeVisible();
    await expect(help).toBeInViewport();
    await help.hover();
    await expect(panel).toBeVisible();
    await help.click();
    await expect(help).toHaveAttribute('aria-pressed', 'true');
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    await help.press('Escape');
    await expect(panel).toBeHidden();
    await expect(help).toBeFocused();
    await expect(section).toHaveAttribute('aria-expanded', 'false');
    expect(await current(page)).toEqual(before);
    expect(memory.saves).toBe(0);
  });
}

test('native heading Tab order is section then help then its controls, and remembered collapse leaves help available after reload', async ({
  page,
}) => {
  const before = await current(page);
  const section = page.getByRole('button', { name: 'Source range section', exact: true });
  const help = page.getByRole('button', { name: 'Source timing help', exact: true });
  await section.focus();
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame', exact: true })).toBeFocused();
  await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  await expect(help).toBeVisible();
  await help.click();
  await expect(section).toHaveAttribute('aria-expanded', 'false');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('collapsing and restoring a section keeps the same invalid field draft and header help does not cancel it', async ({
  page,
}) => {
  const before = await current(page);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('0.5');
  await input.press('Enter');
  const element = await input.elementHandle();
  if (!element) throw new Error('The field must remain mounted across collapse.');
  const section = page.getByRole('button', { name: 'Source range section', exact: true });
  await section.click();
  await expect(input).toBeHidden();
  expect(await element.evaluate((node) => node.isConnected)).toBe(true);
  const help = page.getByRole('button', { name: 'Source timing help', exact: true });
  await help.click();
  await help.press('Escape');
  await section.click();
  await expect(input).toHaveValue('0.5');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(await input.evaluate((node, previous) => node === previous, element)).toBe(true);
  await input.press('Escape');
  await expect(input).toHaveValue('0');
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

for (const context of HELP_CONTEXTS) {
  test(`${context.label} uses a compact hover/pinned question mark and retains its complete explanation`, async ({
    page,
  }) => {
    const before = await current(page);
    await inspectorTab(page, context.tab);
    const trigger = page.getByRole('button', { name: `${context.label} help`, exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.scrollIntoViewIfNeeded();
    const box = (await trigger.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24);
    expect(box.width).toBeLessThanOrEqual(28);
    expect(box.height).toBeGreaterThanOrEqual(24);
    expect(box.height).toBeLessThanOrEqual(28);
    expect(await trigger.textContent()).toBe('');
    await expect(trigger.locator('svg')).toHaveCount(1);
    await trigger.hover();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(context.text);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(600, 20);
    await expect(panel).toBeVisible();
    await panel.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.locator('details.control-help')).toHaveCount(0);
    expect(await current(page)).toEqual(before);
    expect(memory.saves).toBe(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

test('numeric fields retain their descriptions even while the linked help popover is hidden', async ({ page }) => {
  await expect(page.getByRole('spinbutton', { name: 'Source IN frame', exact: true })).toHaveAccessibleDescription(
    /Original recording frames; OUT is exclusive/,
  );
  await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toHaveAccessibleDescription(
    /Custom curve points belong to one clip/,
  );
  await inspectorTab(page, 'Sequence');
  await expect(page.getByRole('spinbutton', { name: 'Opening fade', exact: true })).toHaveAccessibleDescription(
    /0 disables a fade/,
  );
  await inspectorTab(page, 'Audio');
  await page.getByText('Placement & fades', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Music duration', exact: true })).toHaveAccessibleDescription(
    /Both fades must fit within Duration/,
  );
  expect(memory.saves).toBe(0);
});

test('only the small question-mark target opens help, not the empty space across its section', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Source timing help', exact: true });
  const panel = await panelFor(page, trigger);
  const box = (await trigger.boundingBox())!;
  const owner = (await trigger.locator('..').boundingBox())!;
  expect(owner.width).toBe(box.width);
  await page.mouse.move(box.x - 40, box.y + box.height / 2);
  await expect(panel).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.hover();
  await expect(panel).toBeVisible();
  expect(memory.saves).toBe(0);
});

test('a pinned help ignores another hover but an explicit second help click replaces it', async ({ page }) => {
  const source = page.getByRole('button', { name: 'Source timing help', exact: true });
  const opacity = page.getByRole('button', { name: 'Placement timing help', exact: true });
  const sourcePanel = await panelFor(page, source);
  const opacityPanel = await panelFor(page, opacity);
  await source.click();
  await expect(sourcePanel).toBeVisible();
  await opacity.hover();
  await expect(opacityPanel).toBeHidden();
  await expect(sourcePanel).toBeVisible();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  await opacity.click();
  await expect(opacityPanel).toBeVisible();
  await expect(sourcePanel).toBeHidden();
  await expect(page.locator('.editor-help-content:popover-open')).toHaveCount(1);
  await opacity.click();
  await expect(opacityPanel).toBeHidden();
  expect(memory.saves).toBe(0);
});

test('hovering another help replaces only an unpinned preview, without moving focus', async ({ page }) => {
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  await title.focus();
  const source = page.getByRole('button', { name: 'Source timing help', exact: true });
  const opacity = page.getByRole('button', { name: 'Placement timing help', exact: true });
  const sourcePanel = await panelFor(page, source);
  const opacityPanel = await panelFor(page, opacity);
  await source.hover();
  await expect(sourcePanel).toBeVisible();
  await opacity.hover();
  await expect(opacityPanel).toBeVisible();
  await expect(sourcePanel).toBeHidden();
  await expect(title).toBeFocused();
  await expect(page.locator('.editor-help-content:popover-open')).toHaveCount(1);
  expect(memory.saves).toBe(0);
});

test('hover keeps a valid numeric draft unapplied; clicking help keeps the ordinary one-commit blur contract', async ({
  page,
}) => {
  const before = await current(page);
  const input = page.getByRole('spinbutton', { name: 'Source IN frame', exact: true });
  await input.fill('5');
  const trigger = page.getByRole('button', { name: 'Source timing help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.hover();
  await expect(panel).toBeVisible();
  await expect(input).toBeFocused();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveValue('5');
  expect((await current(page)).clips[0]!.sourceIn).toBe(5);
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(1);
  await trigger.press('Escape');
  await input.focus();
  await input.press('Enter');
  await page.evaluate(() => window.pascapLab!.flush());
  expect(memory.saves).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await current(page)).toEqual(before);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('direct point list keeps timing help available and nested drafts mounted across tabs', async ({ page }) => {
  await inspectorTab(page, 'Layer keyframes');
  const list = page.getByRole('list', { name: 'Edit layer keys', exact: true });
  await expect(list).toBeVisible();
  await page.getByLabel('Edit layer keyframe 10', { exact: true }).click();
  const field = page.getByRole('spinbutton', { name: 'Layer keyframe frame 10', exact: true, includeHidden: true });
  await field.fill('0.5');
  await field.press('Enter');
  const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Absolute project timeline frames');
  await inspectorTab(page, 'Sequence');
  await expect(panel).toBeHidden();
  await expect(field).toBeAttached();
  await expect(field).toBeHidden();
  await inspectorTab(page, 'Layer keyframes');
  await expect(field).toHaveValue('0.5');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(list).toBeVisible();
  await trigger.press('Escape');
  await expect(panel).toBeHidden();
  await field.press('Escape');
  await expect(field).toHaveValue('10');
  expect(memory.saves).toBe(0);
});

for (const context of [
  { title: 'Placement & fades', toggle: 'Placement & fades', help: 'Audio timing', tab: 'Audio' },
] as const) {
  test(`${context.title} has independent title-level help before opening its editable fields`, async ({ page }) => {
    const before = await current(page);
    await inspectorTab(page, context.tab);
    const toggle = page.getByRole('button', { name: context.toggle, exact: true });
    const help = page.getByRole('button', { name: `${context.help} help`, exact: true });
    const panel = await panelFor(page, help);
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const header = toggle.locator('xpath=../..');
    const bounds = (await header.boundingBox())!;
    const button = (await help.boundingBox())!;
    expect(Math.abs(button.y + button.height / 2 - bounds.y - bounds.height / 2)).toBeLessThanOrEqual(1);
    expect(
      await help.evaluate((element) => element.parentElement?.parentElement?.classList.contains('disclosure-heading')),
    ).toBe(true);
    await toggle.focus();
    await page.keyboard.press('Tab');
    await expect(help).toBeFocused();
    await help.press('Enter');
    await expect(help).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await help.press('Escape');
    await expect(panel).toBeHidden();
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await current(page)).toEqual(before);
    expect(memory.saves).toBe(0);
  });
}

test('all Inspector title actions and help remain distinct and unclipped at a 270px panel width', async ({ page }) => {
  const before = await current(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'pascap-workspace-layout',
      JSON.stringify({
        mediaWidth: 300,
        inspectorWidth: 270,
        timelineHeight: 290,
        mediaOpen: true,
        inspectorOpen: true,
      }),
    ),
  );
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  expect(
    Number(await page.getByRole('slider', { name: 'Resize Clip panel', exact: true }).getAttribute('aria-valuenow')),
  ).toBe(270);
  for (const context of INSPECTOR_HELP_HEADINGS) {
    await inspectorTab(page, context.tab);
    const section = page.getByRole('button', { name: `${context.title} section`, exact: true });
    const help = page.getByRole('button', { name: `${context.help} help`, exact: true });
    await section.scrollIntoViewIfNeeded();
    const heading = (await section.boundingBox())!;
    const target = (await help.boundingBox())!;
    expect(target.x).toBeGreaterThanOrEqual(heading.x + heading.width);
    expect(target.width).toBe(24);
    expect(target.height).toBe(24);
    const inspector = (await page.getByRole('complementary', { name: 'Clip inspector', exact: true }).boundingBox())!;
    expect(target.x + target.width).toBeLessThanOrEqual(inspector.x + inspector.width);
    await help.click();
    await expect(section).toHaveAttribute('aria-expanded', 'true');
    await help.press('Escape');
  }
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('compact help keeps its trigger exposed and its text pointer-scrollable when neither side fits the full panel', async ({
  page,
}) => {
  const before = await current(page);
  await page.setViewportSize({ width: 640, height: 480 });
  const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  const trigger = page.getByRole('button', { name: 'Speed timing help', exact: true });
  const panel = await panelFor(page, trigger);
  await trigger.evaluate((button) => button.scrollIntoView({ block: 'center' }));
  await trigger.hover();
  await expect(panel).toBeVisible();
  const target = (await trigger.boundingBox())!;
  const bounds = (await panel.boundingBox())!;
  expect(
    bounds.y + bounds.height <= target.y - 6 || bounds.y >= target.y + target.height + 6,
    'The top-layer panel must stay on one side of its native trigger, not clamp across it',
  ).toBe(true);
  expect(
    await trigger.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(globalThis.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }),
    'The trigger must remain the actual pointer hit target',
  ).toBe(true);
  expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, 100);
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(panel).toBeVisible();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 640, height: 740 });
  await expect.poll(() => panel.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
  await page.setViewportSize({ width: 640, height: 480 });
  await trigger.evaluate((button) => button.scrollIntoView({ block: 'center' }));
  await expect.poll(() => panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const resizedTarget = (await trigger.boundingBox())!;
  const resizedPanel = (await panel.boundingBox())!;
  expect(
    resizedPanel.y + resizedPanel.height <= resizedTarget.y - 6 ||
      resizedPanel.y >= resizedTarget.y + resizedTarget.height + 6,
  ).toBe(true);
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await trigger.press('ArrowDown');
  await expect(panel).toBeFocused();
  await panel.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await current(page)).toEqual(before);
  expect(memory.saves).toBe(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

for (const width of [1440, 1024, 720, 640]) {
  test(`help remains unclipped with a 24px target and bounded panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 640 ? 480 : 720 });
    const toggle = page.getByRole('button', { name: 'Toggle Clip panel', exact: true });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    const trigger = page.getByRole('button', { name: 'Speed timing help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.hover();
    await expect(panel).toBeVisible();
    const target = (await trigger.boundingBox())!;
    const bounds = (await panel.boundingBox())!;
    const section = page.getByRole('button', { name: 'Speed section', exact: true });
    const heading = (await section.locator('xpath=../..').boundingBox())!;
    expect(Math.abs(target.y + target.height / 2 - heading.y - heading.height / 2)).toBeLessThanOrEqual(1);
    expect(target.width).toBeGreaterThanOrEqual(24);
    expect(target.height).toBeGreaterThanOrEqual(24);
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((width === 640 ? 480 : 720) - 8);
    expect(bounds.y + bounds.height <= target.y - 6 || bounds.y >= target.y + target.height + 6).toBe(true);
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: width + 20, height: 740 });
    await expect(panel).toBeVisible();
    const resizedTarget = (await trigger.boundingBox())!;
    const resizedPanel = (await panel.boundingBox())!;
    expect(resizedPanel.x + resizedPanel.width).toBeLessThanOrEqual(width + 12);
    expect(resizedPanel.y).toBeGreaterThanOrEqual(8);
    expect(resizedPanel.y + resizedPanel.height).toBeLessThanOrEqual(732);
    expect(
      resizedPanel.y + resizedPanel.height <= resizedTarget.y - 6 ||
        resizedPanel.y >= resizedTarget.y + resizedTarget.height + 6,
    ).toBe(true);
    expect(memory.saves).toBe(0);
  });
}

test('startup-error help retains diagnostics and dismissal never reloads or edits the project', async ({ page }) => {
  const before = await current(page);
  await page.route('**/assets/bootstrap-*.js', (route) => route.abort('failed'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Startup details help', exact: true });
  const panel = await panelFor(page, trigger);
  const heading = page.getByRole('heading', { name: 'Preview needs attention', exact: true });
  expect(
    await trigger.evaluate((element) =>
      element.parentElement?.parentElement?.classList.contains('preview-empty-heading'),
    ),
  ).toBe(true);
  const titleBounds = (await heading.boundingBox())!;
  const helpBounds = (await trigger.boundingBox())!;
  expect(Math.abs(titleBounds.y + titleBounds.height / 2 - helpBounds.y - helpBounds.height / 2)).toBeLessThanOrEqual(
    1,
  );
  await trigger.hover();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/import|fetch|Preview/i);
  await trigger.click();
  await trigger.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Reload editor', exact: true })).toBeVisible();
  // Bootstrap failed, so its debug API cannot exist. Read the actual retained draft
  // through the normal recovery download, without relaxing the full-document check.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project', exact: true }).click();
  const filename = await (await download).path();
  if (!filename) throw new Error('The retained draft must be downloadable while preview code is unavailable.');
  expect(projectSchema.parse(JSON.parse(await readFile(filename, 'utf8')))).toEqual(before);
  expect(memory.snapshot()).toEqual(before);
  expect(memory.saves).toBe(0);
});

test('functional music, source and export detail sections remain ordinary editable/informational disclosures', async ({
  page,
}) => {
  await expect(page.getByRole('spinbutton', { name: 'Source OUT frame', exact: true })).toBeVisible();
  await inspectorTab(page, 'Audio');
  await page.getByText('Placement & fades', { exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Music fade in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video', exact: true });
  await dialog.getByText('Storage details', { exact: true }).click();
  await expect(page.locator('.export-storage-path')).toHaveText('/disposable/help-cache/renders');
  await dialog.getByText('Rendering details', { exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Fixed snapshot', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start export', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(memory.saves).toBe(0);
});

test.describe('touch help', () => {
  test.use({ hasTouch: true });
  test('a tap pins help and an outside tap dismisses it without an unavailable hover step', async ({ page }) => {
    const before = await current(page);
    await inspectorTab(page, 'Layer keyframes');
    const trigger = page.getByRole('button', { name: 'Animation help', exact: true });
    const panel = await panelFor(page, trigger);
    await trigger.tap();
    await expect(panel).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Toggle Media panel', exact: true }).tap();
    await expect(panel).toBeHidden();
    expect(await current(page)).toEqual(before);
    expect(memory.saves).toBe(0);
  });
});
