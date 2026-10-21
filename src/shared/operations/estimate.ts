import { z } from 'zod';
import { AUTO_ADJUST, AUTO_ADJUST_SETTINGS } from '../auto-adjust.js';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { detailSchema } from '../detail.js';
import { frameSchema, idSchema } from '../model.js';
import { defineOperation } from './spec.js';

export const estimateKinds = ['auto-adjust', 'white-balance', 'detail'] as const;

const balanced = Math.round(AUTO_ADJUST.balancedIntensity * 100);

export const estimate = defineOperation({
  name: 'estimate',
  description: `Measure footage the way the editor's automatic tools do, from proxy frames, and return the values with the edit commands that apply them (pass them to edit; nothing changes until then). kind auto-adjust is Track → Colour → Auto: eleven Colour settings balancing exposure, contrast, white balance and colour. white-balance is Auto white balance: Temperature and Tint. detail measures noise and softness and suggests the clip's Denoise and Sharpen (never Clarity, a look). Analyse a clip (clipId: the whole clip, or with frame the second around that project frame, as at the playhead), a whole track (layerId: all its clips by duration; not for detail) or a recording range (mediaId, sourceIn, sourceOut: values only, no commands). Judge the result with a still.`,
  input: z
    .object({
      projectId: described(idSchema, 'ID of the saved project.'),
      kind: described(z.enum(estimateKinds), 'What to estimate.'),
      clipId: described(idSchema.optional(), 'Analyse this clip.'),
      frame: described(
        frameSchema.optional(),
        'With clipId: analyse the project frames within 1 s of this one, inside the clip, instead of the whole clip.',
      ),
      layerId: described(idSchema.optional(), 'Analyse every clip of this video track instead.'),
      mediaId: described(
        idSchema.optional(),
        'Analyse a range of this video recording instead, with sourceIn and sourceOut.',
      ),
      sourceIn: described(frameSchema.optional(), 'First source frame of the recording range.'),
      sourceOut: described(frameSchema.optional(), 'Source frame after the recording range (exclusive).'),
      applyAs: described(
        z.enum(['values', 'keyframe']).default('values'),
        "Colour kinds: values replaces the track's values (leaving animated settings unchanged); keyframe keys the settings at frame, which needs clipId and frame.",
      ),
      intensity: described(
        z.number().min(0).max(100).default(balanced),
        `auto-adjust: strength of the correction in %; ${balanced} is the correction as fitted, 100 exaggerates it by a quarter.`,
      ),
    })
    .strict(),
  output: z
    .object({
      kind: z.enum(estimateKinds),
      analysed: described(
        z.object({ description: z.string(), frames: z.number().int().nonnegative() }).strict(),
        'What was analysed and how many proxy frames.',
      ),
      correction: described(
        z
          .object(Object.fromEntries(AUTO_ADJUST_SETTINGS.map((setting) => [setting, z.number()])))
          .strict()
          .optional(),
        'auto-adjust: the eleven Colour settings at the intensity asked.',
      ),
      whiteBalance: described(
        z.object({ temperature: z.number(), tint: z.number() }).strict().optional(),
        'white-balance: Temperature and Tint.',
      ),
      detail: described(
        z
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
          .strict()
          .optional(),
        'detail: the measurements and the suggested detail filters, measured on the proxy at the scale the filters use.',
      ),
      unchanged: described(
        z.array(z.string()),
        'Settings the track animates, which applying as values leaves unchanged; key them with applyAs keyframe instead.',
      ),
      commands: described(
        z.array(editCommandSchema),
        'Edit commands applying the result in one step: pass them to edit. Empty for a recording range or when every setting is animated.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
