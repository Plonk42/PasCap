import { z } from 'zod';
import {
  colourCurveSchema,
  CURVE_CHANNELS,
  HSL_BANDS,
  hslBandSchema,
  isIdentityCurve,
  type ColourCurvePoint,
  type CurveChannel,
  type HslBand,
} from '../advanced-colour.js';
import { NEUTRAL_COLOUR, scalarColourValues, type ColourSettings, type ScalarColourSetting } from '../colour.js';
import { described } from '../described.js';
import { gradeSettingSchema } from '../grade.js';

/** A clip grade or an adjustment as the reads report it: only what differs from neutral. */
export const gradeSummarySchema = z
  .object({
    settings: described(
      z.partialRecord(gradeSettingSchema, z.number()),
      'Scalar Colour settings that differ from neutral; the others are neutral.',
    ),
    hsl: described(
      z.partialRecord(z.enum(HSL_BANDS), hslBandSchema).optional(),
      'HSL ranges that differ from neutral.',
    ),
    curves: described(
      z.partialRecord(z.enum(CURVE_CHANNELS), colourCurveSchema).optional(),
      'Curves that differ from identity, with their control nodes.',
    ),
    keyframes: described(
      z.number().int().nonnegative(),
      'Its keyframes, which override the settings they key; describe_track lists them with include keyframes.',
    ),
  })
  .strict();
export type GradeSummary = z.infer<typeof gradeSummarySchema>;

export function gradeSummary(grade: { colour: ColourSettings; keyframes: readonly unknown[] }): GradeSummary {
  const { colour } = grade;
  const settings = Object.fromEntries(
    Object.entries(scalarColourValues(colour)).filter(
      ([setting, value]) => value !== NEUTRAL_COLOUR[setting as ScalarColourSetting],
    ),
  );
  const hsl = Object.fromEntries(
    HSL_BANDS.filter((band) => Object.values(colour.hsl[band]).some((value) => value !== 0)).map((band) => [
      band,
      colour.hsl[band],
    ]),
  ) as Partial<Record<HslBand, ColourSettings['hsl'][HslBand]>>;
  const curves = Object.fromEntries(
    CURVE_CHANNELS.filter((channel) => !isIdentityCurve(colour.curves[channel])).map((channel) => [
      channel,
      colour.curves[channel],
    ]),
  ) as Partial<Record<CurveChannel, ColourCurvePoint[]>>;
  return {
    settings,
    ...(Object.keys(hsl).length > 0 && { hsl }),
    ...(Object.keys(curves).length > 0 && { curves }),
    keyframes: grade.keyframes.length,
  };
}
