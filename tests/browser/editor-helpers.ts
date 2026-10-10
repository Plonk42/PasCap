import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { jobSchema, type MediaJob } from '../../src/shared/media.js';
import { forEachSerial } from '../../src/shared/serial.js';

export async function openOptions(page: Page, label: string): Promise<void> {
  const trigger = page.locator(`summary[aria-label="${label}"]`);
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}

/** Media/Clip panel toggles live in Workspace options. */
export async function panelToggle(page: Page, name: 'Media' | 'Clip'): Promise<Locator> {
  await openOptions(page, 'Workspace options');
  return page.getByRole('button', { name: `Toggle ${name} panel`, exact: true });
}

export async function closeOptions(page: Page): Promise<void> {
  const opened = page.locator('.editor-popover[open] > summary');
  await forEachSerial(await opened.all(), (trigger) => trigger.click());
}

type InspectorTab = 'Clip' | 'Track' | 'Audio';
// Keyframes and Sequence are sections of the Track tab; specs name the content they need.
const TAB_FOR: Record<InspectorTab | 'Track keyframes' | 'Sequence', InspectorTab> = {
  Clip: 'Clip',
  Track: 'Track',
  Audio: 'Audio',
  'Track keyframes': 'Track',
  Sequence: 'Track',
};

export async function inspectorTab(page: Page, name: keyof typeof TAB_FOR): Promise<void> {
  const tab = page.getByRole('tab', { name: TAB_FOR[name], exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
}

/** Speed is clip-owned (Clip tab); Opacity and Colour are track-owned (Track tab). */
export async function settingTab(page: Page, label: string): Promise<void> {
  const tab = page.getByRole('tab', { name: label === 'Speed' ? 'Clip' : 'Track', exact: true });
  // A synthetic click never moves the mouse, so it cannot end an active pointer draft.
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.dispatchEvent('click');
}

/** Double-clicking a setting's name resets only that setting; there is no per-control reset button. */
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
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}

export function layerKeyframes(page: Page, name: string): Locator {
  return page.getByRole('group', { name: `Track keyframes ${name}`, exact: true });
}

/** Shared points are directly visible; open only the selected point's nested details. */
export async function editLayerPoint(page: Page, name: string, frame: number): Promise<Locator> {
  await inspectorTab(page, 'Track keyframes');
  const keys = layerKeyframes(page, name);
  const row = keys.locator(`[data-keyframe-frame="${frame}"]`);
  if ((await row.locator('.layer-keyframe-point-details').getAttribute('open')) === null)
    await row.getByLabel(`Edit track keyframe ${frame}`, { exact: true }).click();
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
