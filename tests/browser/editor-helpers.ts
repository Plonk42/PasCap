import { expect, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';
import {
  createAdjustment,
  layerKeyAsGradeKey,
  type Adjustment,
  type GradeKeyframe,
  type GradeKeyValues,
} from '../../src/shared/grade.js';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
  layerKeyframe,
  uniformKeyframe,
} from '../../src/shared/keyframes.js';
import { jobSchema, type MediaJob } from '../../src/shared/media.js';
import { operations } from '../../src/shared/operations/index.js';
import { forEachSerial } from '../../src/shared/serial.js';
import { SPATIAL_CHANNELS, type SpatialKeyframe, type SpatialKeyValues } from '../../src/shared/spatial.js';

const readOperations = new Set(operations.filter((op) => op.access === 'read').map((op) => `/api/ops/${op.name}`));

/** A request that can change state: not a GET, nor a read operation, which the editor POSTs. */
export function isWrite(request: Request): boolean {
  return request.method() !== 'GET' && !readOperations.has(new URL(request.url()).pathname);
}

/** A POST that can change state, such as an import or a preparation. */
export function isWritePost(request: Request): boolean {
  return request.method() === 'POST' && isWrite(request);
}

export async function openOptions(page: Page, label: string): Promise<void> {
  const trigger = page.locator(`summary[aria-label="${label}"]`);
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}

/** The timeline preview's decoder budget: two per video track once there is footage. */
export async function expectDecoders(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().decoderCount)).toBe(count);
}

/** A side panel collapses from its own heading. */
export function collapsePanel(page: Page, name: 'Media' | 'Properties'): Locator {
  return page.getByRole('button', { name: `Collapse ${name} panel`, exact: true });
}

/** A collapsed side panel expands from the rail it leaves. */
export function expandPanel(page: Page, name: 'Media' | 'Properties'): Locator {
  return page.getByRole('button', { name: `Expand ${name} panel`, exact: true });
}

export async function closeOptions(page: Page): Promise<void> {
  const opened = page.locator('.editor-popover[open] > summary');
  await forEachSerial(await opened.all(), (trigger) => trigger.click());
}

type InspectorTab = 'Clip' | 'Colour' | 'Track' | 'Audio';
// Colour holds a selected clip's grade or the adjustment at the playhead, chosen with the Clip/Adjustment switch;
// Sequence lives in the Track tab.
const TAB_FOR: Record<InspectorTab | 'Adjustment' | 'Clip grade' | 'Sequence', InspectorTab> = {
  Clip: 'Clip',
  Colour: 'Colour',
  Track: 'Track',
  Audio: 'Audio',
  Adjustment: 'Colour',
  'Clip grade': 'Colour',
  Sequence: 'Track',
};

export async function inspectorTab(page: Page, name: keyof typeof TAB_FOR): Promise<void> {
  const tab = page.getByRole('tab', { name: TAB_FOR[name], exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  if (name === 'Adjustment' || name === 'Clip grade') await colourTarget(page, name === 'Clip grade' ? 'Clip' : name);
}

/** The Colour tab edits the selected clip's grade or the adjustment at the playhead; without a clip, the adjustment. */
export async function colourTarget(page: Page, target: 'Clip' | 'Adjustment'): Promise<void> {
  // Until the project opens, the pinned header shows an unavailable Adjustment target.
  await page.waitForFunction(() => window.pascapLab?.project() != null);
  await expect(page.locator('#inspector-pane [role="tabpanel"]:not([hidden]) .colour-target')).toBeVisible();
  const radio = page
    .getByRole('radiogroup', { name: 'Colour target' })
    .getByRole('radio', { name: target === 'Clip' ? 'Clip grade' : 'Adjustment', exact: true });
  // Choose even when it shows as checked: without a selected clip the Adjustment shows, and selecting a clip would then
  // show its grade. A pointer draft disables the switch, keeping the target chosen before it.
  if (await radio.isEnabled()) await radio.dispatchEvent('click');
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

/** Speed is clip-owned (Clip tab); Transform and Opacity are the track's (Track tab); Colour edits the adjustment. */
export async function settingTab(page: Page, label: string): Promise<void> {
  const name = { Speed: 'Clip', Transform: 'Track', Opacity: 'Track' }[label] ?? 'Colour';
  const tab = page.getByRole('tab', { name, exact: true });
  // A synthetic click never moves the mouse, so it cannot end an active pointer draft.
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.dispatchEvent('click');
  if (name === 'Colour') await colourTarget(page, 'Adjustment');
}

/** Double-clicking a setting's name resets only that setting, like its Reset button. */
export async function resetSetting(scope: Page | Locator, name: string): Promise<void> {
  const id = await scope.getByRole('slider', { name, exact: true }).getAttribute('id');
  await scope.locator(`[id="${id}-name"]`).dblclick();
}

/** Audio → Add music track is the single creation path; it lists ready music recordings. */
export async function addMusicTrack(page: Page, name?: string): Promise<void> {
  await openOptions(page, 'Add music track');
  const choices = page.getByRole('list', { name: 'Ready music recordings' }).getByRole('button');
  await (name ? choices.filter({ hasText: name }).first() : choices.first()).click();
}

/** Legacy functional tests choose expansion; default compact presentation is tested separately. */
export async function expandedInspectorPreferences(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const id of [
      'source',
      'layer-opacity',
      'speed',
      'transform',
      'detail',
      'colour',
      'transition',
      'fades',
      'music',
    ]) {
      const key = `pascap-section-${id}`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, 'open');
    }
  });
}

