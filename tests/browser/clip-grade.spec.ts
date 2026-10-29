import { expect, test, type Page } from '@playwright/test';
import type { MediaAsset } from '../../src/shared/media.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { expandedInspectorPreferences, inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let document: ProjectDocument;

const current = (page: Page): Promise<ProjectDocument> => page.evaluate(() => window.pascapLab!.project()!);
const exact = (page: Page, name: string) => page.getByRole('spinbutton', { name, exact: true });

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

test.beforeEach(async ({ page, request }) => {
  const assets = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets;
  const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready');
  if (!asset) throw new Error('Prepared synthetic video required.');
  document = createProject('clip-grade-memory', 'Clip grades · memory only');
  document.media.videoIds = [asset.id];
  const clip = createClip('one', asset.id, 0, 40);
  // Half speed holds each recorded image for two frames; Exposure eases from source frame 0 to 10.
  clip.speed = { mode: 'constant', rate: 0.5 };
  clip.grade.keyframes = [
    layerKeyAsGradeKey(layerKeyframe(0, { ...EMPTY_KEY_VALUES, exposure: 0 }, 'linear')),
    layerKeyAsGradeKey(layerKeyframe(10, { ...EMPTY_KEY_VALUES, exposure: 1 }, 'linear')),
  ];
  document.clips = [clip];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await inspectorTab(page, 'Clip grade');
});

test('clip grade values follow the image in slow motion, and a keyframe at the playhead shows its own value', async ({
  page,
}) => {
  await expect(page.locator('.colour-target')).toContainText('This clip only');
  // Frame 3 shows source frame 1 at position 1.5, between the keyframes: read-only, the image's value.
  await seek(page, 3);
  await expect(exact(page, 'Exposure')).toHaveValue('0.15');
  await expect(exact(page, 'Exposure')).toBeDisabled();
  // Frame 1 shows source frame 0 at position 0.5: its keyframe is editable and shows its own value.
  await seek(page, 1);
  await expect(exact(page, 'Exposure')).toHaveValue('0');
  await expect(exact(page, 'Exposure')).toBeEnabled();
  await exact(page, 'Exposure').fill('0.2');
  await exact(page, 'Exposure').press('Enter');
  await expect.poll(async () => (await current(page)).clips[0]!.grade.keyframes[0]!.values.exposure).toBe(0.2);
  const edited = await current(page);
  expect(edited.layers).toEqual(document.layers);
  await expect.poll(() => memory.saves).toBe(1);
});
