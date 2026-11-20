import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { AUTO_ADJUST_SETTINGS, type AutoCorrection } from '../../src/shared/auto-adjust.js';
import { createColorSettings, type ColorSettings } from '../../src/shared/color.js';
import type { FootageDirectory, FootageRoot } from '../../src/shared/footage.js';
import { imageFileUrl, type ImageAsset } from '../../src/shared/images.js';
import { matchFrame, towardsMatch } from '../../src/shared/look-match.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { AnalysisFrame } from '../../src/shared/white-balance.js';
import { expandedInspectorPreferences, inspectorTab } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

let memory: MemoryProjects;
let unexpected: string[];
let assets: MediaAsset[];
let registered: string[][];

/** A warm, graded-looking still: an RGB PNG of gradients, encoded here. */
function png(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      rows[row + 1 + x * 3] = Math.round(70 + (150 * x) / width);
      rows[row + 2 + x * 3] = Math.round(40 + (110 * y) / height);
      rows[row + 3 + x * 3] = Math.round(25 + (50 * ((x + y) % 48)) / 48);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BYTES = png(320, 180);
const IMAGE: ImageAsset = {
  id: 'warm-look',
  name: 'warm-look.png',
  sourcePath: '/approved/warm-look.png',
  format: 'png',
  width: 320,
  height: 180,
  fingerprint: {
    algorithm: 'sampled-sha256-v1',
    digest: 'a'.repeat(64),
    size: BYTES.length,
    mtimeMs: 1,
    device: 1,
    inode: 1,
  },
  registeredAt: '2026-11-17T00:00:00.000Z',
};
const ROOT: FootageRoot = { id: 'root-0', name: 'approved', path: '/approved', available: true, error: null };
const LISTING: FootageDirectory = {
  rootId: 'root-0',
  directory: '/approved',
  parent: null,
  entries: [
    { name: 'flight.mp4', path: '/approved/flight.mp4', kind: 'video', size: 2_000_000 },
    { name: IMAGE.name, path: IMAGE.sourcePath, kind: 'image', size: BYTES.length },
  ],
  ignored: 0,
  truncated: false,
  warnings: [],
};

async function open(page: Page, imageIds: string[]): Promise<void> {
  unexpected = [];
  registered = [];
  const response = await page.request.get('/api/media');
  expect(response.ok()).toBe(true);
  const library = (await response.json()) as { assets: MediaAsset[] };
  assets = ['pattern-a.mp4', 'pattern-b.mp4'].map((name) => {
    const asset = library.assets.find(
      (item) => item.name === name && item.status === 'ready' && item.prepared !== null,
    );
    if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources', name))
      throw new Error('Image tests require existing prepared synthetic videos; no import or preparation.');
    return asset;
  });
  const reads: Record<string, unknown> = {
    '/api/health': {
      name: 'PasCap',
      milestone: 'editing-and-export',
      frameRate: '30000/1001',
      workerConcurrency: 1,
      toolchain: null,
    },
    '/api/media': { assets, missing: [] },
    '/api/audio': { assets: [], missing: [] },
    '/api/jobs': { jobs: [] },
    '/api/images': { images: [IMAGE], missing: [] },
    '/api/footage/roots': { roots: [ROOT] },
    '/api/footage': LISTING,
    '/api/audio/browse': { ...LISTING, entries: [] },
  };
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'GET' && reads[pathname] !== undefined) {
      await route.fulfill({ json: reads[pathname] });
      return;
    }
    if (method === 'GET' && pathname === `/api/images/${IMAGE.id}/file`) {
      await route.fulfill({ body: BYTES, contentType: 'image/png' });
      return;
    }
    // The mocked video does not exist on the test service.
    if (method === 'GET' && pathname === '/api/footage/preview') {
      await route.fulfill({ status: 404, json: { error: 'No preview in this mocked folder.' } }).catch(() => {});
      return;
    }
    if (method === 'POST' && pathname === '/api/images/register-paths') {
      registered.push((route.request().postDataJSON() as { paths: string[] }).paths);
      await route.fulfill({ json: { images: [IMAGE], errors: [] } });
      return;
    }
    const media = /^\/api\/media\/([^/]+)\/(?:proxy|motion|thumbnail\/\d+)$/.exec(pathname);
    if (method === 'GET' && media && assets.some((asset) => asset.id === media[1])) {
      await route.continue();
      return;
    }
    unexpected.push(`${method} ${pathname}`);
    await route.abort('blockedbyclient');
  });
  const document = createProject('image-references-memory', 'Image references · memory-only');
  document.media.videoIds = assets.map((asset) => asset.id);
  document.media.imageIds = imageIds;
  document.clips = [
    createClip('hero', assets[0]!.id, 0, 60),
    { ...createClip('shot', assets[1]!.id, 0, 60), start: 60 },
  ];
  document.layers[0]!.transitions = [{ leftId: 'hero', rightId: 'shot', type: 'cut', duration: 0 }];
  memory = await memoryProjects(page, document);
  await expandedInspectorPreferences(page);
  await page.goto(`/?project=${document.id}`);
  await expect.poll(() => page.evaluate(() => window.pascapLab?.engine.diagnostics().status)).toBe('paused');
}

test.afterEach(() => {
  expect(unexpected, 'No real-store writes, imports, preparation, exports or unowned media requests').toEqual([]);
});

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function seek(page: Page, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await expect
    .poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics()))
    .toMatchObject({ status: 'paused', frame });
}

