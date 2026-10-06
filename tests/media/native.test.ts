import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preparedFixture } from '../../scripts/fixtures.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { extractComparisonFrame } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import { startReference } from '../../src/server/reference.js';
import { generateCube, gradePixel, NEUTRAL_COLOUR, type ColourSettings } from '../../src/shared/colour.js';
import { applyCommand } from '../../src/shared/commands.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
describe.skipIf(!enabled)('native FFmpeg integration · disposable synthetic sources', () => {
  let config: ServiceConfig;
  let fixture: Awaited<ReturnType<typeof preparedFixture>>;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pascap-media-'));
    config = createConfig({ dataDir: directory });
    fixture = await preparedFixture(config);
  });
  afterAll(async () => {
    await fixture?.jobs.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('preserves originals and verifies all proxy frames/rate/sampled pixels', async () => {
    for (const asset of fixture.library.list()) {
      expect(asset.status).toBe('ready');
      expect(asset.prepared?.width).toBe(320);
      expect(asset.prepared?.verification.frameCount).toBe(120);
      expect(asset.prepared?.verification.samples.every((sample) => sample.meanAbsoluteError8Bit < 6)).toBe(true);
      expect(await readFile(asset.sourcePath)).toHaveLength(asset.fingerprint.size);
    }
  });

  it('CPU and native 65³ LUT match every control and a combined grade numerically', async () => {
    const controls: ColourSettings[] = [
      { ...NEUTRAL_COLOUR },
      { ...NEUTRAL_COLOUR, exposure: 0.75 },
      { ...NEUTRAL_COLOUR, brightness: 0.04 },
      { ...NEUTRAL_COLOUR, contrast: 1.25 },
      { ...NEUTRAL_COLOUR, hue: 31 },
      { ...NEUTRAL_COLOUR, saturation: 1.3 },
      { ...NEUTRAL_COLOUR, highlights: -0.4 },
      { ...NEUTRAL_COLOUR, shadows: 0.3 },
      { exposure: 0.6, brightness: 0.02, contrast: 1.1, hue: 12, saturation: 1.2, highlights: -0.2, shadows: 0.15 },
    ];
    const pixels = Buffer.alloc(17 * 17 * 3);
    for (let index = 0; index < 17 * 17; index++) {
      pixels[index * 3] = (index * 73) % 256;
      pixels[index * 3 + 1] = (index * 157) % 256;
      pixels[index * 3 + 2] = (index * 29) % 256;
    }
    await writeFile(path.join(directory, 'pixels.rgb'), pixels);
    for (const settings of controls) {
      await writeFile(path.join(directory, 'grade.cube'), generateCube(settings));
      const result = await runProcess(
        config.ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'rawvideo',
          '-pixel_format',
          'rgb24',
          '-video_size',
          '17x17',
          '-i',
          'pixels.rgb',
          '-frames:v',
          '1',
          '-vf',
          'format=gbrpf32le,lut3d=file=grade.cube:interp=tetrahedral,format=rgb24',
          '-threads',
          '2',
          '-filter_threads',
          '2',
          '-f',
          'rawvideo',
          'pipe:1',
        ],
        { cwd: directory },
      );
      let total = 0;
      let max = 0;
      for (let index = 0; index < 17 * 17; index++) {
        const expected = gradePixel(
          [pixels[index * 3]! / 255, pixels[index * 3 + 1]! / 255, pixels[index * 3 + 2]! / 255],
          settings,
        );
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(result[index * 3 + channel]! - expected[channel]! * 255);
          total += error;
          max = Math.max(max, error);
        }
      }
      console.log(
        `Native LUT parity ${JSON.stringify(settings)}: MAE ${(total / pixels.length).toFixed(3)}, max ${max.toFixed(3)} / 255`,
      );
      expect(total / pixels.length).toBeLessThan(0.65);
      expect(max).toBeLessThan(6);
    }
  });

  for (const type of ['cut', 'fade-through-black', 'cross-dissolve'] as const) {
    it(`renders ${type} with exact frame count, colour, and true black edge fades`, async () => {
      let document = applyCommand(fixture.document, {
        type: 'transition',
        transition:
          type === 'cut'
            ? { leftId: 'clip-a', rightId: 'clip-b', type, duration: 0 }
            : { leftId: 'clip-a', rightId: 'clip-b', type, duration: 18 },
      });
      document = applyCommand(document, {
        type: 'colour',
        clipId: 'clip-a',
        colour: { ...NEUTRAL_COLOUR, brightness: 0.05, shadows: 0.1 },
      });
      document = applyCommand(document, { type: 'fades', layerId: document.layers[0]!.id, opening: 6, closing: 6 });
      const job = startReference(document, fixture.library);
      const result = await fixture.jobs.wait(job.id);
      expect(result.state, result.message).toBe('completed');
      const filename = path.join(directory, 'renders', job.id, 'reference.mp4');
      const duration = calculateLayout(document).duration;
      const receipt = JSON.parse(await readFile(path.join(directory, 'renders', job.id, 'receipt.json'), 'utf8'));
      expect(receipt.verification.frameCount).toBe(duration);
      expect(receipt.verification.colourSpace).toBe('bt709');
      for (const frame of [0, duration - 1, ...(type === 'fade-through-black' ? [89, 90] : [])]) {
        const pixels = await extractComparisonFrame(config, filename, frame, 'tv');
        expect(pixels.reduce((total, pixel) => total + pixel, 0) / pixels.length).toBeLessThan(1);
      }
      // Numeric agreement at the fade curve/dissolve midpoint, not just duration or screenshots.
      for (const frame of [2, 30, ...(type === 'cross-dissolve' ? [81] : [86, 88, 91, 93])]) {
        const layers = sampleTimeline(document, frame);
        const expected = new Float64Array(160 * 90 * 3);
        for (const layer of layers) {
          const source = fixture.library.get(layer.mediaId);
          const pixels = await extractComparisonFrame(
            config,
            source.sourcePath,
            layer.sourceFrame,
            source.metadata.colourRange,
          );
          for (let index = 0; index < pixels.length; index += 3) {
            const graded = gradePixel(
              [pixels[index]! / 255, pixels[index + 1]! / 255, pixels[index + 2]! / 255],
              layer.colour,
            );
            for (let channel = 0; channel < 3; channel++)
              expected[index + channel]! += graded[channel]! * 255 * layer.weight;
          }
        }
        const actual = await extractComparisonFrame(config, filename, frame, 'tv');
        const error = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]!), 0) / actual.length;
        console.log(`${type}, frame ${frame}: native/shared-model MAE ${error.toFixed(3)} / 255`);
        expect(error).toBeLessThan(4);
      }
    });
  }
});
