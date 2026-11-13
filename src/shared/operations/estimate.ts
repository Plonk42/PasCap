import { z } from 'zod';
import { AUTO_ADJUST, AUTO_ADJUST_SETTINGS } from '../auto-adjust.js';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { detailSchema } from '../detail.js';
import { frameSchema, idSchema } from '../model.js';
import { defineOperation, revisionReadSchema } from './spec.js';

export const estimateKinds = ['auto-adjust', 'white-balance', 'detail', 'match'] as const;
/** Clips one estimate analyzes each on its own. */
export const MAX_ESTIMATE_CLIPS = 64;

const balanced = Math.round(AUTO_ADJUST.balancedIntensity * 100);

const correctionSchema = z
  .object(Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, z.number()])))
  .strict();
const whiteBalanceSchema = z.object({ temperature: z.number(), tint: z.number() }).strict();
const detailResultSchema = z
  .object({
    noise: described(
      z.number().nullable(),
      'Noise standard deviation in the flattest areas, 0–1 luma (0.004 is about one 8-bit code); null without flat areas.',
    ),
    blur: described(
      z.number().nullable(),
      'Softness of the edges, 0 crisp to 1 very soft (a crisp edge reads about 0.1); null on uniform frames.',
    ),
    suggested: detailSchema,
  })
  .strict();

