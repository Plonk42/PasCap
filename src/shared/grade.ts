import { z } from 'zod';
import {
  COLOR_CONTROLS,
  colorSchema,
  compileGradeInto,
  createColorSettings,
  isNeutralAdvancedColor,
  isNeutralColor,
  isNeutralLocalTone,
  isNeutralScalarColor,
  LOCAL_TONE_SETTINGS,
  type ColorSettings,
  type PixelGrade,
  type RGB,
  type ScalarColorSetting,
} from './color.js';
import { described } from './described.js';
import type { LocalTone } from './detail.js';
import {
  EASING_MISMATCH,
  easingMatchesValues,
  easingSchema,
  evaluateLayerSetting,
  layerKeyValuesSchema,
  orderedKeys,
  type Interpolation,
  type LayerKeyframe,
} from './keyframes.js';

/** Keyframes of one clip grade; see docs/design/CLIP_GRADES_AND_ADJUSTMENTS.md. */
export const MAX_GRADE_KEYFRAMES = 64;
export const GRADE_SETTINGS: readonly ScalarColorSetting[] = COLOR_CONTROLS.map(({ key }) => key);
export const gradeSettingSchema = z.enum(GRADE_SETTINGS as [ScalarColorSetting, ...ScalarColorSetting[]]);

const gradeKeyValuesSchema = layerKeyValuesSchema.omit({ opacity: true });
export type GradeKeyValues = z.infer<typeof gradeKeyValuesSchema>;
/** Some settings of a clip grade keyframe: a value keys the setting, null disables it, absent keeps it. */
export const gradeKeyValuesPatchSchema = gradeKeyValuesSchema
  .partial()
  .refine((values) => Object.values(values).some((value) => value !== undefined), {
    message: 'List at least one setting.',
  });

function gradeKeyframeSchemaFor(frame: z.ZodNumber, empty: string) {
  return z
    .object({
      frame,
      values: described(
        gradeKeyValuesSchema,
        'The value of each Color setting keyed here, or null for a setting not keyed here; at least one is a number.',
      ),
      easing: described(easingSchema(GRADE_SETTINGS), 'The Easing of each keyed setting toward its next keyframe.'),
      reset: described(
        z.boolean(),
        'True for a default keyframe: its values hold from its frame on and never reach back to earlier frames.',
      ),
    })
    .strict()
    .refine((key) => Object.values(key.values).some((value) => value !== null), { message: empty })
    .refine(easingMatchesValues, { message: EASING_MISMATCH });
}

export const gradeKeyframeSchema = gradeKeyframeSchemaFor(
  described(
    z.number().int().nonnegative().max(2_147_483_647),
    "Source frame of the clip's recording; it may lie outside the clip's range, up to the recording's frame count.",
  ),
  'A clip grade keyframe must have at least one enabled setting.',
);
export type GradeKeyframe = z.infer<typeof gradeKeyframeSchema>;

export const clipGradeSchema = z
  .object({
    color: described(
      colorSchema,
      'Color of the clip: twelve scalar settings, hdr, localContrast, hsl and curves. Keyed settings follow their keyframes.',
    ),
    keyframes: described(
      z
        .array(gradeKeyframeSchema)
        .max(MAX_GRADE_KEYFRAMES)
        .refine(orderedKeys, { message: 'Clip grade keyframes must have unique ascending source frames.' }),
      `Keyframes at unique ascending source frames of the recording, at most ${MAX_GRADE_KEYFRAMES}; they follow the footage through trims, moves and speed changes.`,
    ),
  })
  .strict();
export type ClipGrade = z.infer<typeof clipGradeSchema>;

export function createClipGrade(): ClipGrade {
  return { color: createColorSettings(), keyframes: [] };
}

/** Adjustment items of a project; see docs/design/CLIP_GRADES_AND_ADJUSTMENTS.md. */
export const MAX_ADJUSTMENTS = 1024;
const LAST_FRAME = 2_147_483_647;

export const adjustmentSchema = z
  .object({
    id: described(
      z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      'Unique adjustment ID: letters, digits, "_" and "-", at most 100.',
    ),
    start: described(z.number().int().nonnegative().max(LAST_FRAME), 'Project frame of its first graded frame.'),
    duration: described(
      z.number().int().positive().max(LAST_FRAME),
      'Frames it grades from its start; it never extends the project.',
    ),
    color: described(
      colorSchema,
      'Color of every video track within its range: twelve scalar settings, hdr, localContrast, hsl and curves.',
    ),
    keyframes: described(
      z
        .array(
          gradeKeyframeSchemaFor(
            described(
              z.number().int().nonnegative().max(LAST_FRAME),
              'Frame counted from the adjustment start (0 is its first frame), within its duration; make the adjustment longer first to key later frames.',
            ),
            'An adjustment keyframe must have at least one enabled setting.',
          ),
        )
        .max(MAX_GRADE_KEYFRAMES)
        .refine(orderedKeys, { message: 'Adjustment keyframes must have unique ascending frames.' }),
      `Keyframes at unique ascending frames counted from its start, at most ${MAX_GRADE_KEYFRAMES}; they move with it.`,
    ),
  })
  .strict()
  .refine((item) => item.start + item.duration <= LAST_FRAME, {
    message: 'Adjustment OUT exceeds the supported integer project-frame range.',
  })
  .refine((item) => item.keyframes.every((key) => key.frame < item.duration), {
    message: 'Adjustment keyframes must lie within the adjustment.',
  });
