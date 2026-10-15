import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { FootageDirectory, FootageRoot } from '../../src/shared/footage.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createProject } from '../../src/shared/model.js';
import { memoryProjects } from './memory-projects.js';

const root: FootageRoot = { id: 'root-0', name: 'New drive', path: '/drive', available: true, error: null };

function relinkJob(label: string): MediaJob {
  return {
    id: `relink-${label}`,
    kind: 'relink',
    label,
    state: 'queued',
    progress: 0,
    message: 'Waiting for the media worker',
    createdAt: '2026-10-15T10:00:00Z',
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
  };
}

/** Real fixture assets, reported missing until the service accepts their relink. */
async function mockMissing(page: Page, video: MediaAsset, music: AudioAsset) {
  const relinked = new Set<string>();
  const bodies: { url: string; path: string }[] = [];
  for (const [list, id] of [
    ['/api/media', video.id],
    ['/api/audio', music.id],
  ] as const)
    await page.route(new RegExp(`${list}$`), async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as { assets: unknown[] };
      await route.fulfill({ response, json: { ...json, missing: relinked.has(id) ? [] : [id] } });
    });
  await page.route(/\/api\/(media|audio)\/[^/]+\/relink$/, async (route) => {
    const url = new URL(route.request().url()).pathname;
    const { path } = route.request().postDataJSON() as { path: string };
    bodies.push({ url, path });
    const id = url.split('/')[3]!;
    relinked.add(id);
    await route.fulfill({ status: 202, json: { job: relinkJob(id) } });
  });
  await page.route('**/api/relink-folder', async (route) => {
    const { directory } = route.request().postDataJSON() as { directory: string };
    bodies.push({ url: '/api/relink-folder', path: directory });
    relinked.add(video.id).add(music.id);
    await route.fulfill({ status: 202, json: { job: relinkJob('folder') } });
  });
  await page.route('**/api/footage/roots', (route) => route.fulfill({ json: { roots: [root] } }));
  await page.route(/\/api\/footage\?/, (route) => {
    const listing: FootageDirectory = {
      rootId: root.id,
      directory: '/drive',
      parent: null,
      entries: [
        { name: video.name, path: `/drive/${video.name}`, kind: 'video', size: 1024 },
        { name: 'other.mp4', path: '/drive/other.mp4', kind: 'video', size: 2048 },
      ],
      ignored: 0,
      truncated: false,
      warnings: [],
    };
    return route.fulfill({ json: listing });
  });
  await page.route(/\/api\/audio\/browse\?/, (route) =>
    route.fulfill({
      json: {
        rootId: root.id,
        directory: '/drive',
        parent: null,
        entries: [],
        ignored: 0,
        truncated: false,
        warnings: [],
      },
    }),
  );
  await page.route(/\/api\/footage\/preview\?/, (route) => route.fulfill({ status: 404, json: { error: 'None.' } }));
  return bodies;
}

async function missingProject(page: Page, request: APIRequestContext) {
  const video = ((await (await request.get('/api/media')).json()) as { assets: MediaAsset[] }).assets.find(
    (asset) => asset.name === 'pattern-a.mp4',
  )!;
  const music = ((await (await request.get('/api/audio')).json()) as { assets: AudioAsset[] }).assets.find(
    (asset) => asset.name === 'test-music.wav',
  )!;
  const project = createProject('relink-browser', 'Relink · memory-only');
  await memoryProjects(page, {
    ...project,
    revision: 1,
    media: { videoIds: [video.id], audioIds: [music.id] },
  });
  const bodies = await mockMissing(page, video, music);
  await page.goto('/?project=relink-browser');
  return { video, music, bodies };
}

