import { describe, expect, it } from 'vitest';
import { ColourLutCache } from '../../src/server/layered-colour.js';
import { composeLayerFrame } from '../../src/server/layered-frame.js';
import {
  createColourSettings,
  generateCube,
  gradePixel,
  NEUTRAL_COLOUR,
  type ColourSettings,
  type RGB,
} from '../../src/shared/colour.js';
import { compositePixel } from '../../src/shared/composition.js';
import { NEUTRAL_DETAIL } from '../../src/shared/detail.js';
import { needsLayeredExport } from '../../src/shared/export.js';
import { applyCommand } from '../../src/shared/commands.js';
import {
  clipGradeSchema,
  compileGradeChain,
  createClipGrade,
  gradeChainPixel,
  gradeColourAt,
  gradeKeyAsLayerKey,
  layerKeyAsGradeKey,
  MAX_GRADE_KEYFRAMES,
  sourceGrades,
} from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { validateSourceRanges } from '../../src/shared/source-range.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { sampleTimeline, type PreviewLayer } from '../../src/shared/timeline.js';

const gradeKey = (frame: number, values: Partial<typeof EMPTY_KEY_VALUES>, curve: 'linear' | 'hold' = 'linear') =>
  layerKeyAsGradeKey(layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, curve));

function project(): ProjectDocument {
  const document = createProject('grades', 'Grades');
  return projectSchema.parse({
    ...document,
    media: { videoIds: ['rec'], audioIds: [] },
    layers: [
      { ...document.layers[0]!, transitions: [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }] },
      createLayer('video-2', 'Track 2'),
    ],
    clips: [{ ...createClip('a', 'rec', 0, 60), start: 0 }, { ...createClip('b', 'rec', 100, 160) }],
  });
}

