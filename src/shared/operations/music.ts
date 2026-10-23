import { z } from 'zod';
import { editCommandSchema } from '../command-schema.js';
import { described } from '../described.js';
import { frameSchema, idSchema } from '../model.js';
import { hitBands, pitchNames, sectionKinds, swellKinds } from '../music-analysis.js';
import { defineOperation, revisionReadSchema } from './spec.js';
import { durationSchema, timecodeSchema } from './timecode.js';

export const MAX_LISTED_BEATS = 2000;

const projectId = described(idSchema, 'ID of the saved project.');
const musicClipId = described(
  idSchema.optional(),
  'ID of one music clip, from describe_project; every music clip of the project when omitted.',
);
const placedBeat = z
  .object({
    frame: frameSchema,
    timecode: timecodeSchema,
    downbeat: described(z.boolean(), 'The first beat of a bar.'),
    strength: described(z.number(), 'Onset strength, 0–1.'),
  })
  .strict();
const placedHit = z
  .object({
    frame: frameSchema,
    timecode: timecodeSchema,
    band: described(
      z.enum(hitBands),
      'The band that rose most: low below 250 Hz (kick, bass), mid (snare, most instruments), high above 4 kHz (hi-hat, cymbals).',
    ),
    strong: described(z.boolean(), 'Stands out strongly: the hits a viewer notices, which snapping uses.'),
    strength: described(z.number(), 'How strongly it stands out, 0–1.'),
  })
  .strict();