test('a missing original is flagged and relinked to a chosen moved copy, for video and music', async ({
  page,
  request,
}) => {
  const { video, music, bodies } = await missingProject(page, request);

  const card = page.locator(`[data-media-id="${video.id}"]`);
  await expect(card.getByLabel(`${video.name}: Original missing`)).toBeVisible();
  await expect(card.getByRole('button', { name: `Add ${video.name} to timeline` })).toHaveCount(0);
  await card.getByRole('button', { name: `Relink ${video.name}` }).click();

  const dialog = page.getByRole('dialog', { name: `Relink ${video.name}` });
  await expect(dialog).toContainText(`Was at ${video.sourcePath}`);
  await expect(dialog.getByRole('button', { name: 'Music', exact: true })).toHaveCount(0);
  const relinkButton = dialog.getByRole('button', { name: 'Relink to the selected recording' });
  await expect(relinkButton).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Select other.mp4' }).check();
  await dialog.getByRole('checkbox', { name: `Select ${video.name}` }).check();
  // One moved copy at a time: choosing another replaces the choice.
  await expect(dialog.getByRole('checkbox', { name: 'Select other.mp4' })).not.toBeChecked();
  await expect(dialog).toContainText(`New location: /drive/${video.name}`);
  await relinkButton.click();

  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([{ url: `/api/media/${video.id}/relink`, path: `/drive/${video.name}` }]);
  await expect(page.getByRole('region', { name: 'Activity' })).toBeVisible();
  await page.getByRole('button', { name: 'Close activity' }).click();
  await expect(card.getByRole('button', { name: `Add ${video.name} to timeline` })).toBeVisible();

  const song = page.locator(`[data-music-media-id="${music.id}"]`);
  await song.getByRole('button', { name: `Relink ${music.name}` }).click();
  const musicDialog = page.getByRole('dialog', { name: `Relink ${music.name}` });
  await musicDialog.getByText('Other location').click();
  await musicDialog.getByRole('textbox', { name: 'File or folder path' }).fill('/elsewhere/test-music.wav');
  await musicDialog.getByRole('button', { name: 'Relink path' }).click();
  await expect(musicDialog).toBeHidden();
  expect(bodies.at(-1)).toEqual({ url: `/api/audio/${music.id}/relink`, path: '/elsewhere/test-music.wav' });
  await expect(song.getByRole('button', { name: `Relink ${music.name}` })).toHaveCount(0);
});

test('Relink folder searches the open folder for every missing recording in one request', async ({ page, request }) => {
  const { video, music, bodies } = await missingProject(page, request);
  const bar = page.locator('.media-missing-bar');
  await expect(bar).toContainText('2 originals are missing');
  await bar.getByRole('button', { name: 'Relink folder…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Relink missing recordings' });
  await expect(dialog).toContainText('searches the open folder and its subfolders');
  // Files orient the user but cannot be chosen: the whole folder is searched.
  await expect(dialog.getByRole('checkbox', { name: `Select ${video.name}` })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Search this folder for missing recordings' }).click();

  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([{ url: '/api/relink-folder', path: '/drive' }]);
  await expect(page.getByRole('region', { name: 'Activity' })).toBeVisible();
  await expect(bar).toBeHidden();
  await expect(page.locator(`[data-media-id="${video.id}"]`).getByLabel(`${video.name}: Original missing`)).toHaveCount(
    0,
  );
  await expect(
    page.locator(`[data-music-media-id="${music.id}"]`).getByRole('button', { name: /^Relink/ }),
  ).toHaveCount(0);
});

test('a typed folder in a recording relink searches that folder', async ({ page, request }) => {
  const { video, bodies } = await missingProject(page, request);
  await page
    .locator(`[data-media-id="${video.id}"]`)
    .getByRole('button', { name: `Relink ${video.name}` })
    .click();
  const dialog = page.getByRole('dialog', { name: `Relink ${video.name}` });
  await expect(dialog.getByRole('button', { name: 'Search this folder for missing recordings' })).toBeEnabled();
  await dialog.getByText('Other location').click();
  await dialog.getByRole('textbox', { name: 'File or folder path' }).fill('/media/new-drive');
  await dialog.getByRole('button', { name: 'Relink path' }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([{ url: '/api/relink-folder', path: '/media/new-drive' }]);
});
