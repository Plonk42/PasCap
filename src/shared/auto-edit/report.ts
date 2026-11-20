import { z } from 'zod';
import { boundaries } from '../beat-alignment.js';
import { described } from '../described.js';
import { frameSchema, idSchema, type ProjectDocument } from '../model.js';
import { sectionKinds } from '../music-analysis.js';
import { durationSchema, durationOf } from '../operations/timecode.js';
import { SHOT_KINDS } from '../recording-shots.js';
import { calculateLayout } from '../timeline.js';
import type { Candidate, LeftOut } from './candidates.js';
import { AUTO_EDIT } from './constants.js';
import type { MusicTimeline } from './music.js';
import { autoEditChoicesSchema } from './options.js';
import type { AutoEditPlan } from './plan.js';

const rangeFields = {
  recording: described(z.string(), 'Name of the recording.'),
  mediaId: idSchema,
  sourceIn: frameSchema,
  sourceOut: frameSchema,
};
const rangeSchema = z.object(rangeFields).strict();

export const autoEditReportSchema = z
  .object({
    choices: autoEditChoicesSchema,
    duration: durationSchema,
    targetSeconds: described(z.number().nullable(), 'The length asked for; null followed the music or the footage.'),
    layerId: described(idSchema, 'The video track holding the cut.'),
    music: described(
      z
        .object({
          trackId: idSchema,
          recording: z.string(),
          placed: described(z.boolean(), 'True when auto edit placed this music on a new music track.'),
          analyzed: z.boolean(),
        })
        .strict()
        .nullable(),
      'The music the cut follows; null without music (even clip lengths).',
    ),
    clips: z.array(
      z
        .object({
          clipId: idSchema,
          ...rangeFields,
          start: frameSchema,
          end: frameSchema,
          section: z.enum(sectionKinds).nullable(),
          kind: z.enum(SHOT_KINDS),
          quality: z.number(),
          reasons: z.array(z.string()),
        })
        .strict(),
    ),
    transitions: z.object({ cuts: z.number().int(), dissolves: z.number().int(), fades: z.number().int() }).strict(),
    alignment: described(
      z
        .object({
          boundaries: z.number().int(),
          onDownbeat: z.number().int(),
          onBeat: z.number().int(),
          onHit: z.number().int(),
        })
        .strict()
        .nullable(),
      'Boundaries within one frame of a downbeat, beat or strong hit; null without music.',
    ),
    duplicates: described(
      z.array(z.object({ chosen: rangeSchema, alike: z.array(rangeSchema) }).strict()),
      'Alike takes of one subject: the one chosen and those left out as duplicates.',
    ),
    leftOut: described(
      z.array(z.object({ ...rangeFields, reason: z.string() }).strict()),
      'Steady ranges left out, and why (the first ones).',
    ),
    leftOutCount: z.number().int(),
    candidates: described(z.number().int(), 'Steady ranges considered.'),
    skipped: described(
      z.array(z.object({ mediaId: idSchema, recording: z.string(), reason: z.string() }).strict()),
      'Recordings of the bin auto edit could not use.',
    ),
    grade: z
      .object({
        choice: autoEditChoicesSchema.shape.grade,
        clips: described(z.number().int(), 'Clips whose grade was set.'),
        hero: described(
          z.object({ clipId: idSchema, recording: z.string() }).strict().nullable(),
          'The clip every other one was matched to.',
        ),
        style: z.object({ id: idSchema, name: z.string() }).strict().nullable(),
        failed: described(z.string().nullable(), 'Why the grade stopped early, or null.'),
      })
      .strict(),
    notes: described(z.array(z.string()), 'What the user should know: a shorter cut, refused transitions, and more.'),
  })
  .strict();
export type AutoEditReport = z.infer<typeof autoEditReportSchema>;

/** How many boundaries of the track lie within a frame of a downbeat, a beat and a strong hit. */
export function alignmentOf(document: ProjectDocument, layerId: string, music: MusicTimeline | null) {
  if (!music || (!music.beats.length && !music.strongHits.length)) return null;
  const near = (frames: readonly number[], frame: number) => frames.some((item) => Math.abs(item - frame) <= 1);
  const beats = music.beats.map((beat) => beat.frame);
  const cuts = boundaries(document, layerId).map((boundary) => boundary.frame);
  return {
    boundaries: cuts.length,
    onDownbeat: cuts.filter((frame) => near(music.downbeats, frame)).length,
    onBeat: cuts.filter((frame) => near(beats, frame)).length,
    onHit: cuts.filter((frame) => near(music.strongHits, frame)).length,
  };
}