export const musicAnalysis = defineOperation({
  name: 'music_analysis',
  description:
    "Read the music of the project's music clips at project frames (where each plays on the timeline, repeated across loops): tempo, meter, beats, downbeats, hits (rhythmic hits that stand out from their surroundings, such as a kick, a snare or a cymbal crash, each with the band that rose most and whether it is strong: the places worth cutting on), key and mode, sections (quiet, build, peak, release) with their loudness and tone (low, mid and high frequency levels), swells (crescendos and decrescendos, sudden or gradual) and silences. Use a frame window for long music. A clip whose music is not analysed yet says so; ask the user to analyse it in Audio → Music.",
  input: z
    .object({
      projectId,
      musicClipId,
      fromFrame: described(frameSchema.optional(), 'First project frame of the window.'),
      toFrame: described(frameSchema.optional(), 'Project frame after the window (exclusive).'),
      detail: described(
        z.enum(['summary', 'full']).default('full'),
        'summary leaves out the beats and the light hits (their counts remain) to read the structure of long music at a glance; full lists every beat and hit in the window.',
      ),
    })
    .strict(),
  output: z
    .object({
      revision: revisionReadSchema,
      clips: z.array(
        z
          .object({
            musicClipId: idSchema,
            trackId: idSchema,
            recording: z.object({ id: idSchema, name: z.string() }).strict(),
            start: frameSchema,
            end: described(frameSchema, 'Exclusive.'),
            analysis: described(
              z.enum(['analysed', 'analysing', 'missing']),
              'Whether its beats are known, being found, or not analysed.',
            ),
            tempo: z.object({ bpm: z.number(), confidence: z.number() }).strict().nullable(),
            meter: z.object({ beatsPerBar: z.number().int(), confidence: z.number() }).strict().nullable(),
            beats: described(z.array(placedBeat), 'Beats in the window; none in summary.'),
            beatCount: described(z.number().int().nonnegative(), 'Beats in the window, listed or not.'),
            beatsTruncated: described(
              z.boolean(),
              `True when more than ${MAX_LISTED_BEATS} beats fall in the window; ask for a narrower one.`,
            ),
            hits: described(z.array(placedHit), 'Hits in the window; only the strong ones in summary.'),
            hitCount: described(z.number().int().nonnegative(), 'Hits in the window, strong or light, listed or not.'),
            hitsTruncated: described(
              z.boolean(),
              `True when more than ${MAX_LISTED_BEATS} hits fall in the window; ask for a narrower one.`,
            ),
            key: described(
              z
                .object({ tonic: z.enum(pitchNames), mode: z.enum(['major', 'minor']), confidence: z.number() })
                .strict()
                .nullable(),
              'Key of the whole recording; a relative major and minor (C major, A minor) can be confused.',
            ),
            sections: z.array(
              z
                .object({
                  start: frameSchema,
                  end: described(frameSchema, 'Exclusive.'),
                  kind: z.enum(sectionKinds),
                  loudnessDb: z.number(),
                  tone: described(
                    z.object({ lowDb: z.number(), midDb: z.number(), highDb: z.number() }).strict(),
                    'Mean level below 250 Hz (bass, kick), 250 Hz–4 kHz (most instruments and voice) and above 4 kHz (cymbals, air), dBFS.',
                  ),
                })
                .strict(),
            ),
            swells: z.array(
              z
                .object({
                  start: frameSchema,
                  end: described(frameSchema, 'Exclusive.'),
                  kind: z.enum(swellKinds),
                  changeDb: described(z.number(), 'Loudness change over the swell.'),
                  sudden: described(z.boolean(), 'Within about a second: a hit or a cut-off, not a gradual swell.'),
                })
                .strict(),
            ),
            silences: z.array(z.object({ start: frameSchema, end: described(frameSchema, 'Exclusive.') }).strict()),
          })
          .strict(),
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

const offset = described(
  z.object({ frame: frameSchema, offset: z.number().int() }).strict().nullable(),
  'The nearest one and the signed offset in frames (positive: the change comes after it); null without any.',
);

export const checkAlignment = defineOperation({
  name: 'check_alignment',
  description:
    'Measure how the cut follows the music: for every boundary of every video track (or one), the frame the viewer perceives as the change (the cut, the middle of a dissolve, the middle of a black pause), its nearest beat, downbeat and strong hit and the signed offsets in frames, and a summary. Within one frame of a beat or hit counts as on it.',
  input: z
    .object({ projectId, layerId: described(idSchema.optional(), 'One video track only.'), musicClipId })
    .strict(),
  output: z
    .object({
      revision: revisionReadSchema,
      beats: described(z.number().int().nonnegative(), 'Beats of the analysed music clips considered.'),
      hits: described(z.number().int().nonnegative(), 'Strong hits of the analysed music clips considered.'),
      boundaries: z.array(
        z
          .object({
            layerId: idSchema,
            leftId: idSchema,
            rightId: idSchema,
            type: z.string(),
            frame: frameSchema,
            timecode: timecodeSchema,
            beat: offset,
            downbeat: offset,
            hit: offset,
          })
          .strict(),
      ),
      summary: z
        .object({
          boundaries: z.number().int().nonnegative(),
          onBeat: described(z.number().int().nonnegative(), 'Boundaries within one frame of a beat.'),
          onDownbeat: described(z.number().int().nonnegative(), 'Boundaries within one frame of a downbeat.'),
          onHit: described(z.number().int().nonnegative(), 'Boundaries within one frame of a strong hit.'),
          meanOffset: described(z.number().nullable(), 'Mean absolute offset from the nearest beat, in frames.'),
        })
        .strict(),
    })
    .strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});

export const snapCutsToBeats = defineOperation({
  name: 'snap_cuts_to_beats',
  description:
    "Move the boundaries of one Ripple video track onto the music: left to right, trim each boundary's left clip so the change lands on the nearest beat (or downbeat, or strong hit), shortening it, or lengthening it where its recording has footage inside the kept ranges, else taking the nearest one on the other side; each clip stays at least minimumSeconds long and transitions keep their durations; later clips follow. Returns the proposed trim commands and each boundary before and after; with apply, saves them as one edit (needs the session and expectedRevision). Do the arithmetic with this rather than by hand.",
  input: z
    .object({
      projectId,
      layerId: described(idSchema, 'ID of a video track with Ripple on.'),
      prefer: described(
        z.enum(['beat', 'downbeat', 'hit', 'beat-or-hit']).default('beat'),
        'Snap to every beat, to downbeats only, to strong hits only, or to beats and strong hits.',
      ),
      minimumSeconds: described(
        z.number().min(0).max(60).default(1),
        'Shortest a clip may become; a boundary that would need a shorter clip stays where it is.',
      ),
      maxShift: described(
        z.number().int().nonnegative().optional(),
        'Farthest a boundary may move, in frames; one whose nearest target is farther stays where it is.',
      ),
      keep: described(
        z.array(z.object({ leftId: idSchema, rightId: idSchema }).strict()).optional(),
        'Boundaries (their left and right clip IDs) to keep on their frame: never snapped, and taken back to it when earlier trims move it.',
      ),
      keepOnHit: described(
        z.boolean().default(false),
        'Keep every boundary already within one frame of a hit, strong or light, like the listed ones.',
      ),
      musicClipId,
      apply: described(z.boolean().default(false), 'True saves the trims as one edit; false only proposes them.'),
      expectedRevision: described(
        frameSchema.optional(),
        'Revision you last read, from describe_project; required with apply.',
      ),
    })
    .strict(),
  output: z
    .object({
      revision: described(revisionReadSchema, 'Saved revision the proposal was computed on, before any apply.'),
      boundaries: z.array(
        z
          .object({
            leftId: idSchema,
            rightId: idSchema,
            before: frameSchema,
            beat: described(frameSchema.nullable(), 'The beat or hit reached, else the nearest one.'),
            target: described(
              z.enum(['beat', 'downbeat', 'hit']).nullable(),
              'What that frame is: a beat, a downbeat or a strong hit; null without one.',
            ),
            after: frameSchema,
            skipped: described(z.string().nullable(), 'Why the boundary was not snapped, such as kept or too far.'),
          })
          .strict(),
      ),
      commands: z.array(editCommandSchema),
      applied: described(
        z.object({ revision: frameSchema, duration: durationSchema }).strict().nullable(),
        'The saved revision with apply; null for a proposal or when nothing moved.',
      ),
    })
    .strict(),
  access: 'write',
  audience: ['editor', 'assistant'],
});