/** A picture as the page decodes it for analysis: a proxy frame, or the image itself. */
async function pageFrame(
  page: Page,
  source: { mediaId: string; frame: number } | { url: string },
): Promise<AnalysisFrame> {
  const encoded = await page.evaluate(async (from) => {
    let image: AnalysisFrame;
    if ('url' in from) {
      const bitmap = await createImageBitmap(await (await fetch(from.url)).blob());
      const scale = Math.min(1, Math.sqrt((320 * 180) / (bitmap.width * bitmap.height)));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const context = new OffscreenCanvas(width, height).getContext('2d', { colorSpace: 'srgb' })!;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      image = { width, height, data: context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data };
    } else image = (await window.pascapLab!.sampleFrames(from.mediaId, [from.frame])).get(from.frame)!;
    let binary = '';
    for (let index = 0; index < image.data.length; index += 8192)
      binary += String.fromCharCode(...image.data.subarray(index, index + 8192));
    return { width: image.width, height: image.height, data: btoa(binary) };
  }, source);
  return {
    width: encoded.width,
    height: encoded.height,
    data: new Uint8ClampedArray(Buffer.from(encoded.data, 'base64')),
  };
}

const eleven = (color: ColorSettings): AutoCorrection =>
  Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, color[setting]])) as AutoCorrection;
const gradeOf = (document: ProjectDocument, clipId: string) => document.clips.find((clip) => clip.id === clipId)!.grade;
const images = (page: Page) => page.getByRole('region', { name: 'Images', exact: true });
const showImage = (page: Page) =>
  images(page).getByRole('button', { name: `Show ${IMAGE.name} in Source preview`, exact: true });
const imageReview = (page: Page) => page.getByRole('region', { name: 'Image review', exact: true });
const useImage = (page: Page) =>
  imageReview(page).getByRole('button', { name: 'Use this image as the color reference', exact: true });
const section = (page: Page) => page.locator('.color-match');

test('imports an image into the Media library, read in place', async ({ page }) => {
  await open(page, []);
  await expect(images(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Import media', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import media' });
  await dialog.getByRole('button', { name: 'Images', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Select flight.mp4' })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: `Select ${IMAGE.name}`, exact: true }).check();
  await expect(dialog).toContainText('1 image selected');
  await dialog.getByRole('button', { name: 'Import selected recordings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(registered).toEqual([[IMAGE.sourcePath]]);
  await expect(images(page)).toContainText(IMAGE.name);
  await expect(images(page)).toContainText('320 × 180 · PNG');
  await expect
    .poll(() =>
      images(page)
        .locator('img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(320);
  await expect.poll(() => memory.snapshot().media.imageIds).toEqual([IMAGE.id]);
});

test('shows an image of the project whole in Source preview, until it leaves the project', async ({ page }) => {
  await open(page, [IMAGE.id]);
  const sourceTab = page.getByRole('tab', { name: 'Source preview', exact: true });
  await expect(sourceTab).toBeDisabled();
  await showImage(page).click();
  await expect(showImage(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceTab).toHaveAttribute('aria-selected', 'true');
  await expect(imageReview(page)).toContainText(IMAGE.name);
  const picture = imageReview(page).getByRole('img', { name: IMAGE.name, exact: true });
  await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(320);
  const box = (await picture.boundingBox())!;
  expect(box.width).toBeGreaterThan(320);
  await expect(useImage(page)).toHaveAttribute('aria-pressed', 'false');

  await useImage(page).press('Escape');
  await expect(imageReview(page)).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Timeline preview', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(showImage(page)).toHaveAttribute('aria-pressed', 'false');

  await showImage(page).click();
  await expect(imageReview(page)).toBeVisible();
  await images(page)
    .getByRole('button', { name: `Remove ${IMAGE.name} from project`, exact: true })
    .click();
  await expect(imageReview(page)).toHaveCount(0);
  await expect(sourceTab).toBeDisabled();
  await expect.poll(() => memory.snapshot().media.imageIds).toEqual([]);
});

test('matches clips to an image of the project, as shot, until it leaves the project', async ({ page }) => {
  await open(page, [IMAGE.id]);
  await expect(images(page)).toContainText(IMAGE.name);
  await showImage(page).click();
  await useImage(page).click();
  await expect(useImage(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(images(page)).toContainText('Color reference');

  await page.locator('[data-clip-id="shot"] .timeline-clip-body').press('Enter');
  await seek(page, 70);
  await inspectorTab(page, 'Clip grade');
  await expect(section(page)).toContainText('warm-look');
  await expect(section(page)).toContainText('Image, as shot');
  await expect(section(page).locator('.color-match-thumbnail img')).toBeVisible();
  const menu = page.locator('summary[aria-label="Styles and other references"]');
  await menu.click();
  await expect(page.locator('.color-match-menu').getByRole('button', { name: new RegExp(IMAGE.name) })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await menu.click();

  const before = await current(page);
  await section(page).locator('.color-match-actions .primary-button').click();
  const apply = section(page).getByRole('button', { name: /^Apply/ });
  await expect(apply).toBeVisible({ timeout: 30_000 });
  const reference = await pageFrame(page, { url: imageFileUrl(IMAGE) });
  const target = await pageFrame(page, { mediaId: assets[1]!.id, frame: 10 });
  const shotColor = gradeOf(before, 'shot').color;
  const matched = matchFrame({ frame: reference, color: createColorSettings() }, { frame: target, color: shotColor })!;
  await apply.click();
  await expect
    .poll(async () => eleven(gradeOf(await current(page), 'shot').color))
    .toEqual(towardsMatch(shotColor, matched.correction, 1));
  expect(gradeOf(await current(page), 'hero')).toEqual(gradeOf(before, 'hero'));

  await images(page)
    .getByRole('button', { name: `Remove ${IMAGE.name} from project`, exact: true })
    .click();
  await expect(images(page)).toHaveCount(0);
  await expect(section(page)).toContainText('The reference image was removed from the project');
  await expect.poll(() => memory.snapshot().media.imageIds).toEqual([]);
});