function rangeOf(candidate: Pick<Candidate, 'name' | 'mediaId' | 'sourceIn' | 'sourceOut'>) {
  return {
    recording: candidate.name,
    mediaId: candidate.mediaId,
    sourceIn: candidate.sourceIn,
    sourceOut: candidate.sourceOut,
  };
}

/** Clusters of alike takes with one chosen for the cut, and the takes left out of them. */
function duplicatesOf(candidates: readonly Candidate[], plan: AutoEditPlan) {
  const used = new Set(plan.clips.map((clip) => clip.candidate.id));
  const groups = new Map<number, Candidate[]>();
  candidates.forEach((candidate, index) => {
    const cluster = plan.clusters[index]!;
    groups.set(cluster, [...(groups.get(cluster) ?? []), candidate]);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1 && group.some((candidate) => used.has(candidate.id)))
    .map((group) => ({
      chosen: rangeOf(group.find((candidate) => used.has(candidate.id))!),
      alike: group.filter((candidate) => !used.has(candidate.id)).map(rangeOf),
    }))
    .filter((entry) => entry.alike.length > 0)
    .slice(0, AUTO_EDIT.reportItems);
}

export interface ReportInput {
  plan: AutoEditPlan;
  candidates: readonly Candidate[];
  leftOut: readonly LeftOut[];
  document: ProjectDocument;
  layerId: string;
  clipIds: readonly string[];
  music: AutoEditReport['music'];
  timeline: MusicTimeline | null;
  targetSeconds: number | null;
  choices: AutoEditReport['choices'];
  skipped: AutoEditReport['skipped'];
  notes: readonly string[];
}

/** What auto edit built and why, before the grade. */
export function cutReport(input: ReportInput): Omit<AutoEditReport, 'grade'> {
  const { plan, document } = input;
  const layout = document.clips.filter((clip) => clip.layerId === input.layerId);
  const placed = new Map(layout.map((clip) => [clip.id, clip]));
  const built = document.layers.find((layer) => layer.id === input.layerId)?.transitions ?? [];
  const count = (type: string) => built.filter((transition) => transition.type === type).length;
  const leftOut = [
    ...input.leftOut.map((item) => ({ ...rangeOf(item), reason: item.reason })),
    ...input.candidates
      .filter((candidate) => !plan.clips.some((clip) => clip.candidate.id === candidate.id))
      .map((candidate) => ({ ...rangeOf(candidate), reason: 'Another shot scored better in its place.' })),
  ];
  return {
    choices: input.choices,
    duration: durationOf(calculateLayout(document).duration),
    targetSeconds: input.targetSeconds,
    layerId: input.layerId,
    music: input.music,
    clips: plan.clips.map((clip, index) => {
      const id = input.clipIds[index]!;
      return {
        clipId: id,
        ...rangeOf({
          ...clip.candidate,
          sourceIn: placed.get(id)?.sourceIn ?? clip.sourceIn,
          sourceOut: placed.get(id)?.sourceOut ?? clip.sourceOut,
        }),
        start: clip.slot.start,
        end: clip.slot.end,
        section: clip.slot.kind,
        kind: clip.candidate.kind,
        quality: Math.round(clip.candidate.quality * 100) / 100,
        reasons: clip.reasons,
      };
    }),
    transitions: { cuts: count('cut'), dissolves: count('cross-dissolve'), fades: count('fade-through-black') },
    alignment: alignmentOf(document, input.layerId, input.timeline),
    duplicates: duplicatesOf(input.candidates, plan),
    leftOut: leftOut.slice(0, AUTO_EDIT.reportItems),
    leftOutCount: leftOut.length,
    candidates: input.candidates.length,
    skipped: input.skipped,
    notes: [...(plan.shortfall ? [plan.shortfall] : []), ...input.notes],
  };
}
