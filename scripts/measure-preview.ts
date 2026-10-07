import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { PreviewDiagnostics } from '../src/preview/engine.js';
import { createConfig } from '../src/server/config.js';
import { extractComparisonFrame, meanAbsoluteError } from '../src/server/library.js';
import { atomicWrite } from '../src/server/storage.js';
import { NEUTRAL_COLOUR, type ColourSettings } from '../src/shared/colour.js';
import { applyCommand } from '../src/shared/commands.js';
import { needsLayeredExport } from '../src/shared/export.js';
import { jobSchema } from '../src/shared/media.js';
import { projectSchema } from '../src/shared/model.js';
import { forEachSerial } from '../src/shared/serial.js';
import { calculateLayout, layerClips } from '../src/shared/timeline.js';
import { framesToSeconds } from '../src/shared/timing.js';

const reportId = 'preview-v8';
const measurementProfile = {
  id: 'original-two-excerpts-v6',
  // Diagnostic profile format is independent of the project document schema.
  schemaVersion: 6,
  projectSchemaVersion: 8,
  description:
    'Strict schema-8 original two-excerpt colour/seek/transition/native-reference diagnostic: one enabled zero-origin contiguous track, unit row-owned Opacity, static clip grades, constant 1× speed, no shared project-frame layer points and an empty music array.',
} as const;
const url = process.env['PASCAP_MEASURE_URL'] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !process.argv.includes('--headed'),
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// tsx/esbuild preserves nested function names using this helper. Evaluated functions
// are serialised into the page and cannot otherwise access the Node-side helper.
await page.addInitScript('globalThis.__name = (fn) => fn;');
// Keep historical report identifiers/output files separate from new schema-8 measurements.
const directory = path.resolve('.pascap/measurements', reportId);
await mkdir(directory, { recursive: true });
try {
  await page.goto(url);
  await page.waitForFunction(() => window.pascapLab?.engine.diagnostics().status === 'paused', undefined, {
    timeout: 15_000,
  });
  const original = projectSchema.parse(await page.evaluate(() => window.pascapLab!.project()));
  // This is the original two-clip colour/seek comparison, not the production
  // layered renderer. Reject shared layer points/opacity rather than measure a false baseline.
  if (
    original.schemaVersion !== 8 ||
    original.clips.length !== 2 ||
    original.music.length !== 0 ||
    needsLayeredExport(original) ||
    original.clips.some((clip) => clip.speed.mode !== 'constant' || clip.speed.rate !== 1)
  )
    throw new Error(
      'This schema-8 diagnostic expects two normal-speed excerpts on one enabled, opaque, zero-origin contiguous track, without music, extra layers or shared project-frame layer points. Choose a compatible project with PASCAP_MEASURE_URL (for example ?project=sample-taillefer-v6; the identifier is not its schema version); no saved document will be changed.',
    );
  const layout = calculateLayout(original);
  const clips = layerClips(original, original.layers[0]!.id);
  const grades: ColourSettings[] = [
    { ...NEUTRAL_COLOUR },
    { ...NEUTRAL_COLOUR, exposure: 1 },
    { ...NEUTRAL_COLOUR, brightness: 0.1 },
    { ...NEUTRAL_COLOUR, contrast: 1.3 },
    { ...NEUTRAL_COLOUR, hue: 45 },
    { ...NEUTRAL_COLOUR, saturation: 0.4 },
    { ...NEUTRAL_COLOUR, highlights: -0.5 },
    { ...NEUTRAL_COLOUR, shadows: 0.3 },
    { exposure: 0.6, brightness: 0.02, contrast: 1.1, hue: 12, saturation: 1.2, highlights: -0.2, shadows: 0.15 },
  ];
  const gpu = await page.evaluate(
    (settings) => settings.map((grade) => ({ grade, ...window.pascapLab!.verifyColour(grade) })),
    grades,
  );
  const seeks: {
    requested: number;
    frame: number;
    status: PreviewDiagnostics['status'];
    latencyMs: PreviewDiagnostics['lastSeekMs'];
  }[] = [];
  const region = layout.transitions[0]!;
  const positions = [
    ...new Set([
      0,
      30,
      Math.max(0, region.start - 5),
      region.start,
      Math.floor((region.start + region.end) / 2),
      region.end,
      layout.duration - 30,
      layout.duration - 1,
    ]),
  ].filter((frame) => frame < layout.duration);
  await forEachSerial([...positions, ...[...positions].reverse()], async (frame) => {
    seeks.push(
      await page.evaluate(async (position) => {
        const engine = window.pascapLab!.engine;
        await engine.seek(position);
        const result = engine.diagnostics();
        return { requested: position, frame: result.frame, status: result.status, latencyMs: result.lastSeekMs };
      }, frame),
    );
  });
  const colour: { grade: ColourSettings; latencyMs: PreviewDiagnostics['colourLatencyMs'] }[] = [];
  await page.evaluate(() => window.pascapLab!.engine.seek(45));
  await forEachSerial(grades, async (grade) => {
    colour.push(
      await page.evaluate(
        async ({ settings, clipId }) => {
          const engine = window.pascapLab!.engine;
          engine.updateColour(clipId, settings);
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return { grade: settings, latencyMs: engine.diagnostics().colourLatencyMs };
        },
        { settings: grade, clipId: clips[0]!.id },
      ),
    );
  });
  const playbackModes = process.argv.includes('--skip-playback')
    ? []
    : (['cut', 'fade-through-black', 'cross-dissolve'] as const);
  const playback: { type: (typeof playbackModes)[number]; repetition: number; result: unknown }[] = [];
  await forEachSerial(playbackModes, async (type) => {
    const snapshot = applyCommand(original, {
      type: 'transition',
      transition:
        type === 'cut'
          ? { leftId: clips[0]!.id, rightId: clips[1]!.id, type, duration: 0 }
          : { leftId: clips[0]!.id, rightId: clips[1]!.id, type, duration: 30 },
    });
    const duration = calculateLayout(snapshot).duration;
    await forEachSerial([0, 1], async (repetition) => {
      console.log(`Measuring ${type}, pass ${repetition + 1} (engine only; saved edit unchanged)`);
      const result = await page.evaluate(
        async ({ document, duration }) => {
          const engine = window.pascapLab!.engine;
          const isFpsSample = (sample: PreviewDiagnostics): boolean => sample.playing && sample.previewFps > 5;
          const sampleFps = (sample: PreviewDiagnostics): number => sample.previewFps;
          const hasTwoDecoders = (sample: PreviewDiagnostics): boolean => sample.activeDecoders === 2;
          await engine.loadProject(document, (id) => `/api/media/${id}/proxy`);
          await engine.seek(0);
          const before = engine.diagnostics();
          return new Promise<unknown>((resolve, reject) => {
            const started = performance.now();
            const samples: ReturnType<typeof engine.diagnostics>[] = [];
            let finished = false;
            let unsubscribe = (): void => {};
            const timer = setTimeout(() => finish('timeout'), Math.max(20_000, duration * 100));
            const finish = (reason: string): void => {
              if (finished) {
                return;
              }
              finished = true;
              clearTimeout(timer);
              unsubscribe();
              engine.pause();
              const after = engine.diagnostics();
              const elapsedMs = performance.now() - started;
              resolve({
                reason,
                elapsedMs,
                effectiveFps: ((after.renderedFrames - before.renderedFrames) / elapsedMs) * 1000,
                before,
                after,
                fpsSamples: samples.filter(isFpsSample).map(sampleFps),
                twoDecoderSamples: samples.filter(hasTwoDecoders).length,
              });
            };
            unsubscribe = engine.subscribe((state) => {
              samples.push(state);
              if (state.status === 'error') {
                finish('error');
              }
              if (!state.playing && state.status === 'paused' && state.frame === state.duration - 1) {
                finish('end');
              }
            });
            void engine.play().catch(reject);
          });
        },
        { document: snapshot, duration },
      );
      playback.push({ type, repetition, result });
    });
  });
  await atomicWrite(
    path.join(directory, 'playback.json'),
    `${JSON.stringify({ reportId, profile: measurementProfile, date: new Date().toISOString(), browser: browser.version(), gpu, seeks, colour, playback }, null, 2)}\n`,
  );

  const comparisons: { frame: number; meanAbsoluteError8Bit: number }[] = [];
  let reference: unknown = null;
  if (process.argv.includes('--reference')) {
    let snapshot = applyCommand(original, { type: 'colour', clipId: clips[0]!.id, colour: grades.at(-1)! });
    snapshot = applyCommand(snapshot, {
      type: 'colour',
      clipId: clips[1]!.id,
      colour: { ...NEUTRAL_COLOUR, exposure: -0.25, hue: -6, saturation: 0.9 },
    });
    console.log('Rendering an immutable graded reference for browser/native comparison.');
    const response = await page.evaluate(async (document) => {
      const result = await fetch('/api/reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PasCap-Client': 'preview-lab' },
        body: JSON.stringify({ document }),
      });
      return result.json() as Promise<unknown>;
    }, snapshot);
    const job = z.object({ job: jobSchema }).parse(response).job;
    const finished = await page.evaluate(
      (id) =>
        new Promise<unknown>((resolve, reject) => {
          let finished = false;
          const timer = setTimeout(() => {
            finished = true;
            reject(new Error('Reference render timed out after 120 seconds.'));
          }, 120_000);
          const check = async (): Promise<void> => {
            try {
              const response = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
              const result = (await response.json()) as { job: { state: string } };
              if (!['queued', 'running'].includes(result.job.state)) {
                finished = true;
                clearTimeout(timer);
                resolve(result);
                return;
              }
              if (!finished)
                setTimeout(() => {
                  void check();
                }, 500);
            } catch (error) {
              finished = true;
              clearTimeout(timer);
              reject(error);
            }
          };
          void check();
        }),
      job.id,
    );
    const completed = z.object({ job: jobSchema }).parse(finished).job;
    if (completed.state !== 'completed') throw new Error(completed.message);
    reference = {
      ...completed,
      receipt: await page.evaluate(async (url) => (await fetch(url!)).json() as Promise<unknown>, completed.receiptUrl),
    };
    await page.evaluate(
      async (document) => window.pascapLab!.engine.loadProject(document, (id) => `/api/media/${id}/proxy`),
      snapshot,
    );
    const nativeFile = path.resolve('.pascap/renders', job.id, 'reference.mp4');
    await forEachSerial(
      [
        0,
        60,
        Math.floor((region.start + region.end) / 2),
        Math.min(layout.duration - 1, region.end + 30),
        layout.duration - 1,
      ],
      async (frame) => {
        const encoded = await page.evaluate(async (position) => {
          const engine = window.pascapLab!.engine;
          await engine.seek(position);
          const rgba = engine.capturePixels();
          const rgb = new Uint8Array(160 * 90 * 3);
          for (let y = 0; y < 90; y++) {
            for (let x = 0; x < 160; x++) {
              for (let channel = 0; channel < 3; channel++) {
                let sum = 0;
                for (let dy = 0; dy < 8; dy++) {
                  for (let dx = 0; dx < 8; dx++) {
                    sum += rgba[((719 - (y * 8 + dy)) * 1280 + x * 8 + dx) * 4 + channel]!;
                  }
                }
                rgb[(y * 160 + x) * 3 + channel] = Math.round(sum / 64);
              }
            }
          }
          const encodeBytes = (bytes: Uint8Array): string => {
            let text = '';
            for (const byte of bytes) {
              text += String.fromCodePoint(byte);
            }
            return btoa(text);
          };
          return encodeBytes(rgb);
        }, frame);
        const native = await extractComparisonFrame(createConfig(), nativeFile, frame, 'tv');
        comparisons.push({ frame, meanAbsoluteError8Bit: meanAbsoluteError(Buffer.from(encoded, 'base64'), native) });
      },
    );
    await page.evaluate(() => window.pascapLab!.engine.seek(60));
  }
  await page.screenshot({ path: path.join(directory, 'preview-workbench.png') });
  const report = {
    reportId,
    profile: measurementProfile,
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    headless: !process.argv.includes('--headed'),
    hardware: {
      platform: os.platform(),
      release: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      ramGiB: os.totalmem() / 1024 ** 3,
    },
    renderer: await page.evaluate(() => window.pascapLab!.engine.diagnostics().renderer),
    projectSnapshot: original,
    durationSeconds: framesToSeconds(layout.duration),
    notes: [
      'No saved edit is changed; only the independent engine is exercised.',
      'Only strict schema-8 projects are measured; schema 1–7 data is incompatible and never migrated or defaulted.',
      'Diagnostic profile and reference receipt schema versions are independent of the project schema.',
      'This retains the original two-excerpt acceptance measurements, not shared-layer-point or layered-throughput certification.',
      'Colour latency is engine update to next paint, not full input-event/React latency.',
      'FPS includes buffering; memory readings are Chromium JS heap, not total decoder/GPU process memory.',
      'Native/proxy comparison is downsampled RGB MAE, including scaling, H.264 4:2:0 and browser conversion.',
      'Integrated-browser performance is diagnostic only; target-GPU acceptance is pending external-browser validation.',
      ...(process.argv.includes('--skip-playback') ? ['Repeated playback measurement explicitly skipped.'] : []),
    ],
    gpu,
    seeks,
    colour,
    playback,
    reference,
    comparisons,
  };
  await atomicWrite(path.join(directory, 'preview.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.join(directory, 'preview.json')}`);
  console.log(`GPU max error: ${Math.max(...gpu.map((value) => value.maxError8Bit)).toFixed(3)} / 255`);
  console.log('Browser/native frame MAE / 255:', comparisons);
} finally {
  await browser.close();
}