describe('clip grade data', () => {
  it('gives every new clip a neutral grade with no keyframes', () => {
    expect(createClip('c', 'rec', 0, 10).grade).toEqual({ colour: NEUTRAL_COLOUR, keyframes: [] });
    expect(createClipGrade()).toEqual(createClipGrade());
    expect(createClipGrade().colour).not.toBe(createClipGrade().colour);
  });

  it('rejects Opacity, unordered keyframes and more than 64 keyframes', () => {
    const key = gradeKey(5, { exposure: 1 });
    expect(clipGradeSchema.safeParse({ ...createClipGrade(), keyframes: [key] }).success).toBe(true);
    expect(
      clipGradeSchema.safeParse({
        ...createClipGrade(),
        keyframes: [{ ...key, values: { ...key.values, opacity: 1 } }],
      }).success,
    ).toBe(false);
    expect(
      clipGradeSchema.safeParse({ ...createClipGrade(), keyframes: [key, gradeKey(2, { tint: 0.1 })] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_GRADE_KEYFRAMES + 1 }, (_, frame) => gradeKey(frame, { exposure: 0.1 }));
    expect(clipGradeSchema.safeParse({ ...createClipGrade(), keyframes: many }).success).toBe(false);
    expect(gradeKeyAsLayerKey(key).values.opacity).toBeNull();
    expect(layerKeyAsGradeKey(gradeKeyAsLayerKey(key))).toEqual(key);
  });

  it('evaluates keyframes at source frames, holding endpoints, with a default keyframe never reaching back', () => {
    const grade = {
      colour: { ...createColourSettings(), exposure: 0.5, contrast: 1.2 },
      keyframes: [gradeKey(10, { exposure: 0 }), gradeKey(30, { exposure: 1 })],
    };
    expect(gradeColourAt(grade, 0).exposure).toBe(0);
    expect(gradeColourAt(grade, 20).exposure).toBeCloseTo(0.5);
    expect(gradeColourAt(grade, 40).exposure).toBe(1);
    expect(gradeColourAt(grade, 20).contrast).toBe(1.2);
    const reset = layerKeyAsGradeKey({
      ...layerKeyframe(10, { ...EMPTY_KEY_VALUES, contrast: 1 }, 'hold'),
      reset: true,
    });
    expect(gradeColourAt({ ...grade, keyframes: [reset] }, 5).contrast).toBe(1.2);
    expect(gradeColourAt({ ...grade, keyframes: [reset] }, 10).contrast).toBe(1);
  });

  it('refuses grade keyframes beyond the recording', () => {
    const document = project();
    document.clips[0]!.grade.keyframes = [gradeKey(200, { exposure: 1 })];
    expect(() => validateSourceRanges(document, new Map([['rec', 200]]))).not.toThrow();
    expect(() => validateSourceRanges(document, new Map([['rec', 199]]))).toThrow('Clip grade keyframes exceed');
  });
});

describe('source grades', () => {
  const clip = { ...createColourSettings(), exposure: 0.4, shadows: 0.6, hdr: 0.7, localContrast: -0.3 };
  const track = { ...createColourSettings(), saturation: 1.3, shadows: 0.7, hdr: 0.5, exposure: -0.1 };

  it('applies only the grades that change pixels, clip first, and sums local tone within its bounds', () => {
    expect(sourceGrades(NEUTRAL_COLOUR, NEUTRAL_COLOUR).stages).toEqual([]);
    expect(sourceGrades(clip, NEUTRAL_COLOUR).stages).toEqual([clip]);
    expect(sourceGrades(NEUTRAL_COLOUR, track).stages).toEqual([track]);
    expect(sourceGrades(clip, track).stages).toEqual([clip, track]);
    // Local tone alone grades no pixels: it runs in the detail kernel.
    expect(sourceGrades({ ...createColourSettings(), hdr: 0.5 }, NEUTRAL_COLOUR).stages).toEqual([]);
    expect(sourceGrades(clip, track).tone).toEqual({
      shadows: 1,
      highlights: 0,
      hdr: 1,
      localContrast: -0.3,
      exposure: 0.4 - 0.1,
    });
    expect(sourceGrades(NEUTRAL_COLOUR, track).tone).toEqual({
      shadows: 0.7,
      highlights: 0,
      hdr: 0.5,
      localContrast: 0,
      exposure: -0.1,
    });
  });

  it('chains grades on encoded output, exactly like grading twice', () => {
    const second = { ...createColourSettings(), contrast: 1.4, hue: 20 };
    for (const rgb of [
      [0, 0, 0],
      [0.2, 0.5, 0.9],
      [1, 0.8, 0.1],
    ] as RGB[]) {
      expect(gradeChainPixel(rgb, [clip, second])).toEqual(gradePixel(gradePixel(rgb, clip), second));
      expect(gradeChainPixel(rgb, [])).toEqual(rgb);
      const out = new Float64Array(3);
      compileGradeChain([clip, second]).bytes(
        Math.round(rgb[0] * 255),
        Math.round(rgb[1] * 255),
        Math.round(rgb[2] * 255),
        out,
      );
      const expected = gradePixel(
        gradePixel(
          [Math.round(rgb[0] * 255) / 255, Math.round(rgb[1] * 255) / 255, Math.round(rgb[2] * 255) / 255],
          clip,
        ),
        second,
      );
      for (let channel = 0; channel < 3; channel++) expect(out[channel]).toBeCloseTo(expected[channel]!, 12);
    }
  });

  it('samples the clip grade at the source frame shown, reversed too', () => {
    const document = project();
    document.clips[0]!.grade.keyframes = [gradeKey(0, { exposure: 0 }), gradeKey(59, { exposure: 1 })];
    document.clips[0]!.reverse = true;
    const [first] = sampleTimeline(document, 0);
    expect(first!.sourceFrame).toBe(59);
    expect(first!.grade.exposure).toBe(1);
    expect(first!.colour).toEqual(NEUTRAL_COLOUR);
  });
});

describe('clip grade commands', () => {
  it('sets Colour on a track, or on clips keeping their keyframes', () => {
    const colour = { ...createColourSettings(), exposure: 0.3 };
    const keyed = applyCommand(project(), {
      type: 'layer-key-set',
      clipId: 'a',
      frame: 4,
      values: { tint: 0.2 },
    });
    const next = applyCommand(keyed, { type: 'colour', clipIds: ['a', 'b'], colour });
    expect(next.clips.map((clip) => clip.grade.colour.exposure)).toEqual([0.3, 0.3]);
    expect(next.clips[0]!.grade.keyframes).toHaveLength(1);
    expect(next.layers[0]!.colour).toEqual(NEUTRAL_COLOUR);
    expect(() => applyCommand(keyed, { type: 'colour', clipIds: ['a', 'a'], colour })).toThrow('each clip once');
    expect(() => applyCommand(keyed, { type: 'colour', clipIds: ['gone'], colour })).toThrow('gone no longer exists');
    expect(() => applyCommand(keyed, { type: 'colour', colour })).toThrow('Give either layerId');
    expect(() => applyCommand(keyed, { type: 'colour', layerId: 'video-1', clipIds: ['a'], colour })).toThrow(
      'Give either layerId',
    );
  });

  it('keys clip settings at source frames, never Opacity, within 64 keyframes', () => {
    let next = applyCommand(project(), {
      type: 'layer-key-toggle',
      clipId: 'b',
      frame: 120,
      setting: 'exposure',
      value: 1,
    });
    expect(next.clips[1]!.grade.keyframes).toEqual([gradeKey(120, { exposure: 1 })]);
    expect(next.layers[0]!.keyframes).toEqual([]);
    expect(() => applyCommand(next, { type: 'colour-setting', clipId: 'b', setting: 'exposure', value: 0 })).toThrow(
      'follows 1 clip keyframe on clip b',
    );
    next = applyCommand(next, { type: 'colour-setting', clipId: 'b', setting: 'contrast', value: 1.5 });
    expect(next.clips[1]!.grade.colour.contrast).toBe(1.5);
    expect(() =>
      applyCommand(next, { type: 'layer-key-toggle', clipId: 'b', frame: 120, setting: 'opacity', value: 0.5 }),
    ).toThrow('Opacity belongs to the track');
    next = applyCommand(next, { type: 'layer-key-move', clipId: 'b', frame: 120, nextFrame: 130 });
    next = applyCommand(next, {
      type: 'layer-key-easing',
      clipId: 'b',
      frame: 130,
      setting: null,
      interpolation: 'hold',
    });
    expect(next.clips[1]!.grade.keyframes).toEqual([gradeKey(130, { exposure: 1 }, 'hold')]);
    next = applyCommand(next, { type: 'layer-key-default', clipId: 'b', frame: 150 });
    expect(next.clips[1]!.grade.keyframes[1]).toMatchObject({ frame: 150, reset: true, values: { exposure: 0 } });
    next = applyCommand(next, { type: 'layer-key-remove', clipId: 'b', frame: 130 });
    expect(next.clips[1]!.grade.keyframes.map((key) => key.frame)).toEqual([150]);
    let full = project();
    for (let frame = 0; frame < MAX_GRADE_KEYFRAMES; frame++)
      full = applyCommand(full, { type: 'layer-key-set', clipId: 'a', frame, values: { tint: 0.01 } });
    expect(() => applyCommand(full, { type: 'layer-key-set', clipId: 'a', frame: 64, values: { tint: 0.01 } })).toThrow(
      'This clip already has 64 keyframes',
    );
    expect(() =>
      applyCommand(full, { type: 'layer-key-toggle', clipId: 'a', frame: 64, setting: 'tint', value: 0.01 }),
    ).toThrow('This clip already has 64 keyframes');
  });

  it('changes HSL ranges and curves of a clip grade', () => {
    let next = applyCommand(project(), {
      type: 'hsl-band',
      clipId: 'a',
      band: 'blue',
      values: { hue: 5, saturation: 0.1, lightness: 0 },
    });
    next = applyCommand(next, {
      type: 'colour-curve',
      clipId: 'a',
      channel: 'master',
      points: [
        { x: 0, y: 0.05 },
        { x: 1, y: 1 },
      ],
    });
    expect(next.clips[0]!.grade.colour.hsl.blue).toEqual({ hue: 5, saturation: 0.1, lightness: 0 });
    expect(next.clips[0]!.grade.colour.curves.master).toHaveLength(2);
    expect(next.layers[0]!.colour).toEqual(NEUTRAL_COLOUR);
  });

  it('keeps the grade with the footage through trims, moves, splits and duplicates', () => {
    let next = applyCommand(project(), { type: 'colour-setting', clipId: 'a', setting: 'exposure', value: 0.5 });
    next = applyCommand(next, { type: 'layer-key-set', clipId: 'a', frame: 40, values: { tint: 0.3 } });
    const grade = next.clips[0]!.grade;
    next = applyCommand(next, { type: 'trim', clipId: 'a', sourceIn: 10, sourceOut: 50 });
    expect(next.clips[0]!.grade).toEqual(grade);
    next = applyCommand(next, { type: 'split', clipId: 'a', sourceFrame: 30, newClipId: 'a2' });
    expect(next.clips.find((clip) => clip.id === 'a2')!.grade).toEqual(grade);
    next = applyCommand(next, { type: 'duplicate', clipId: 'a2', newClipId: 'a3' });
    expect(next.clips.find((clip) => clip.id === 'a3')!.grade).toEqual(grade);
    next = applyCommand(next, { type: 'place', clipId: 'a', layerId: 'video-2', start: 500, index: 0 });
    expect(next.clips.find((clip) => clip.id === 'a')!.grade).toEqual(grade);
  });
});

describe('clip grades in composited export', () => {
  const target = { width: 8, height: 4 };
  const pixels = target.width * target.height;
  const bounds = { x: 0, y: 0, ...target };
  const sample = (id: string, grade: ColourSettings, colour: ColourSettings, blendWeight: number): PreviewLayer => ({
    clipId: id,
    mediaId: id,
    layerId: 'video-1',
    sourceFrame: 3,
    sourcePosition: 3,
    spatial: { ...NEUTRAL_SPATIAL_POSE },
    detail: { ...NEUTRAL_DETAIL },
    grade,
    colour,
    weight: blendWeight,
    blendWeight,
    brightness: 1,
    opacity: 1,
  });
  const frame = (seed: number): Buffer => {
    const rgb = Buffer.alloc(pixels * 3);
    for (let pixel = 0; pixel < pixels; pixel++) {
      rgb[pixel * 3] = (pixel * 73 + seed * 41) % 256;
      rgb[pixel * 3 + 1] = (pixel * 157 + seed * 23) % 256;
      rgb[pixel * 3 + 2] = (pixel * 29 + seed * 61) % 256;
    }
    return rgb;
  };
  const track = { ...createColourSettings(), contrast: 1.3, saturation: 1.2 };
  const warm = { ...createColourSettings(), temperature: 0.6, exposure: 0.3 };
  const ranged = {
    ...createColourSettings(),
    exposure: -0.2,
    hsl: { ...createColourSettings().hsl, red: { hue: 12, saturation: 0.3, lightness: 0.05 } },
  };

  for (const [name, left, right] of [
    ['scalar clip grades through one LUT each', warm, createColourSettings()],
    ['an HSL clip grade exactly', ranged, warm],
  ] as const)
    it(`grades each dissolve source by its clip, then its track: ${name}`, async () => {
      const buffer = Buffer.alloc(pixels * 8);
      const samples = [sample('left', left, track, 0.4), sample('right', right, track, 0.6)];
      const input = new Map(samples.map((current, index) => [current.clipId, frame(index)]));
      await composeLayerFrame(
        buffer,
        target,
        samples.map((current) => ({ sample: current, rgb: input.get(current.clipId)!, bounds, original: target })),
        new ColourLutCache(),
        new AbortController().signal,
      );
      const output = new Uint16Array(buffer.buffer, buffer.byteOffset, pixels * 4);
      let error = 0;
      for (let pixel = 0; pixel < pixels; pixel++) {
        const expected = compositePixel(samples, (current) => {
          const rgb = input.get(current.clipId)!;
          return [rgb[pixel * 3]! / 255, rgb[pixel * 3 + 1]! / 255, rgb[pixel * 3 + 2]! / 255];
        });
        for (let channel = 0; channel < 3; channel++)
          error += Math.abs(output[pixel * 4 + channel]! / 65535 - expected[channel]!) * 255;
      }
      expect(error / (pixels * 3)).toBeLessThan(name.startsWith('an HSL') ? 0.05 : 1);
      // The clip grade really changes the picture.
      const trackOnly = compositePixel([{ ...samples[0]!, grade: createColourSettings() }], () => [0.5, 0.3, 0.2]);
      expect(compositePixel([samples[0]!], () => [0.5, 0.3, 0.2])).not.toEqual(trackOnly);
    });

  it('bakes unkeyed scalar clip grades into the static export, and sends the rest to composited export', () => {
    const document = project();
    document.layers = [{ ...document.layers[0]!, transitions: [] }];
    document.clips = [document.clips[0]!];
    expect(needsLayeredExport(document)).toBe(false);
    document.clips[0]!.grade.colour = warm;
    expect(needsLayeredExport(document)).toBe(false);
    expect(
      needsLayeredExport({ ...document, clips: [{ ...document.clips[0]!, grade: { colour: ranged, keyframes: [] } }] }),
    ).toBe(true);
    expect(
      needsLayeredExport({
        ...document,
        clips: [{ ...document.clips[0]!, grade: { colour: { ...warm, hdr: 0.2 }, keyframes: [] } }],
      }),
    ).toBe(true);
    expect(
      needsLayeredExport({
        ...document,
        clips: [{ ...document.clips[0]!, grade: { colour: warm, keyframes: [gradeKey(4, { tint: 0.1 })] } }],
      }),
    ).toBe(true);
    const cube = generateCube([warm, track], 3).split('\n');
    expect(cube.at(-2)).toBe(
      gradePixel(gradePixel([1, 1, 1], warm), track)
        .map((value) => value.toFixed(9))
        .join(' '),
    );
  });
});
