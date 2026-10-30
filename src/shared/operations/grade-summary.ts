import { z } from 'zod';
import {
  colorCurveSchema,
  CURVE_CHANNELS,
  HSL_BANDS,
  hslBandSchema,
  isIdentityCurve,
  type ColorCurvePoint,
  type CurveChannel,
  type HslBand,
} from '../advanced-color.js';
import { NEUTRAL_COLOR, scalarColorValues, type ColorSettings, type ScalarColorSetting } from '../color.js';
import { described } from '../described.js';
import { gradeSettingSchema } from '../grade.js';

/** A clip grade or an adjustment as the reads report it: only what differs from neutral. */
export const gradeSummarySchema = z
  .object({
    settings: described(
      z.partialRecord(gradeSettingSchema, z.number()),
      'Scalar Color settings that differ from neutral; the others are neutral.',
    ),
    hsl: described(
      z.partialRecord(z.enum(HSL_BANDS), hslBandSchema).optional(),
      'HSL ranges that differ from neutral.',
    ),
    curves: described(
      z.partialRecord(z.enum(CURVE_CHANNELS), colorCurveSchema).optional(),
      'Curves that differ from identity, with their control nodes.',
    ),
    keyframes: described(
      z.number().int().nonnegative(),
      'Its keyframes, which override the settings they key; describe_track lists them with include keyframes.',
    ),
  })
  .strict();
export type GradeSummary = z.infer<typeof gradeSummarySchema>;

export function gradeSummary(grade: { color: ColorSettings; keyframes: readonly unknown[] }): GradeSummary {
  const { color } = grade;
  const settings = Object.fromEntries(
    Object.entries(scalarColorValues(color)).filter(
      ([setting, value]) => value !== NEUTRAL_COLOR[setting as ScalarColorSetting],
    ),
  );
  const hsl = Object.fromEntries(
    HSL_BANDS.filter((band) => Object.values(color.hsl[band]).some((value) => value !== 0)).map((band) => [
      band,
      color.hsl[band],
    ]),
  ) as Partial<Record<HslBand, ColorSettings['hsl'][HslBand]>>;
  const curves = Object.fromEntries(
    CURVE_CHANNELS.filter((channel) => !isIdentityCurve(color.curves[channel])).map((channel) => [
      channel,
      color.curves[channel],
    ]),
  ) as Partial<Record<CurveChannel, ColorCurvePoint[]>>;
  return {
    settings,
    ...(Object.keys(hsl).length > 0 && { hsl }),
    ...(Object.keys(curves).length > 0 && { curves }),
    keyframes: grade.keyframes.length,
  };
}