export type Adjustment = z.infer<typeof adjustmentSchema>;

/** In timeline order, never overlapping, with unique IDs. */
export const adjustmentsSchema = z
  .array(adjustmentSchema)
  .max(MAX_ADJUSTMENTS)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
    message: 'Adjustment IDs must be unique.',
  })
  .refine(
    (items) =>
      items.every((item, index) => index === 0 || item.start >= items[index - 1]!.start + items[index - 1]!.duration),
    { message: 'Adjustments must be in timeline order and must not overlap.' },
  );

export function createAdjustment(id: string, start: number, duration: number): Adjustment {
  return adjustmentSchema.parse({ id, start, duration, color: createColorSettings(), keyframes: [] });
}

/** The adjustment grading a project frame, if any. */
export function adjustmentAt(items: readonly Adjustment[], frame: number): Adjustment | undefined {
  return items.find((item) => frame >= item.start && frame < item.start + item.duration);
}

/** An adjustment's Color at a project frame; its keyframes count from its start. */
export function adjustmentColorAt(item: Adjustment, frame: number): ColorSettings {
  return gradeColorAt(item, frame - item.start);
}

/** The Color of a grade at a frame of its keyframes: a source frame of a clip, a frame of an adjustment. */
export function gradeColorAt(grade: Pick<ClipGrade, 'color' | 'keyframes'>, sourceFrame: number): ColorSettings {
  const color = { ...grade.color };
  for (const setting of GRADE_SETTINGS)
    color[setting] = evaluateLayerSetting(grade, setting, sourceFrame, grade.color[setting]);
  return color;
}

/** A clip grade keyframe in the track keyframe shape, so track keyframe tools can show and edit it. */
export function gradeKeyAsLayerKey(key: GradeKeyframe): LayerKeyframe {
  return { ...key, values: { opacity: null, ...key.values }, easing: { opacity: null, ...key.easing } };
}
export function layerKeyAsGradeKey(key: LayerKeyframe): GradeKeyframe {
  const { opacity: _value, ...values } = key.values;
  const { opacity: _easing, ...easing } = key.easing;
  return {
    frame: key.frame,
    values,
    easing: easing as Record<ScalarColorSetting, Interpolation | null>,
    reset: key.reset,
  };
}

/** A grade with no effect at any frame. */
export function isNeutralClipGrade(grade: Pick<ClipGrade, 'color' | 'keyframes'>): boolean {
  return grade.keyframes.length === 0 && isNeutralColor(grade.color);
}

/** Whether any frame of the clip can evaluate a nonzero Shadows, Highlights, HDR or Local contrast. */
export function gradeUsesLocalTone(grade: Pick<ClipGrade, 'color' | 'keyframes'>): boolean {
  return LOCAL_TONE_SETTINGS.some(
    (setting) => grade.color[setting] !== 0 || grade.keyframes.some((key) => (key.values[setting] ?? 0) !== 0),
  );
}

/** A grade the static export can bake into each clip's LUT: unkeyed, scalar-only and without local tone. */
export function isStaticClipGrade(grade: ClipGrade): boolean {
  return grade.keyframes.length === 0 && isNeutralLocalTone(grade.color) && isNeutralAdvancedColor(grade.color);
}

/** A grade stage that changes encoded pixels; local tone runs in the detail kernel instead. */
export function gradesPixels(color: ColorSettings): boolean {
  return !isNeutralScalarColor(color) || !isNeutralAdvancedColor(color);
}

/** What one source's grades do, in order: the clip grade, then the adjustment at that frame. */
export interface SourceGrades {
  /** The grades that change pixels, applied one after another to the encoded output of the previous one. */
  stages: ColorSettings[];
  /** Local tone of both grades, summed and clamped, selecting tones after their summed Exposure. */
  tone: LocalTone;
}

const clampTo = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export function sourceGrades(clip: ColorSettings, track: ColorSettings): SourceGrades {
  return {
    stages: [clip, track].filter(gradesPixels),
    tone: {
      shadows: clampTo(clip.shadows + track.shadows, -1, 1),
      highlights: clampTo(clip.highlights + track.highlights, -1, 1),
      hdr: clampTo(clip.hdr + track.hdr, 0, 1),
      localContrast: clampTo(clip.localContrast + track.localContrast, -1, 1),
      exposure: clip.exposure + track.exposure,
    },
  };
}

/** The local tone of one owner reads as neutral when its settings are 0. */
export function isNeutralTone(tone: LocalTone): boolean {
  return tone.shadows === 0 && tone.highlights === 0 && tone.hdr === 0 && tone.localContrast === 0;
}

/** Grades applied one after another, each on the previous one's encoded output. */
export function compileGradeChain(stages: readonly ColorSettings[]): PixelGrade {
  if (stages.length <= 1) return compileGradeInto(stages[0] ?? createColorSettings());
  const [first, ...rest] = stages.map(compileGradeInto);
  return {
    encoded(rgb) {
      first!.encoded(rgb);
      for (const stage of rest) stage.encoded(rgb);
    },
    bytes(red, green, blue, out) {
      first!.bytes(red, green, blue, out);
      for (const stage of rest) stage.encoded(out);
    },
  };
}

export function gradeChainPixel(rgb: RGB, stages: readonly ColorSettings[]): RGB {
  if (!stages.length) return rgb;
  const triple = Float64Array.from(rgb);
  compileGradeChain(stages).encoded(triple);
  return [triple[0]!, triple[1]!, triple[2]!];
}
