import { z } from 'zod';
import { described } from './described.js';
import { frameSchema, idSchema, type ProjectDocument, type SelectRange } from './model.js';
import {
  FLIGHT_SPEED_RANGE,
  MAX_JOLTS,
  MOVEMENT_RANGE,
  steadyLimitFields,
  steadyLimits,
  steadyLimitsError,
  steadyLimitsFrom,
  type SteadyLimitFields,
} from './motion-analysis.js';

export const MAX_BRIEF_NOTES = 2000;
export const MAX_SESSION_NOTES = 4000;
/** Older entries of a long session's edit log are dropped. */
export const MAX_SESSION_EDITS = 500;

const movement = '% of the image width per second';
const LIMITS: Readonly<Record<keyof SteadyLimitFields, { min: number; max: number; text: string }>> = {
  maxJolts: {
    ...MAX_JOLTS,
    text: `Jolts (how fast the camera movement changes, % of the image width per s²) every frame of a steady range stays below, ${MAX_JOLTS.min}–${MAX_JOLTS.max}: lower is steadier`,
  },
  minMovement: {
    ...MOVEMENT_RANGE,
    text: `Least picture movement of every frame of a steady range, ${movement}, ${MOVEMENT_RANGE.min}–${MOVEMENT_RANGE.max}: raise it to leave out static footage`,
  },
  maxMovement: {
    ...MOVEMENT_RANGE,
    text: `Most picture movement of every frame of a steady range, ${movement}; ${MOVEMENT_RANGE.max} has no limit`,
  },
  minFlightSpeed: {
    ...FLIGHT_SPEED_RANGE,
    text: `Least horizontal flight speed of every frame of a steady range, m/s, ${FLIGHT_SPEED_RANGE.min}–${FLIGHT_SPEED_RANGE.max}; frames without recorded speed are not judged by it`,
  },
  maxFlightSpeed: {
    ...FLIGHT_SPEED_RANGE,
    text: `Most horizontal flight speed of every frame of a steady range, m/s; ${FLIGHT_SPEED_RANGE.max} has no limit`,
  },
};

/**
 * The steady-range limits Source preview sets, as fields for the assistant, each wrapped (optional,
 * nullable…) and described with `unset(initial value)` appended.
 */
export function steadyLimitShape<T extends z.ZodType>(
  wrap: (field: z.ZodNumber) => T,
  unset: (initial: number) => string = () => '',
): Record<keyof SteadyLimitFields, T> {
  const initial = steadyLimitFields(steadyLimits());
  const keys = Object.keys(LIMITS) as (keyof SteadyLimitFields)[];
  return Object.fromEntries(
    keys.map((key) => {
      const { min, max, text } = LIMITS[key];
      const suffix = unset(initial[key]);
      return [key, described(wrap(z.number().min(min).max(max)), suffix ? `${text}; ${suffix}.` : `${text}.`)];
    }),
  ) as Record<keyof SteadyLimitFields, T>;
}

export const briefSchema = z
  .object({
    notes: described(
      z.string().max(MAX_BRIEF_NOTES).default(''),
      'What the user wants, in their words: style, story, what to avoid.',
    ),
    musicTrackId: described(idSchema.nullable().default(null), 'Music track the cut follows; null for any.'),
    targetSeconds: described(
      z.number().positive().max(86_400).nullable().default(null),
      'Target length of the cut in seconds; null follows the music.',
    ),
    ...steadyLimitShape(
      (field) => field.nullable().default(null),
      (initial) => `null keeps ${initial}`,
    ),
    maxClips: described(z.number().int().positive().max(1000).nullable().default(null), 'Most clips in the cut.'),
  })
  .strict()
  .superRefine((brief, context) => {
    const error = steadyLimitsError(steadyLimitsFrom(brief));
    if (error) context.addIssue({ code: 'custom', message: error });
  });
export type Brief = z.output<typeof briefSchema>;

export const sessionEditSchema = z
  .object({
    revision: frameSchema,
    at: z.string(),
    commands: z.number().int().positive(),
    summary: described(z.string(), 'The command types of the batch, in order.'),
    frame: described(
      frameSchema.nullable().default(null),
      'Earliest project frame the batch changed, where the editor shows it; null when none in particular.',
    ),
  })
  .strict();

export const sessionSchema = z
  .object({
    projectId: idSchema,
    startedAt: z.string(),
    startedBy: z.enum(['user', 'assistant']),
    lastActivityAt: z.string(),
    brief: briefSchema,
    checkpointId: described(z.string(), 'The checkpoint of the project as it was when the session started.'),
    edits: z.array(sessionEditSchema).max(MAX_SESSION_EDITS),
    endedAt: z.string().nullable(),
    endedBy: described(
      z.enum(['user', 'assistant', 'expiry']).nullable(),
      'Who ended the session: the user taking the project back, the assistant finishing, or inactivity; null while active.',
    ),
    notes: described(
      z.string().max(MAX_SESSION_NOTES).nullable(),
      "The assistant's notes for the user when it finished.",
    ),
  })
  .strict();
export type AssistantSession = z.infer<typeof sessionSchema>;

export const checkpointSummarySchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    reason: described(
      z.enum(['session-start', 'manual', 'before-restore']),
      'Why it was taken: a session starting, a checkpoint request, or a restore replacing the project.',
    ),
    label: z.string().nullable(),
    revision: described(frameSchema, 'Project revision the checkpoint holds.'),
    title: z.string(),
  })
  .strict();
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

function inside(ranges: readonly SelectRange[] | undefined, sourceIn: number, sourceOut: number): boolean {
  return ranges === undefined || ranges.some((range) => sourceIn >= range.sourceIn && sourceOut <= range.sourceOut);
}

/**
 * What an assistant session may not change: kept ranges only narrow, and every clip it inserts or
 * changes plays frames of a project recording inside one of its kept ranges. Returns the reason, or null.
 */
export function sessionViolation(
  before: ProjectDocument,
  after: ProjectDocument,
  recordingName: (mediaId: string) => string,
): string | null {
  for (const [mediaId, ranges] of Object.entries(before.selects)) {
    const next = after.selects[mediaId];
    if (next === undefined || next.some((range) => !inside(ranges, range.sourceIn, range.sourceOut)))
      return `The kept ranges of ${recordingName(mediaId)} can only narrow during an assistant session.`;
  }
  const previous = new Map(before.clips.map((clip) => [clip.id, clip]));
  for (const clip of after.clips) {
    const old = previous.get(clip.id);
    if (old?.mediaId === clip.mediaId && old.sourceIn === clip.sourceIn && old.sourceOut === clip.sourceOut) continue;
    if (!after.media.videoIds.includes(clip.mediaId))
      return `Clip ${clip.id} uses ${recordingName(clip.mediaId)}, which is not a recording of this project.`;
    if (!inside(after.selects[clip.mediaId], clip.sourceIn, clip.sourceOut))
      return `Clip ${clip.id} plays frames ${clip.sourceIn}–${clip.sourceOut} of ${recordingName(clip.mediaId)}, outside the ranges the user kept; place it inside one kept range.`;
  }
  return null;
}
