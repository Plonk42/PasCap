import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { KEYFRAME_SETTINGS } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { createSpatialSettings, evaluateSpatial, NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout, type PlacedClip } from '../../src/shared/timeline.js';
import { editLayerPoint, inspectorTab, layerKeyframes, settingTab, sharedPoint } from './editor-helpers.js';
import { memoryProjects, type MemoryProjects } from './memory-projects.js';

type Section = 'Colour' | 'Speed' | 'Transform';
const TRACK = 'Video track 1';
const CLIP = 'animated-clip';
const colourSettings = KEYFRAME_SETTINGS;

function inspector(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Clip inspector', exact: true });
}

/** The expanded section's keyframe line: count, Previous/Next and the section reset. */
function line(page: Page, section: Section): Locator {
  return inspector(page)
    .locator('.section-keyframe-line')
    .filter({ has: page.getByRole('button', { name: `Next ${section} keyframe`, exact: true }) });
}

function navigation(page: Page, section: Section, direction: 'Previous' | 'Next'): Locator {
  return line(page, section).getByRole('button', { name: `${direction} ${section} keyframe`, exact: true });
}

function diamond(page: Page, label: string): Locator {
  return inspector(page).getByRole('button', { name: `Keyframe ${label}`, exact: true });
}

function channelNavigation(page: Page, label: string, direction: 'Previous' | 'Next'): Locator {
  return diamond(page, label)
    .locator('..')
    .getByRole('button', { name: `${direction} ${label} keyframe`, exact: true });
}

function transformDiamond(page: Page): Locator {
  return inspector(page).getByRole('button', { name: 'Keyframe Scale', exact: true });
}

/** Every main Transform setting has its own diamond, like Colour; stored fields have none. */
function transformDiamonds(page: Page): Locator {
  return inspector(page).locator('.spatial-pose-fields .keyframe-toggle');
}

function marker(page: Page, type: 'transform' | 'speed', source: number): Locator {
  return page.locator(`[data-clip-id="${CLIP}"] [data-clip-keyframe="${type}"][data-source-frame="${source}"]`);
}

async function current(page: Page): Promise<ProjectDocument> {
  return projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
}

async function ready(page: Page, document: ProjectDocument): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.pascapLab?.engine.diagnostics();
        return { id: window.pascapLab?.project()?.id, status: state?.status, duration: state?.duration };
      }),
    )
    .toEqual({ id: document.id, status: 'paused', duration: calculateLayout(document).duration });
  await expect(page.getByRole('button', { name: 'Select track Video track 1', exact: true })).toBeEnabled();
}

/** Check the decoder's observed identity, never infer it from video.currentTime. */
async function previewAt(page: Page, document: ProjectDocument, frame: number): Promise<void> {
  const placed = calculateLayout(document).clips.find(({ clip }) => clip.id === CLIP)!;
  const source = placed.retiming.sourceAt(frame - placed.start);
  await expect
    .poll(() =>
      page.evaluate((clipId) => {
        const state = window.pascapLab!.engine.diagnostics();
        const slot = state.assignedClipIds.indexOf(clipId);
        return {
          status: state.status,
          frame: state.frame,
          source: state.decodedSourceFrames[slot],
          ready: state.decoderReady[slot],
          playing: state.playing,
        };
      }, CLIP),
    )
    .toEqual({ status: 'paused', frame, source, ready: true, playing: false });
}

async function seek(page: Page, document: ProjectDocument, frame: number): Promise<void> {
  await page.evaluate((position) => window.pascapLab!.engine.seek(position), frame);
  await previewAt(page, document, frame);
}

/** Independent oracle: compare neighbouring outputs of the authoritative placed map. */
function nearestOutput(placed: PlacedClip, source: number): number {
  if (source <= placed.clip.sourceIn) return placed.start;
  if (source >= placed.clip.sourceOut) return placed.end - 1;
  const lower = placed.retiming.outputAt(source);
  const upper = Math.min(placed.duration - 1, lower + 1);
  return (
    placed.start +
    (Math.abs(placed.retiming.sourceAt(upper) - source) < Math.abs(placed.retiming.sourceAt(lower) - source)
      ? upper
      : lower)
  );
}

/** The removed Animate preference must never be written. */
async function animatePreferences(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('pascap-animate')));
}

