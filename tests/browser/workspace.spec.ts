import { expect, test, type Page } from '@playwright/test';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { closeOptions, openOptions } from './editor-helpers.js';

let saved: ProjectDocument;
let writes: number;
let failure: number;
let reads: number;

test.beforeEach(async ({ page, request }) => {
  const library = (await (await request.get('/api/media')).json()) as { assets: MediaAsset[] };
  saved = createProject('preview-lab', 'Workspace test · memory-only');
  saved.media.videoIds = library.assets.map((asset) => asset.id);
  saved.clips = ['pattern-a.mp4', 'pattern-b.mp4'].map((name, index) => ({
    ...createClip(`clip-${index}`, library.assets.find((asset) => asset.name === name)!.id, 15, 105),
    start: index * 90,
  }));
  saved.layers[0]!.transitions = [{ leftId: 'clip-0', rightId: 'clip-1', type: 'cut', duration: 0 }];
  saved = projectSchema.parse(saved);
  writes = 0;
  failure = 0;
  reads = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.abort('blockedbyclient');
      return;
    }
    await route.fulfill({
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
    });
  });
  await page.route('**/api/projects/preview-lab', async (route) => {
    if (route.request().method() === 'GET') {
      reads++;
      await route.fulfill({ json: { document: saved } });
      return;
    }
    if (route.request().method() === 'PUT') {
      writes++;
      if (failure) {
        await route.fulfill({
          status: failure,
          json: {
            error:
              failure === 409
                ? 'Another editor saved a newer revision.'
                : 'Temporary local service error. Draft retained.',
          },
        });
        return;
      }
      const body = route.request().postDataJSON() as { document: unknown; expectedRevision: number };
      if (body.expectedRevision !== saved.revision) {
        await route.fulfill({ status: 409, json: { error: 'The saved revision changed.' } });
        return;
      }
      saved = projectSchema.parse({ ...projectSchema.parse(body.document), revision: saved.revision + 1 });
      await route.fulfill({ json: { document: saved } });
      return;
    }
    await route.abort('blockedbyclient');
  });
  await page.goto('/?project=preview-lab');
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
});

async function hoverSource(page: Page, name: string, ratio: number): Promise<void> {
  const button = page.getByRole('button', { name: `Review ${name}`, exact: true });
  await button.scrollIntoViewIfNeeded();
  const bounds = (await button.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * ratio, bounds.y + bounds.height / 2);
}

test('rename is an explicit draft with Escape, empty-title recovery and one undoable commit', async ({ page }) => {
  const title = page.getByRole('textbox', { name: 'Project title', exact: true });
  const original = saved.title;
  await title.fill('New title');
  expect(await page.evaluate(() => window.pascapLab!.project()!.title)).toBe(original);
  await title.press('Escape');
  await expect(title).toHaveValue(original);
  await title.fill('');
  await title.press('Enter');
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  expect(writes).toBe(0);
  await title.press('Escape');
  await title.fill('Renamed flight');
  await title.press('Enter');
  await expect(title).toBeFocused();
  expect(await page.evaluate(() => window.pascapLab!.project()!.title)).toBe('Renamed flight');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(title).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('pane resize cancels on Escape, persists on release/keyboard and never edits the project', async ({ page }) => {
  const before = await page.evaluate(() => window.pascapLab!.project());
  const resizer = page.getByRole('slider', { name: 'Resize Media panel' });
  const initial = Number(await resizer.getAttribute('aria-valuenow'));
  const box = (await resizer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 40, { steps: 4 });
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBeGreaterThan(initial);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initial));
  expect(await page.evaluate(() => localStorage.getItem('pascap-workspace-layout'))).toBeNull();
  await resizer.focus();
  await resizer.press('ArrowRight');
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initial + 16));
  await page.getByRole('slider', { name: 'Resize Timeline panel' }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('slider', { name: 'Resize Timeline panel' })).toHaveAttribute('aria-valuenow', '306');
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(before);
  expect(writes).toBe(0);
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await expect(resizer).toHaveAttribute('aria-valuenow', String(initial + 16));
  await openOptions(page, 'Workspace options');
  await page.getByRole('button', { name: 'Toggle Clip panel' }).click();
  await expect(page.getByRole('complementary', { name: 'Clip inspector' })).toBeHidden();
  await openOptions(page, 'Workspace options');
  await page.getByRole('button', { name: 'Reset workspace layout' }).click();
  await expect(resizer).toHaveAttribute('aria-valuenow', '300');
  await closeOptions(page);
  await expect(page.getByRole('complementary', { name: 'Clip inspector' })).toBeVisible();
});