export const estimate = defineOperation({
  name: 'estimate',
  title: 'Estimate corrections',
  description: `Measure footage the way the editor's automatic tools do, from proxy frames, and return the values with the edit commands that apply them (pass them to edit; nothing changes until then). kind auto-adjust is Color → Auto: eleven Color settings balancing exposure, contrast, white balance and color. match is Color → Match: it sets the same eleven settings so a frame of the clip looks like a reference frame, a hero clip's as its grade shows it (referenceClipId and/or referenceFrame) or a recording's as shot (referenceMediaId, referenceSourceFrame), or like a registered style (style, from list_styles); the reference never changes. Frames of one scene are matched picture to picture; across scenes the clip takes the reference's light and look (likeness says which). white-balance is Auto white balance: Temperature and Tint. detail measures noise and softness and suggests the clip's Denoise and Sharpen (never Clarity, a look). Analyze a clip (clipId: the whole clip, or with frame the second around that project frame, as at the playhead; a match reads that frame, else the clip's middle frame), several clips each on its own (clipIds, up to ${MAX_ESTIMATE_CLIPS}), a whole track (layerId: each clip on its own for detail or applyAs shots; all its clips by duration for one compromise, values only with commands false) or a recording range (mediaId, sourceIn, sourceOut: values only, no commands). Commands write clip grades, applied before any adjustment; for a grade per shot use applyAs shots. Estimates and pictures render one at a time: a call waits its turn, up to a few minutes. Judge the result with a still.`,
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      kind: described(z.enum(estimateKinds), 'What to estimate.'),
      clipId: described(idSchema.optional(), 'Analyze this clip.'),
      clipIds: described(
        z.array(idSchema).min(1).max(MAX_ESTIMATE_CLIPS).optional(),
        'Analyze each of these clips on its own, whole: detail, or a Color kind with applyAs shots.',
      ),
      frame: described(
        frameSchema.optional(),
        'With clipId: analyze the project frames within 1 s of this one, inside the clip, instead of the whole clip.',
      ),
      layerId: described(idSchema.optional(), 'Analyze every clip of this video track instead.'),
      mediaId: described(
        idSchema.optional(),
        'Analyze a range of this video recording instead, with sourceIn and sourceOut.',
      ),
      sourceIn: described(frameSchema.optional(), 'First source frame of the recording range.'),
      sourceOut: described(frameSchema.optional(), 'Source frame after the recording range (exclusive).'),
      referenceClipId: described(
        idSchema.optional(),
        'match: the hero clip, measured through its grade at referenceFrame, else at its middle frame. It is never changed, and left out of layerId.',
      ),
      referenceFrame: described(
        frameSchema.optional(),
        'match: the project frame of the hero to match; without referenceClipId, the hero is the clip playing then (give referenceClipId when several tracks play one).',
      ),
      referenceMediaId: described(
        idSchema.optional(),
        'match: a prepared video recording of the project as reference instead, its frame referenceSourceFrame as shot.',
      ),
      referenceSourceFrame: described(frameSchema.optional(), 'match: the source frame of referenceMediaId.'),
      style: described(
        idSchema.optional(),
        "match: aim at this registered style (list_styles), the user's own finished look, instead of a frame: Auto's balance moved towards the style, within Auto's bounds.",
      ),
      applyAs: described(
        z.enum(['values', 'keyframe', 'shots']).default('values'),
        "Color kinds: values replaces the clip grade's values (clipId; leaving animated settings unchanged); keyframe keys the settings in the clip grade at the source frame shown at frame, which needs clipId and frame; shots writes each clip's own whole-clip correction (clipId, clipIds or every clip of layerId) into its clip grade. Clip grades apply before any adjustment and stay with the clip when it moves; a setting the grade animates follows its keyframes.",
      ),
      intensity: described(
        z.number().min(0).max(100).optional(),
        `auto-adjust: strength of the correction in %, ${balanced} by default, the correction as fitted (100 exaggerates it by a quarter). match: how far each clip moves from its grade to the match, 100 by default.`,
      ),
      commands: described(
        z.boolean().default(true),
        "False returns the values only, without the edit commands (applying as values repeats the clip grade's whole Color, HSL ranges and curves included).",
      ),
    })
    .strict(),
  output: z
    .object({
      revision: revisionReadSchema,
      kind: z.enum(estimateKinds),
      analyzed: described(
        z.object({ description: z.string(), frames: z.number().int().nonnegative() }).strict(),
        'What was analyzed and how many proxy frames.',
      ),
      reference: described(
        z
          .object({
            clipId: idSchema.optional(),
            mediaId: idSchema,
            sourceFrame: frameSchema,
          })
          .strict()
          .optional(),
        'match: the reference frame, of the hero clip or of a recording.',
      ),
      style: described(
        z.object({ id: idSchema, name: z.string() }).strict().optional(),
        'match with style: the style aimed at.',
      ),
      likeness: described(
        z.number().optional(),
        'match with a reference frame: 0 when the scenes differ (the clip takes the reference light and look) to 1 for the same scene (matched picture to picture).',
      ),
      correction: described(
        correctionSchema.optional(),
        'auto-adjust and match: the eleven Color settings at the intensity asked.',
      ),
      whiteBalance: described(whiteBalanceSchema.optional(), 'white-balance: Temperature and Tint.'),
      detail: described(
        detailResultSchema.optional(),
        'detail: the measurements and the suggested detail filters, measured on the proxy at the scale the filters use.',
      ),
      clips: described(
        z
          .array(
            z
              .object({
                clipId: described(idSchema, 'The clip.'),
                frames: described(z.number().int().nonnegative(), 'Proxy frames analyzed.'),
                correction: described(correctionSchema.optional(), 'auto-adjust and match: its correction.'),
                likeness: described(z.number().optional(), 'match with a reference frame: as the top-level likeness.'),
                whiteBalance: described(whiteBalanceSchema.optional(), 'white-balance: its Temperature and Tint.'),
                detail: described(detailResultSchema.optional(), 'detail: its measurements and suggestion.'),
              })
              .strict(),
          )
          .optional(),
        'When each clip is analyzed on its own: its result, in timeline order; the top-level values are then absent.',
      ),
      unchanged: described(
        z.array(z.string()),
        'Settings the clip grade animates, which applying as values leaves unchanged; key them with applyAs keyframe instead.',
      ),
      commands: described(
        z.array(editCommandSchema),
        'Edit commands applying the result in one step: pass them to edit. Empty for a recording range, without commands, or when every setting is animated.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