/** Split and Delete sit in the toolbar; Duplicate lives in the selected clip's context menu. */
export async function clipAction(page: Page, name: string): Promise<void> {
  const action = page.getByRole('button', { name, exact: true });
  if (!(await action.isVisible()))
    await page.locator('.timeline-clip.selected .timeline-clip-body').click({ button: 'right' });
  await action.click();
}

/** All ten nullable values are present, even when only one channel participates. */
export function sharedPoint(
  frame: number,
  values: Partial<LayerKeyValues>,
  interpolation: Interpolation = 'linear',
): LayerKeyframe {
  return layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, interpolation);
}

/** A clip grade or adjustment keyframe: every Colour setting present, only the given ones keyed. */
export function gradePoint(
  frame: number,
  values: Partial<GradeKeyValues>,
  interpolation: Interpolation = 'linear',
): GradeKeyframe {
  return layerKeyAsGradeKey(sharedPoint(frame, values, interpolation));
}

/** An adjustment grading every track from frame 0, so its keyframe frames are project frames. */
export function adjustmentFrom0(duration: number, keyframes: GradeKeyframe[] = []): Adjustment {
  return { ...createAdjustment('adjustment', 0, duration), keyframes };
}

const NO_TRANSFORM_VALUES = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as SpatialKeyValues;

/** A track Transform keyframe keying only the given settings, such as Opacity. */
export function transformPoint(
  frame: number,
  values: Partial<SpatialKeyValues>,
  interpolation: Interpolation = 'linear',
): SpatialKeyframe {
  return { ...uniformKeyframe(frame, { ...NO_TRANSFORM_VALUES, ...values }, interpolation), reset: false };
}

/** The Colour tab's stored keyframe list of the adjustment at the playhead. */
export function adjustmentKeyframes(page: Page): Locator {
  return page.getByRole('group', { name: /^Adjustment keyframes / });
}

/** Track → Transform's stored keyframe list, one row per keyframe. */
export function transformKeyframes(page: Page, name = 'Track 1'): Locator {
  return page.getByRole('group', { name: `Transform keyframes ${name}`, exact: true });
}

/** The row a stored keyframe list marks as current (inspected, or at the playhead). */
export function currentKeyframeRow(list: Locator): Locator {
  return list.locator('.keyframe-row[aria-current="true"]');
}

/** Open one stored Transform keyframe's Edit fields (long lists start collapsed). */
export async function editTransformKeyframe(page: Page, frame: number, name = 'Track 1'): Promise<Locator> {
  await inspectorTab(page, 'Track');
  const row = transformKeyframes(page, name).locator(`[data-keyframe-frame="${frame}"]`);
  if ((await row.locator('.layer-keyframe-point-details').getAttribute('open')) === null)
    await row.getByLabel(`Edit Transform keyframe ${frame}`, { exact: true }).click();
  return row;
}

/** Adjustment keyframes are directly visible; open only the selected keyframe's nested details. */
export async function editAdjustmentPoint(page: Page, frame: number): Promise<Locator> {
  await inspectorTab(page, 'Adjustment');
  const row = adjustmentKeyframes(page).locator(`[data-keyframe-frame="${frame}"]`);
  if ((await row.locator('.layer-keyframe-point-details').getAttribute('open')) === null)
    await row.getByLabel(`Edit adjustment keyframe ${frame}`, { exact: true }).click();
  return row;
}

/** Capture the POST's own job, not whichever older render is currently in the footer. */
export async function submitExport(page: Page): Promise<MediaJob> {
  const accepted = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/exports' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  return jobSchema.parse(((await response.json()) as { job: unknown }).job);
}

export async function freshExportLinks(
  page: Page,
  request: APIRequestContext,
  accepted: MediaJob,
  timeout: number,
): Promise<{ outputUrl: string; receiptUrl: string }> {
  let completed: MediaJob | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/jobs');
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as { jobs: unknown[] };
        completed = body.jobs.map((job) => jobSchema.parse(job)).find((job) => job.id === accepted.id);
        return completed?.state;
      },
      { timeout, message: `Wait for the newly accepted export ${accepted.id}` },
    )
    .toBe('completed');
  if (!completed?.outputUrl || !completed.receiptUrl)
    throw new Error('The new completed export must publish both a render and a receipt.');
  // Finished-render links live with their own job in the Activity drawer.
  const toggle = page.getByRole('button', { name: 'Open activity', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const drawer = page.locator('.activity-drawer');
  const open = drawer.locator(`a[href="${completed.outputUrl}"]:not([download])`);
  await expect(open).toHaveCount(1, { timeout });
  await expect(open).toHaveText('Open');
  await expect(drawer.locator(`a[href="${completed.outputUrl}"][download]`)).toHaveCount(1);
  await expect(drawer.locator(`a[href="${completed.receiptUrl}"]`)).toHaveText('Receipt');
  return { outputUrl: completed.outputUrl, receiptUrl: completed.receiptUrl };
}