test('workspace keeps both side panels without document overflow at the default and minimum viewports', async ({
  page,
}) => {
  const before = await page.evaluate(() => window.pascapLab!.project());
  for (const { width, height } of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('region', { name: 'Video timeline' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeInViewport();
    await expect(page.getByRole('complementary', { name: 'Clip inspector' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Media library' })).toBeVisible();
  }
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(before);
  expect(writes).toBe(0);
});

test('docked source pinning preserves list geometry, preview position and non-destructive selection', async ({
  page,
}) => {
  await page.evaluate(() => window.pascapLab!.engine.seek(30));
  const row = page.getByRole('button', { name: 'Review pattern-a.mp4', exact: true });
  const before = await row.boundingBox();
  await hoverSource(page, 'pattern-a.mp4', 0.25);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '30');
  expect(await row.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(30);
  await page.getByRole('button', { name: 'Pin source review' }).click();
  const firstId = await page.locator('.source-preview').getAttribute('data-media-id');
  await hoverSource(page, 'pattern-b.mp4', 0.9);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-media-id', firstId!);
  await page.getByRole('button', { name: 'Pin source review' }).click();
  await hoverSource(page, 'pattern-b.mp4', 0.5);
  await expect(page.locator('.source-preview')).toHaveAttribute('data-source-frame', '60');
  await expect(page.locator('.source-range-editor')).toHaveCount(1);
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Review source frame of pattern-b.mp4', exact: true }).press('i');
  expect(await page.evaluate(() => window.pascapLab!.project()!.clips[1]!.sourceIn)).toBe(15);
  await page.getByRole('tab', { name: 'Source preview', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Timeline preview' })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Timeline preview' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Source preview', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close source review' }).click();
  await expect(page.locator('video[data-source-decoder]')).toHaveCount(0);
});

test('help/modal keyboard context preserves clips and timecode supports exact frame navigation', async ({ page }) => {
  const before = await page.evaluate(() => window.pascapLab!.project());
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Delete');
  await page.keyboard.press('s');
  expect(await page.evaluate(() => window.pascapLab!.project())).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to timecode' }).click();
  const input = page.getByRole('textbox', { name: 'Playhead timecode' });
  await input.fill('00:00:01:15');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(45);
  await page.getByRole('button', { name: 'Go to timecode' }).click();
  await input.fill('9999');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(await page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(45);
  await input.press('Escape');
  await page.getByRole('region', { name: 'Video timeline' }).focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(55);
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => window.pascapLab!.engine.diagnostics().frame)).toBe(0);
});

test('retryable autosave failures keep the draft and require an explicit retry with the same revision', async ({
  page,
}) => {
  failure = 503;
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.6');
  await page.evaluate(() => window.pascapLab!.flush());
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible();
  expect(writes).toBe(1);
  expect(saved.layers[0]?.colour.exposure).toBe(0);
  await page.getByRole('slider', { name: 'Saturation', exact: true }).fill('1.4');
  await page.evaluate(() => window.pascapLab!.flush());
  expect(writes).toBe(1);
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.colour.exposure)).toBe(0.6);
  failure = 0;
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByRole('status', { name: 'Saved on this device' })).toContainText('Saved locally');
  expect(writes).toBe(2);
  expect(saved.layers[0]?.colour).toMatchObject({ exposure: 0.6, saturation: 1.4 });
  expect(saved.revision).toBe(1);
});

test('conflicts never overwrite or auto-rebase: download and confirmed reload preserve the saved project', async ({
  page,
}) => {
  saved = { ...saved, title: 'Other tab save', revision: 1 };
  failure = 409;
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.4');
  await page.evaluate(() => window.pascapLab!.flush());
  await expect(page.getByRole('button', { name: 'Retry save' })).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download unsaved project', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('preview-lab-unsaved.json');
  await page.getByRole('button', { name: 'Review latest save' }).click();
  await expect(page.getByRole('dialog', { name: 'Recover an unsaved project' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing this draft' }).click();
  expect(writes).toBe(1);
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.colour.exposure)).toBe(0.4);
  await page.getByRole('button', { name: 'Review latest save' }).click();
  await page.getByRole('button', { name: 'Discard local changes and reload' }).click();
  await expect(page.getByRole('textbox', { name: 'Project title', exact: true })).toHaveValue('Other tab save');
  await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  expect(writes).toBe(1);
  expect(reads).toBeGreaterThan(1);
  expect(saved.revision).toBe(1);
});

test('failed project opens stay in the dialog and do not discard the current editor', async ({ page }) => {
  await page.getByRole('button', { name: 'Open projects' }).click();
  await page.route('**/api/projects/preview-lab', (route) =>
    route.fulfill({ status: 503, json: { error: 'Cannot read the saved project right now.' } }),
  );
  await page.getByRole('button', { name: `Open ${saved.title}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Cannot read');
  expect(await page.evaluate(() => window.pascapLab!.project()!.title)).toBe(saved.title);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open projects' })).toBeFocused();
});

test('Escape closes the Projects, Export and shortcut dialogs and restores focus to their triggers', async ({
  page,
}) => {
  for (const [trigger, dialog] of [
    ['Open projects', 'Projects'],
    ['Export video', 'Export video'],
    ['Keyboard shortcuts', 'Keyboard shortcuts'],
  ] as const) {
    await page.getByRole('button', { name: trigger, exact: true }).click();
    await expect(page.getByRole('dialog', { name: dialog, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: trigger, exact: true })).toBeFocused();
  }
  await page.getByRole('button', { name: 'Open projects' }).click();
  await expect(page.getByRole('dialog', { name: 'Projects' })).toContainText(
    'Projects saved by an older PasCap version cannot be opened. They are kept unchanged.',
  );
  await expect(page.getByRole('combobox', { name: 'Project filter' }).locator('option')).toHaveText([
    'All projects',
    'Can open',
    'Cannot open (older version)',
  ]);
  expect(writes).toBe(0);
});

test('no-project startup performs no hidden create and unavailable service has a read-only retry path', async ({
  page,
}) => {
  let creates = 0;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'POST') creates++;
    await route.fulfill({ json: { projects: [] } });
  });
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Projects' })).toBeVisible();
  expect(creates).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Keyframe Exposure', exact: true, includeHidden: true }),
  ).toBeDisabled();
  await page.route('**/api/health', (route) =>
    route.fulfill({ status: 403, json: { error: 'Local service configuration needs attention.' } }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry connecting' })).toBeVisible();
  expect(creates).toBe(0);
  await page.unroute('**/api/health');
  await page.getByRole('button', { name: 'Retry connecting' }).click();
  await expect(page.getByRole('dialog', { name: 'Projects' })).toBeVisible();
  expect(creates).toBe(0);
});

test('denied browser preference storage does not prevent opening/editing a project', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error('Storage denied');
    };
    Storage.prototype.setItem = () => {
      throw new Error('Storage denied');
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused');
  await openOptions(page, 'Media options');
  await page.getByRole('button', { name: 'Grid view' }).click();
  await expect(page.locator('.media-items')).toHaveClass('media-items grid');
  await closeOptions(page);
  await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('0.3');
  expect(await page.evaluate(() => window.pascapLab!.project()!.layers[0]!.colour.exposure)).toBe(0.3);
  await openOptions(page, 'Workspace options');
  await page.getByRole('button', { name: 'Toggle Clip panel' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Layout changed for this session' })).toBeVisible();
});

test('automatic proxy import reports accepted jobs and rejected files without duplicate preparation POSTs', async ({
  page,
}) => {
  let preparations = 0;
  let imports = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/prepare')) preparations++;
  });
  await page.route('**/api/media/import', async (route) => {
    imports++;
    const { assets } = (await (await page.request.get('/api/media')).json()) as { assets: MediaAsset[] };
    const job: MediaJob = {
      id: 'queued-import-test',
      kind: 'prepare',
      label: 'New recording',
      state: 'queued',
      progress: 0,
      message: 'Queued for editing',
      createdAt: '2026-10-03T10:00:00Z',
      finishedAt: null,
      outputUrl: null,
      receiptUrl: null,
    };
    await route.fulfill({
      status: 202,
      json: {
        assets: [assets[0]],
        ignored: 2,
        added: 1,
        existing: 0,
        jobs: [job],
        queueErrors: [],
        errors: [{ path: '/tmp/flight/unsupported.mp4', message: 'HDR is not supported' }],
      },
    });
  });
  await page.getByRole('button', { name: 'Import folder', exact: true }).click();
  await page.getByText('Import a whole folder by path', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Absolute folder path on this machine' }).fill('/tmp/disposable-flight');
  await page.getByRole('button', { name: 'Register recordings' }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText('1 recordings registered');
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText(
    '1 editing proxies queued automatically',
  );
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText('2 unrelated files ignored');
  await page.getByText('Rejected files', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toContainText(
    'unsupported.mp4: HDR is not supported',
  );
  expect(imports).toBe(1);
  expect(preparations).toBe(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import folder', exact: true })).toBeFocused();
});

test('an accepted export remains in Activity when status refresh fails, without repeating its POST', async ({
  page,
}) => {
  const accepted: MediaJob = {
    id: 'ux-queued-export',
    kind: 'export',
    label: 'Workspace test · 720p',
    state: 'queued',
    progress: 0,
    message: 'Waiting for the media worker',
    createdAt: '2026-10-03T10:00:00Z',
    finishedAt: null,
    outputUrl: null,
    receiptUrl: null,
  };
  let submissions = 0;
  await page.route('**/api/exports', async (route) => {
    submissions++;
    await route.fulfill({ status: 202, json: { job: accepted } });
  });
  await page.route('**/api/jobs', (route) =>
    route.fulfill({ status: 503, json: { error: 'Status refresh temporarily unavailable.' } }),
  );
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export video' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Active jobs' })).toContainText('Workspace test · 720p');
  await expect(page.locator('.activity-drawer').getByRole('alert')).toContainText('Status refresh');
  expect(submissions).toBe(1);
  await page.route('**/api/jobs', (route) => route.fulfill({ json: { jobs: [accepted] } }));
  await page.getByRole('button', { name: 'Refresh activity' }).click();
  await expect(page.locator('.activity-drawer').getByRole('alert')).toHaveCount(0);
  expect(submissions).toBe(1);
  await page.getByRole('button', { name: 'Close activity' }).click();
  await expect(page.getByRole('button', { name: 'Open activity' })).toBeFocused();
});

test('rejected exports stay in their dialog with an explicit recovery action and no native output link', async ({
  page,
}) => {
  let submissions = 0;
  await page.route('**/api/exports', async (route) => {
    submissions++;
    await route.fulfill({
      status: 422,
      json: { error: 'The original source is unavailable. Reconnect it before exporting.' },
    });
  });
  await page.getByRole('button', { name: 'Export video', exact: true }).click();
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export video' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Reconnect it');
  await expect(page.getByRole('button', { name: 'Start export', exact: true })).toBeEnabled();
  expect(submissions).toBe(1);
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  await expect.poll(() => submissions).toBe(2);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export video', exact: true })).toBeFocused();
});