async function pixels(page: Page, ungraded = false) {
  return page.evaluate((ungraded) => {
    const engine = window.pascapLab!.engine;
    const previous = engine.diagnostics().ungraded;
    try {
      engine.setUngraded(ungraded);
      const bytes = engine.capturePixels();
      let checksum = 2_166_136_261;
      let rgbSum = 0;
      for (let index = 0; index < bytes.length; index++) {
        checksum = Math.imul(checksum ^ bytes[index]!, 16_777_619) >>> 0;
        if (index % 4 !== 3) rgbSum += bytes[index]!;
      }
      return { checksum, rgbSum, length: bytes.length };
    } finally {
      engine.setUngraded(previous);
    }
  }, ungraded);
}

async function easing(page: Page, name: string): Promise<void> {
  const select = page.getByRole('combobox', { name, exact: true });
  await select.scrollIntoViewIfNeeded();
  await expect(select).toBeVisible();
  await expect(select).toHaveJSProperty('tagName', 'SELECT');
  await expect(select.locator('xpath=ancestor::label[1]')).toContainText('Easing');
  await expect(select.locator('xpath=ancestor::label[1]')).not.toContainText('Interpolation');
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
]) {
  test.describe(`#94 animation sections at ${viewport.width}×${viewport.height}`, () => {
    let memory: MemoryProjects;
    let unexpected: string[];

    test.beforeEach(async ({ page, request }) => {
      await page.setViewportSize(viewport);
      unexpected = [];
      const response = await request.get('/api/media');
      expect(response.ok()).toBe(true);
      const { assets } = (await response.json()) as { assets: MediaAsset[] };
      const asset = assets.find((item) => item.name === 'pattern-a.mp4' && item.status === 'ready' && item.prepared);
      if (!asset || asset.sourcePath !== path.resolve('.pascap/browser-tests/synthetic-sources/pattern-a.mp4'))
        throw new Error('Animation tests require the existing prepared synthetic pattern; no real-media work.');
      expect(asset.metadata.frameCount).toBe(120);
      const reads: Record<string, unknown> = {
        '/api/health': {
          name: 'PasCap',
          milestone: 'editing-and-export',
          frameRate: '30000/1001',
          workerConcurrency: 1,
        },
        '/api/media': { assets: [asset] },
        '/api/audio': { assets: [] },
        '/api/jobs': { jobs: [] },
      };
      // Install first: memoryProjects owns every project write, never the real store.
      await page.route('**/api/**', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const method = route.request().method();
        if (method === 'GET' && reads[pathname] !== undefined) {
          await route.fulfill({ json: reads[pathname] });
          return;
        }
        const media = /^\/api\/media\/([^/]+)\/(?:proxy|thumbnail\/\d+)$/.exec(pathname);
        if (method === 'GET' && media?.[1] === asset.id) {
          await route.continue();
          return;
        }
        unexpected.push(`${method} ${pathname}`);
        await route.abort('blockedbyclient');
      });
      const document = createProject('animation-sections-memory', 'Animation sections · memory-only');
      document.media.videoIds = [asset.id];
      document.layers[0]!.name = TRACK;
      document.layers[0]!.keyframes = [sharedPoint(0, { opacity: 0.65 }), sharedPoint(40, { exposure: 0.6 })];
      const clip = createClip(CLIP, asset.id, 10, 100);
      clip.speed = {
        mode: 'curve',
        keyframes: [0, 30, 80, 120].map((frame) => ({ frame, rate: 1, interpolation: 'linear' })),
      };
      clip.spatial = createSpatialSettings();
      clip.spatial.keyframes = [0, 20, 60, 100, 120].map((frame) => ({
        frame,
        interpolation: 'linear',
        values: { ...NEUTRAL_SPATIAL_POSE, scale: 1 + frame / 300, translateX: frame / 1000 },
      }));
      document.clips = [clip];
      memory = await memoryProjects(page, document);
      await page.addInitScript(() => {
        for (const section of ['source', 'layer-opacity', 'speed', 'transform', 'colour', 'keyframes']) {
          const key = `pascap-section-${section}`;
          if (localStorage.getItem(key) === null) localStorage.setItem(key, 'open');
        }
        if (localStorage.getItem('pascap-workspace-layout') === null)
          localStorage.setItem(
            'pascap-workspace-layout',
            JSON.stringify({
              mediaWidth: 240,
              inspectorWidth: 270,
              timelineHeight: 200,
              mediaOpen: true,
              inspectorOpen: true,
            }),
          );
      });
      await page.goto(`/?project=${document.id}`);
      await ready(page, document);
    });

    test.afterEach(() => {
      expect(unexpected, 'Only memory-only project routes and prepared synthetic reads are admitted').toEqual([]);
    });

    async function fixture(page: Page, configure: (document: ProjectDocument) => void): Promise<ProjectDocument> {
      const document = await current(page);
      configure(document);
      memory.seed(document);
      await page.reload();
      await ready(page, document);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      return document;
    }

    async function unchanged(page: Page, document: ProjectDocument): Promise<void> {
      expect(await current(page)).toEqual(document);
      await page.evaluate(() => window.pascapLab!.flush());
      expect(memory.snapshot(document.id)).toEqual(document);
      expect(memory.saves).toBe(0);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
    }

    test('keyframe controls are always visible without a toggle, native values stay editable and no preference is stored', async ({
      page,
    }, testInfo) => {
      const document = await fixture(page, (document) => {
        document.layers[0]!.keyframes = [];
        document.clips[0]!.speed = { mode: 'constant', rate: 1 };
        document.clips[0]!.spatial = createSpatialSettings();
      });
      expect(document.schemaVersion).toBe(13);
      await inspectorTab(page, 'Track');
      await expect(inspector(page).getByRole('button', { name: /^Animate / })).toHaveCount(0);
      await expect(line(page, 'Colour')).toContainText('0 keyframes');
      await expect(line(page, 'Colour').getByRole('button', { name: 'Reset colour', exact: true })).toBeVisible();
      for (const direction of ['Previous', 'Next'] as const)
        await expect(navigation(page, 'Colour', direction)).toBeDisabled();
      for (const { label } of colourSettings) {
        await expect(page.getByRole('slider', { name: label, exact: true })).toBeEnabled();
        await expect(page.getByRole('spinbutton', { name: label, exact: true })).toBeEnabled();
        const main = diamond(page, label).locator('..');
        await expect(diamond(page, label)).toBeVisible();
        await expect(main).toHaveClass(/\bkeyframe-setting-navigation\b/);
        await expect(main).toHaveJSProperty('tagName', 'SPAN');
        await expect(main.getByRole('button')).toHaveCount(3);
        for (const button of await main.getByRole('button').all())
          await expect(button).toHaveJSProperty('tagName', 'BUTTON');
        for (const direction of ['Previous', 'Next'] as const) {
          const arrow = channelNavigation(page, label, direction);
          await expect(arrow).toBeVisible();
          await expect(arrow).toHaveAttribute('aria-disabled', 'true');
          await expect(arrow).toHaveJSProperty('disabled', false);
          await expect(arrow).toHaveAttribute('tabindex', '-1');
        }
      }
      await testInfo.attach('unanimated-colour', { body: await page.screenshot(), contentType: 'image/png' });
      await inspectorTab(page, 'Clip');
      await expect(inspector(page).getByRole('button', { name: /^Animate / })).toHaveCount(0);
      for (const section of ['Speed', 'Transform'] as const) {
        await expect(line(page, section)).toContainText('0 keyframes');
        for (const direction of ['Previous', 'Next'] as const)
          await expect(navigation(page, section, direction)).toBeDisabled();
      }
      await expect(diamond(page, 'Speed')).toBeVisible();
      await expect(transformDiamonds(page)).toHaveCount(8);
      await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toBeEnabled();
      await expect(page.getByRole('spinbutton', { name: 'Transform Scale', exact: true })).toBeEnabled();
      expect(await animatePreferences(page)).toEqual([]);
      expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await unchanged(page, document);
    });

    test('existing keys keep read-only gaps, count what each header visits and hide the line when collapsed', async ({
      page,
    }, testInfo) => {
      const document = await current(page);
      await seek(page, document, 15);
      const graded = await pixels(page);
      expect(graded).toHaveLength(1280 * 720 * 4);
      expect(graded.rgbSum).toBeGreaterThan(0);
      expect(await pixels(page, true)).not.toEqual(graded);
      await inspectorTab(page, 'Track');
      await expect(line(page, 'Colour')).toContainText('2 keyframes');
      await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toHaveValue('0.6');
      await expect(page.getByRole('spinbutton', { name: 'Opacity', exact: true })).toHaveValue('65');
      await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toBeDisabled();
      await expect(page.getByRole('slider', { name: 'Opacity', exact: true })).toBeDisabled();
      await expect(layerKeyframes(page, TRACK).locator('.keyframe-row')).toHaveCount(2);
      await inspectorTab(page, 'Clip');
      // Every retained custom clip key (4) and every Transform key (5) is counted, off-trim included.
      await expect(line(page, 'Speed')).toContainText('4 keyframes');
      await expect(line(page, 'Transform')).toContainText('5 keyframes');
      await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toBeDisabled();
      await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toHaveValue('1');
      await expect(diamond(page, 'Speed')).toHaveAttribute('aria-pressed', 'false');
      await expect(transformDiamonds(page)).toHaveCount(8);
      const pose = evaluateSpatial(document.clips[0]!.spatial, 25);
      await expect(page.getByRole('spinbutton', { name: 'Transform Scale', exact: true })).toHaveValue(
        String(pose.scale),
      );
      await expect(page.getByRole('spinbutton', { name: 'Transform Scale', exact: true })).toBeDisabled();
      expect(await pixels(page)).toEqual(graded);
      await previewAt(page, document, 15);
      await testInfo.attach('locked-with-keys', { body: await page.screenshot(), contentType: 'image/png' });
      // A stored setting at the real playhead stays editable: speed key source 30 is displayed at frame 20.
      await seek(page, document, 20);
      await expect(page.getByRole('spinbutton', { name: 'Clip speed rate', exact: true })).toBeEnabled();
      await expect(diamond(page, 'Speed')).toHaveAttribute('aria-pressed', 'true');
      await seek(page, document, 10);
      await expect(page.getByRole('spinbutton', { name: 'Transform Scale', exact: true })).toBeEnabled();
      await inspectorTab(page, 'Track');
      await seek(page, document, 40);
      await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toBeEnabled();
      await seek(page, document, 0);
      await expect(page.getByRole('spinbutton', { name: 'Opacity', exact: true })).toBeEnabled();
      // Collapsing a section hides its keyframe line; the title row stays.
      const colour = page.getByRole('button', { name: 'Colour section', exact: true });
      await colour.click();
      await expect(line(page, 'Colour')).toBeHidden();
      await expect(colour).toBeVisible();
      await colour.click();
      await expect(line(page, 'Colour')).toBeVisible();
      await inspectorTab(page, 'Clip');
      for (const section of ['Speed', 'Transform'] as const) {
        const toggle = page.getByRole('button', { name: `${section} section`, exact: true });
        await toggle.click();
        await expect(line(page, section)).toBeHidden();
        await toggle.click();
        await expect(line(page, section)).toBeVisible();
      }
      expect(await animatePreferences(page)).toEqual([]);
      await unchanged(page, document);
    });

    test('Colour header visits Opacity and all nine scalar settings and retains main arrows', async ({ page }) => {
      const document = await fixture(page, (document) => {
        document.layers[0]!.keyframes = colourSettings.map(({ key }, index) =>
          sharedPoint(index * 5, { [key]: key === 'opacity' ? 1 : 0 }),
        );
      });
      await inspectorTab(page, 'Track');
      await expect(
        inspector(page)
          .locator('.colour-controls')
          .getByRole('button', { name: /^(Previous|Next) / }),
      ).toHaveCount(colourSettings.length * 2);
      for (const { label } of colourSettings) {
        await expect(diamond(page, label)).toBeVisible();
        await expect(diamond(page, label).locator('..')).toHaveClass(/\bkeyframe-setting-navigation\b/);
        await expect(diamond(page, label).locator('..').getByRole('button')).toHaveCount(3);
      }
      const next = navigation(page, 'Colour', 'Next');
      const previous = navigation(page, 'Colour', 'Previous');
      await expect(previous).toBeDisabled();
      for (const frame of [5, 10, 15, 20, 25, 30, 35, 40, 45]) {
        await next.click();
        await previewAt(page, document, frame);
        await expect(layerKeyframes(page, TRACK).locator('.keyframe-row[aria-current="true"]')).toHaveAttribute(
          'data-keyframe-frame',
          String(frame),
        );
      }
      await expect(next).toBeDisabled();
      await previous.click();
      await previewAt(page, document, 40);
      await unchanged(page, document);
    });

    for (const { key, label } of KEYFRAME_SETTINGS) {
      test(`main ${label} arrows skip null settings and retain guarded native focus at endpoints`, async ({ page }) => {
        const value = 0;
        const document = await fixture(page, (document) => {
          document.layers[0]!.keyframes = [
            sharedPoint(10, { [key]: value }),
            sharedPoint(20, { [key === 'exposure' ? 'tint' : 'exposure']: 0.5 }),
            sharedPoint(30, { [key]: value }),
          ];
        });
        await settingTab(page, label);
        await seek(page, document, 0);
        const main = diamond(page, label).locator('..');
        await expect(main).toHaveClass(/\bkeyframe-setting-navigation\b/);
        await expect(main.getByRole('button')).toHaveCount(3);
        for (const button of await main.getByRole('button').all())
          await expect(button).toHaveJSProperty('tagName', 'BUTTON');
        const previous = channelNavigation(page, label, 'Previous');
        const next = channelNavigation(page, label, 'Next');
        const frames = document.layers[0]!.keyframes.filter((point) => point.values[key] !== null).map(
          ({ frame }) => frame,
        );
        await expect(previous).toHaveAttribute('aria-disabled', 'true');
        await next.focus();
        for (const frame of frames) {
          await expect(next).toHaveAttribute('aria-disabled', 'false');
          await next.press('Enter');
          await previewAt(page, document, frame);
          await expect(next).toBeFocused();
          await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
          await expect(page.getByRole('spinbutton', { name: label, exact: true })).toHaveValue(String(value));
        }
        await expect(next).toHaveAttribute('aria-disabled', 'true');
        await expect(next).toHaveJSProperty('disabled', false);
        await expect(next).toHaveAttribute('tabindex', '-1');
        for (const activation of ['Enter', 'Space']) {
          await next.press(activation);
          await expect(next).toBeFocused();
          await previewAt(page, document, frames.at(-1)!);
        }
        await previous.focus();
        for (const frame of frames.slice(0, -1).reverse()) {
          await expect(previous).toHaveAttribute('aria-disabled', 'false');
          await previous.press('Space');
          await previewAt(page, document, frame);
          await expect(previous).toBeFocused();
          await expect(diamond(page, label)).toHaveAttribute('aria-pressed', 'true');
        }
        await expect(previous).toHaveAttribute('aria-disabled', 'true');
        await expect(previous).toHaveJSProperty('disabled', false);
        await expect(previous).toHaveAttribute('tabindex', '-1');
        await previous.press('Enter');
        await expect(previous).toBeFocused();
        await previewAt(page, document, frames[0]!);
        await unchanged(page, document);
      });
    }

    test('enabled-row chip navigation skips other channels and captures the real frame during off-duration inspection', async ({
      page,
    }) => {
      const document = await fixture(page, (document) => {
        document.layers[0]!.keyframes = [
          sharedPoint(0, { exposure: 0, opacity: 0.65 }),
          sharedPoint(10, { tint: 0 }),
          sharedPoint(30, { exposure: 1 }),
          sharedPoint(40, { opacity: 0.5 }),
          sharedPoint(140, { exposure: 2 }),
        ];
      });
      await inspectorTab(page, 'Track');
      const row = layerKeyframes(page, TRACK).locator('[data-keyframe-frame="0"]');
      const nextExposure = row
        .locator('.layer-keyframe-chip')
        .getByRole('button', { name: 'Next Exposure keyframe', exact: true });
      await expect(
        row.locator('.layer-keyframe-chip').getByRole('button', { name: 'Next Tint keyframe', exact: true }),
      ).toHaveCount(0);
      await nextExposure.focus();
      await nextExposure.press('Enter');
      await previewAt(page, document, 30);
      await expect(nextExposure).toBeFocused();
      await nextExposure.press('Space');
      await previewAt(page, document, 89);
      await expect(layerKeyframes(page, TRACK).locator('.layer-keyframe-inspected')).toContainText(
        'Stored keyframe · timeline frame 140',
      );
      await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toBeDisabled();
      await expect(page.getByRole('spinbutton', { name: 'Exposure', exact: true })).toHaveValue(String(1 + 59 / 110));
      await unchanged(page, document);
      await diamond(page, 'Exposure').focus();
      await diamond(page, 'Exposure').press('Enter');
      const expected = structuredClone(document);
      expected.layers[0]!.keyframes.splice(4, 0, sharedPoint(89, { exposure: 1 + 59 / 110 }));
      expect(await current(page)).toEqual(expected);
      await page.evaluate(() => window.pascapLab!.flush());
      expect(memory.saves).toBe(1);
      await expect(diamond(page, 'Exposure')).toHaveAttribute('aria-pressed', 'true');
      // The capture is exactly one history step.
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await current(page)).toEqual(document);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    });

    test('Speed header visits every retained clip source key, including off-trim keys, without editing', async ({
      page,
    }) => {
      const document = await current(page);
      const placed = calculateLayout(document).clips[0]!;
      const sourceTargets = [0, 30, 80, 120].map((source) => nearestOutput(placed, source));
      expect(sourceTargets).toEqual([0, 20, 70, 89]);
      await inspectorTab(page, 'Clip');
      await expect(page.locator('.clip-speed-override')).toHaveCount(0);
      await expect(diamond(page, 'Speed').locator('..').getByRole('button')).toHaveCount(1);
      await expect(
        page
          .locator('.speed-settings span.keyframe-setting-navigation')
          .getByRole('button', { name: /^(Previous|Next) Speed keyframe$/ }),
      ).toHaveCount(0);
      const stored = page.getByRole('spinbutton', { name: 'Clip speed keyframe source frame', exact: true });
      // The displayed source frame 10 follows the off-trim key 0.
      await expect(navigation(page, 'Speed', 'Previous')).toBeEnabled();
      for (const [source, frame] of [
        [30, sourceTargets[1]!],
        [80, sourceTargets[2]!],
        [120, sourceTargets[3]!],
      ] as const) {
        await navigation(page, 'Speed', 'Next').click();
        await previewAt(page, document, frame);
        await expect(stored).toHaveValue(String(source));
      }
      await expect(navigation(page, 'Speed', 'Next')).toBeDisabled();
      for (const [source, frame] of [
        [80, sourceTargets[2]!],
        [30, sourceTargets[1]!],
        [0, sourceTargets[0]!],
      ] as const) {
        await navigation(page, 'Speed', 'Previous').click();
        await previewAt(page, document, frame);
        await expect(stored).toHaveValue(String(source));
      }
      await expect(navigation(page, 'Speed', 'Previous')).toBeDisabled();
      expect((await current(page)).clips[0]!.speed).toEqual(document.clips[0]!.speed);
      await unchanged(page, document);
    });

    test('manual same-frame seek clears the two clip-local cursors without changing stored keys', async ({ page }) => {
      const document = await fixture(page, (document) => {
        const speed = document.clips[0]!.speed;
        if (speed.mode !== 'curve') throw new Error('Expected synthetic custom speed curve');
        speed.keyframes.splice(3, 0, { frame: 110, rate: 1, interpolation: 'linear' });
      });
      await inspectorTab(page, 'Clip');
      const speedSelect = page.getByRole('combobox', { name: 'Selected clip speed keyframe', exact: true });
      const last = await speedSelect.locator('option').filter({ hasText: 'source 120' }).getAttribute('value');
      await speedSelect.selectOption(last!);
      await previewAt(page, document, 89);
      const timecode = page.getByRole('textbox', { name: 'Playhead timecode', exact: true });
      await page.getByRole('button', { name: 'Go to timecode', exact: true }).click();
      await timecode.fill('89');
      await timecode.press('Enter');
      await navigation(page, 'Speed', 'Previous').click();
      await previewAt(page, document, 70);
      await expect(speedSelect.locator('option:checked')).toContainText('source 80');

      const transformSelect = page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true });
      await transformSelect.selectOption('120');
      await previewAt(page, document, 89);
      await page.getByRole('button', { name: 'Go to timecode', exact: true }).click();
      await timecode.fill('89');
      await timecode.press('Enter');
      await navigation(page, 'Transform', 'Next').click();
      await expect(transformSelect).toHaveValue('100');
      await previewAt(page, document, 89);
      await unchanged(page, document);
    });

    test('Transform header and selector reach off-trim/original OUT keys; each setting diamond captures only that actual setting', async ({
      page,
    }) => {
      const document = await current(page);
      const placed = calculateLayout(document).clips[0]!;
      await inspectorTab(page, 'Clip');
      const select = page.getByRole('combobox', { name: 'Selected Transform keyframe', exact: true });
      await expect(select.locator('option')).toHaveCount(5);
      await expect(select.locator('option[value="0"]')).toContainText('outside clip');
      await expect(select.locator('option[value="120"]')).toContainText('outside clip');
      await expect(transformDiamonds(page)).toHaveCount(8);
      await expect(transformDiamond(page)).toHaveCount(1);
      for (const source of [20, 60, 100, 120]) {
        await navigation(page, 'Transform', 'Next').click();
        await previewAt(page, document, nearestOutput(placed, source));
        await expect(select).toHaveValue(String(source));
        const actual = placed.retiming.sourceAt(nearestOutput(placed, source) - placed.start);
        await expect(page.getByRole('region', { name: 'Stored Transform keyframe', exact: true })).toContainText(
          `Stored source frame ${source} · actual displayed source frame ${actual}`,
        );
      }
      await expect(navigation(page, 'Transform', 'Next')).toBeDisabled();
      for (const source of [100, 60, 20, 0]) {
        await navigation(page, 'Transform', 'Previous').click();
        await previewAt(page, document, nearestOutput(placed, source));
        await expect(select).toHaveValue(String(source));
      }
      await expect(navigation(page, 'Transform', 'Previous')).toBeDisabled();
      await select.selectOption('120');
      await previewAt(page, document, 89);
      await expect(page.getByRole('spinbutton', { name: 'Transform Scale', exact: true })).toBeDisabled();
      await expect(transformDiamond(page)).toHaveAttribute('aria-pressed', 'false');
      await unchanged(page, document);
      await transformDiamond(page).focus();
      await transformDiamond(page).press('Space');
      const expected = structuredClone(document);
      expected.clips[0]!.spatial.keyframes.splice(3, 0, {
        frame: placed.retiming.sourceAt(89),
        interpolation: 'linear',
        values: {
          cropLeft: null,
          cropRight: null,
          cropTop: null,
          cropBottom: null,
          scale: evaluateSpatial(document.clips[0]!.spatial, placed.retiming.sourcePositionAt(89)).scale,
          translateX: null,
          translateY: null,
          rotation: null,
        },
      });
      expect(await current(page)).toEqual(expected);
      await expect(transformDiamond(page)).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(() => window.pascapLab!.flush());
      expect(memory.saves).toBe(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect(await current(page)).toEqual(document);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    });

    test('distinct source lanes use placed-map positions, omit off-trim keys and select/seek through click, Space and Enter', async ({
      page,
    }, testInfo) => {
      const document = await fixture(page, (document) => {
        document.layers.push(createLayer('empty-track', 'Empty track'));
      });
      const placed = calculateLayout(document).clips[0]!;
      await expect(page.locator(`[data-clip-id="${CLIP}"] [data-clip-keyframe="transform"]`)).toHaveCount(3);
      await expect(page.locator(`[data-clip-id="${CLIP}"] [data-clip-keyframe="speed"]`)).toHaveCount(2);
      const keys = [
        { type: 'transform', sources: [20, 60, 100] },
        { type: 'speed', sources: [30, 80] },
      ] as const;
      for (const { type, sources } of keys) {
        for (const source of sources) {
          const key = marker(page, type, source);
          const output = source === placed.clip.sourceOut ? placed.duration : placed.retiming.outputAt(source);
          await expect(key).toHaveClass(new RegExp(`\\b${type}\\b`));
          await expect(key).toHaveAttribute('draggable', 'false');
          await expect(key).toHaveAttribute('data-timeline-frame', String(placed.start + output));
          await expect(key).toHaveAttribute('data-seek-frame', String(nearestOutput(placed, source)));
          expect(
            await key.evaluate((element) =>
              (element as HTMLElement).style.getPropertyValue('--clip-keyframe-position'),
            ),
          ).toBe(`${(output / placed.duration) * 100}%`);
          await expect(key).toHaveAttribute('title', /Drag to move; Arrow keys: 1 source frame, Shift: 10$/);
          if (type === 'speed') await expect(key).toHaveAttribute('title', / · 1× · /);
          const bounds = await key.evaluate((element) => {
            const clip = element.closest('.timeline-clip')!.getBoundingClientRect();
            const marker = element.getBoundingClientRect();
            return { x: marker.x - clip.x, width: marker.width, clipWidth: clip.width };
          });
          const expectedX = Math.max(
            0,
            Math.min(bounds.clipWidth - bounds.width, (output / placed.duration) * bounds.clipWidth - bounds.width / 2),
          );
          expect(bounds.x).toBeCloseTo(expectedX, 1);
        }
      }
      const appearance = await page.locator('.timeline-clip-key').evaluateAll((elements) =>
        elements.map((element) => ({
          type: element.getAttribute('data-clip-keyframe'),
          top: getComputedStyle(element).top,
          colour: getComputedStyle(element).color,
          border: getComputedStyle(element.querySelector('span')!).borderBottomStyle,
        })),
      );
      const transform = appearance.find(({ type }) => type === 'transform')!;
      const speed = appearance.find(({ type }) => type === 'speed')!;
      expect(transform.top).not.toBe(speed.top);
      expect(transform.colour).not.toBe(speed.colour);
      expect(speed.border).toBe('dashed');
      expect(transform.border).not.toBe('dashed');
      for (const activation of [
        { type: 'transform', source: 20, key: null },
        { type: 'speed', source: 80, key: 'Space' },
        { type: 'transform', source: 100, key: 'Enter' },
      ] as const) {
        await page.getByRole('button', { name: 'Select track Empty track', exact: true }).click();
        await expect(page.locator(`[data-clip-id="${CLIP}"]`)).not.toHaveClass(/selected/);
        const key = marker(page, activation.type, activation.source);
        if (activation.key) {
          await key.focus();
          await key.press(activation.key);
        } else await key.click();
        await expect(page.locator(`[data-clip-id="${CLIP}"]`)).toHaveClass(/selected/);
        await previewAt(page, document, nearestOutput(placed, activation.source));
        await expect(key).toBeFocused();
        await expect(page.locator('.timeline-drop-preview')).toHaveCount(0);
      }
      await testInfo.attach('source-keyframe-lanes', { body: await page.screenshot(), contentType: 'image/png' });
      await unchanged(page, document);
    });

    test('source-marker and stored-field keyboard events stay isolated from timeline playback and editing shortcuts', async ({
      page,
    }) => {
      const document = await current(page);
      const key = marker(page, 'transform', 60);
      await key.focus();
      await key.press('Enter');
      await previewAt(page, document, 50);
      // Arrow keys move a Transform key (spatial-editor spec); every other shortcut must stay isolated.
      for (const shortcut of ['s', 'q', 'w', 'i', 'o', 'Control+d', 'Delete']) await key.press(shortcut);
      await previewAt(page, document, 50);
      await expect(key).toBeFocused();
      await key.press('Space');
      await previewAt(page, document, 50);
      await inspectorTab(page, 'Clip');
      const field = page.getByRole('spinbutton', { name: 'Transform keyframe source frame', exact: true });
      const stored = await field.inputValue();
      await field.focus();
      await field.press('Control+a');
      await field.press('s');
      await field.press('Escape');
      await expect(field).toHaveValue(stored);
      await previewAt(page, document, 50);
      await unchanged(page, document);
    });

    test('shared, Transform and custom-speed selectors visibly read Easing with contextual accessible names', async ({
      page,
    }) => {
      const document = await fixture(page, (document) => {
        document.layers[0]!.keyframes = [sharedPoint(0, { exposure: 0 }), sharedPoint(40, { tint: 0 })];
      });
      await editLayerPoint(page, TRACK, 0);
      await easing(page, 'Track keyframe easing 0');
      await inspectorTab(page, 'Clip');
      await easing(page, 'Transform keyframe easing');
      await easing(page, 'Clip speed keyframe easing');
      const selector = page.getByRole('combobox', { name: 'Selected clip speed keyframe', exact: true });
      await expect(selector.locator('option')).toHaveCount(4);
      await expect(selector.locator('option').last()).toContainText('source 120 · outside clip');
      await unchanged(page, document);
    });

    test('a real custom-speed pointer draft disables section navigation, chips and source markers; Escape restores without a save', async ({
      page,
    }) => {
      const document = await fixture(page, (document) => {
        document.layers[0]!.keyframes = [sharedPoint(0, { exposure: 0 }), sharedPoint(40, { exposure: 0.6 })];
      });
      await seek(page, document, 15);
      await inspectorTab(page, 'Clip');
      const point = page.getByRole('button', { name: 'Clip speed keyframe 30', exact: true });
      await point.scrollIntoViewIfNeeded();
      const box = (await point.boundingBox())!;
      const plot = (await page.locator('.clip-speed-plot').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + plot.width / 18, box.y + box.height / 2, { steps: 3 });
      await expect(page.getByRole('region', { name: 'Clip speed curve editor', exact: true })).toHaveAttribute(
        'data-drafting',
        'true',
      );
      for (const section of ['Speed', 'Transform'] as const)
        await expect(navigation(page, section, 'Next')).toBeDisabled();
      await expect(diamond(page, 'Speed')).toBeDisabled();
      await expect(marker(page, 'speed', 80)).toBeDisabled();
      await expect(transformDiamond(page)).toBeDisabled();
      await expect(marker(page, 'transform', 60)).toBeDisabled();
      // A synthetic tab click cannot end or move the captured real pointer gesture.
      await settingTab(page, 'Exposure');
      await expect(navigation(page, 'Colour', 'Next')).toBeDisabled();
      await expect(diamond(page, 'Exposure')).toBeDisabled();
      for (const direction of ['Previous', 'Next'] as const)
        await expect(channelNavigation(page, 'Exposure', direction)).toHaveAttribute('aria-disabled', 'true');
      await expect(
        layerKeyframes(page, TRACK)
          .locator('[data-keyframe-frame="0"] .layer-keyframe-chip')
          .getByRole('button', { name: 'Next Exposure keyframe', exact: true }),
      ).toBeDisabled();
      expect(await current(page)).toEqual(document);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await expect(
        page.getByRole('region', { name: 'Clip speed curve editor', exact: true, includeHidden: true }),
      ).toHaveAttribute('data-drafting', 'false');
      await expect(navigation(page, 'Colour', 'Previous')).toBeEnabled();
      await previewAt(page, document, 15);
      expect(await animatePreferences(page)).toEqual([]);
      await unchanged(page, document);
    });
  });
}
