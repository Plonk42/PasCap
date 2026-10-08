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

export async function closeOptions(page: Page): Promise<void> {
  const opened = page.locator('.editor-popover[open] > summary');
  await forEachSerial(await opened.all(), (trigger) => trigger.click());
}

export async function inspectorTab(page: Page, name: 'Clip' | 'Layer keyframes' | 'Sequence' | 'Audio'): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
}

/** Audio → Add music track is the single creation path; it lists ready music files. */
export async function addMusicTrack(page: Page, name?: string): Promise<void> {
  await openOptions(page, 'Add music track');
  const choices = page.getByRole('list', { name: 'Ready music files' }).getByRole('button');
  await (name ? choices.filter({ hasText: name }).first() : choices.first()).click();
}

/** Legacy functional tests choose expansion; default compact presentation is tested separately. */
export async function expandedInspectorPreferences(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const id of ['source', 'layer-opacity', 'speed', 'transform', 'colour', 'transition', 'fades', 'music']) {
      const key = `pascap-section-${id}`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, 'open');
    }
  });
}

export async function clipAction(page: Page, name: string): Promise<void> {
  const action = page.getByRole('button', { name, exact: true });
  if (!(await action.isVisible())) await openOptions(page, 'Clip actions');
  await action.click();
}

/** All eleven nullable values are present, even when only one channel participates. */
export function sharedPoint(
  frame: number,
  values: Partial<LayerKeyValues>,
  interpolation: Interpolation = 'linear',
): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}

export function layerKeyframes(page: Page, name: string): Locator {
  return page.getByRole('group', { name: `Layer keyframes ${name}`, exact: true });
}

/** Shared points are directly visible; open only the selected point's nested details. */
export async function editLayerPoint(page: Page, name: string, frame: number): Promise<Locator> {
  await inspectorTab(page, 'Layer keyframes');
  const keys = layerKeyframes(page, name);
  const row = keys.locator(`[data-keyframe-frame="${frame}"]`);
  if ((await row.locator('.layer-keyframe-point-details').getAttribute('open')) === null)
    await row.getByLabel(`Edit layer keyframe ${frame}`, { exact: true }).click();
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
  const links = page.locator('.activity-render-links');
  await expect(links.getByRole('link', { name: 'Open render', exact: true })).toBeVisible({ timeout });
  await expect(links.getByRole('link', { name: 'Open render', exact: true })).toHaveAttribute(
    'href',
    completed.outputUrl,
  );
  await expect(links.getByRole('link', { name: 'Receipt', exact: true })).toHaveAttribute('href', completed.receiptUrl);
  return { outputUrl: completed.outputUrl, receiptUrl: completed.receiptUrl };
}
