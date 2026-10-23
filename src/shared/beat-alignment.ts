import { applyCommand, type EditCommand } from './commands.js';
import type { MusicTrack, ProjectDocument, Transition, VideoClip } from './model.js';
import { MUSIC_SAMPLES_PER_FRAME } from './music-format.js';
import type { PlacedBeat } from './music-analysis.js';
import { trimAtPlayhead } from './rush-editing.js';
import { trimByOutputFrames } from './source-range.js';
import { calculateLayout, type PlacedTransition } from './timeline.js';

/** Project frames where a source sample of a music clip plays, once per loop repeat. */
export function musicSampleFrames(music: MusicTrack, sample: number): number[] {
  const length = music.sourceOut - music.sourceIn;
  const offset = sample / MUSIC_SAMPLES_PER_FRAME - music.sourceIn;
  if (offset < 0 || offset >= length) return [];
  const end = music.start + music.duration;
  const frames: number[] = [];
  for (let repeat = 0; repeat < (music.loop ? Math.ceil(music.duration / length) : 1); repeat++) {
    const frame = music.start + repeat * length + Math.round(offset);
    if (frame < end) frames.push(frame);
  }
  return frames;
}

/** Project frame ranges a source sample range of a music clip plays at, once per loop repeat. */
export function musicSampleRanges(music: MusicTrack, from: number, to: number): { start: number; end: number }[] {
  const length = music.sourceOut - music.sourceIn;
  const first = Math.max(0, from / MUSIC_SAMPLES_PER_FRAME - music.sourceIn);
  const last = Math.min(length, to / MUSIC_SAMPLES_PER_FRAME - music.sourceIn);
  if (last <= first) return [];
  const end = music.start + music.duration;
  const ranges: { start: number; end: number }[] = [];
  for (let repeat = 0; repeat < (music.loop ? Math.ceil(music.duration / length) : 1); repeat++) {
    const start = music.start + repeat * length + Math.round(first);
    const stop = Math.min(end, music.start + repeat * length + Math.round(last));
    if (stop > start) ranges.push({ start, end: stop });
  }
  return ranges;
}

/** Beats of several music clips merged by frame, a downbeat winning a shared frame. */
export function mergeBeats(lists: readonly (readonly PlacedBeat[])[]): PlacedBeat[] {
  const byFrame = new Map<number, PlacedBeat>();
  for (const beat of lists.flat()) {
    const known = byFrame.get(beat.frame);
    if (!known || (beat.downbeat && !known.downbeat)) byFrame.set(beat.frame, beat);
  }
  return [...byFrame.values()].sort((left, right) => left.frame - right.frame);
}

export interface Boundary {
  layerId: string;
  leftId: string;
  rightId: string;
  type: Transition['type'];
  /** The frame the viewer perceives as the change: the cut, a dissolve's or a pause's middle. */
  frame: number;
}

function perceivedFrame(placed: PlacedTransition): number {
  if (placed.transition.type === 'cross-dissolve') return Math.round((placed.start + placed.end) / 2);
  if (placed.slot) return Math.round((placed.slot.start + placed.slot.end) / 2);
  return placed.boundary;
}

export function boundaries(project: ProjectDocument, layerId?: string): Boundary[] {
  return calculateLayout(project)
    .transitions.filter((placed) => layerId === undefined || placed.layerId === layerId)
    .map((placed) => ({
      layerId: placed.layerId,
      leftId: placed.transition.leftId,
      rightId: placed.transition.rightId,
      type: placed.transition.type,
      frame: perceivedFrame(placed),
    }));
}

/** The nearest beat (or hit) to a frame, and the signed offset frame − beat; null without any. */
export function nearestBeat(
  beats: readonly { frame: number }[],
  frame: number,
): { beat: number; offset: number } | null {
  let best: { beat: number; offset: number } | null = null;
  for (const beat of beats)
    if (!best || Math.abs(frame - beat.frame) < Math.abs(best.offset))
      best = { beat: beat.frame, offset: frame - beat.frame };
  return best;
}

export interface SnapResult {
  /** The edit commands, in order; applying them as one batch snaps every listed boundary. */
  commands: EditCommand[];
  boundaries: SnappedBoundary[];
}
export interface SnappedBoundary {
  leftId: string;
  rightId: string;
  before: number;
  /** The beat reached, else the nearest one, or null without beats. */
  beat: number | null;
  /** What `beat` is, or null without one. */
  target: SnapTargetKind | null;
  after: number;
  /** Why the boundary was left where it is, or null. */
  skipped: string | null;
}

export type SnapTargetKind = 'beat' | 'downbeat' | 'hit';

/** Limits on which boundaries move and how far. */
export interface SnapOptions {
  /** What a target frame is: a beat, a downbeat or a hit. */
  kindOf?: (frame: number) => SnapTargetKind;
  /** Farthest a boundary may move, in frames; farther targets are not used. */
  maxShift?: number;
  /** Boundaries to leave where they are, as `leftId>rightId`. */
  keep?: ReadonlySet<string>;
  /** Hits (strong or light): a boundary within one frame of one stays where it is. */
  keepOnHits?: readonly number[];
}

/** The nearest target at or before `frame` and the nearest after it, nearest first. */
function candidates(sorted: readonly number[], frame: number): number[] {
  let earlier: number | undefined;
  for (const value of sorted) if (value <= frame) earlier = value;
  const later = sorted.find((value) => value > frame);
  return [earlier, later]
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => Math.abs(left - frame) - Math.abs(right - frame));
}

/** The registered length of a recording, and the source ranges kept of it (undefined: all of it). */
export interface SnapSources {
  frameCount: (mediaId: string) => number;
  kept: (mediaId: string) => readonly { sourceIn: number; sourceOut: number }[] | undefined;
}

type Step = { command: EditCommand; document: ProjectDocument; after: number } | { skipped: string };

/** Lengthens a clip's displayed end by `frames` output frames: its source OUT, or IN when reversed. */
function lengthen(clip: VideoClip, frames: number, frameCount: number): EditCommand {
  return clip.reverse
    ? trimByOutputFrames(clip, 'in', -frames, frameCount)
    : trimByOutputFrames(clip, 'out', frames, frameCount);
}

/** The trim moving the left clip's end (its source OUT, or IN when reversed) to `beat`, or why it cannot. */
function reachBeat(
  document: ProjectDocument,
  layerId: string,
  leftId: string,
  before: number,
  beat: number,
  minimumFrames: number,
  sources: SnapSources,
): Step {
  const left = calculateLayout(document).clips.find((placed) => placed.clip.id === leftId)!;
  const delta = beat - before;
  if (left.end - left.start + delta < minimumFrames)
    return { skipped: 'Reaching the beat would make the left clip shorter than the minimum.' };
  try {
    const { clip } = left;
    const command =
      delta < 0
        ? trimAtPlayhead(document, leftId, left.end + delta - 1, 'out')
        : lengthen(clip, delta, sources.frameCount(clip.mediaId));
    if (command.type === 'trim') {
      const kept = sources.kept(clip.mediaId);
      if (kept && !kept.some((range) => command.sourceIn >= range.sourceIn && command.sourceOut <= range.sourceOut))
        return { skipped: 'Reaching the beat would play frames outside the ranges the user kept.' };
    }
    const next = applyCommand(document, command);
    const after = boundaries(next, layerId).find((item) => item.leftId === leftId)!.frame;
    // Speed rounding can leave a boundary one frame from the beat; further means the footage ran out.
    if (Math.abs(after - beat) > 1) return { skipped: 'The recording has no footage to reach the beat.' };
    return { command, document: next, after };
  } catch (error) {
    return { skipped: error instanceof Error ? error.message : 'The trim was rejected.' };
  }
}

/** Why a boundary first at `original` stays on that frame, or null. */
function keptReason(pair: { leftId: string; rightId: string }, original: number, options: SnapOptions): string | null {
  if (options.keep?.has(`${pair.leftId}>${pair.rightId}`)) return 'Listed in keep.';
  const hit = options.keepOnHits?.find((frame) => Math.abs(frame - original) <= 1);
  return hit === undefined ? null : `Already on a hit at frame ${hit}.`;
}

/** One boundary's trim on the project as edited so far, toward the nearest beat it can reach, or why none. */
function snapBoundary(
  document: ProjectDocument,
  layerId: string,
  pair: { leftId: string; rightId: string; original: number },
  targets: readonly number[],
  minimumFrames: number,
  sources: SnapSources,
  options: SnapOptions,
): { entry: SnappedBoundary; command: EditCommand | null; document: ProjectDocument } {
  const { original, ...ids } = pair;
  const before = boundaries(document, layerId).find((item) => item.leftId === pair.leftId)!.frame;
  const nearby = candidates(targets, before);
  const kind = (frame: number | null) => (frame === null ? null : (options.kindOf?.(frame) ?? 'beat'));
  const nearest = nearby[0] ?? null;
  const entry: SnappedBoundary = { ...ids, before, beat: nearest, target: kind(nearest), after: before, skipped: null };
  const unchanged = (skipped: string | null) => ({ entry: { ...entry, skipped }, command: null, document });
  const kept = keptReason(pair, original, options);
  if (kept) {
    // Trims before it moved it along: its left clip takes it back to its frame.
    if (before === original) return unchanged(kept);
    const step = reachBeat(document, layerId, pair.leftId, before, original, minimumFrames, sources);
    if (!('command' in step)) return unchanged(`${kept} Earlier trims moved it, and it cannot return: ${step.skipped}`);
    return { entry: { ...entry, after: step.after, skipped: kept }, command: step.command, document: step.document };
  }
  if (nearest === null) return unchanged('No beat near it.');
  if (nearest === before) return unchanged(null);
  const { maxShift = Number.POSITIVE_INFINITY } = options;
  const reachable = nearby.filter((frame) => Math.abs(frame - before) <= maxShift);
  if (!reachable.length)
    return unchanged(`The nearest ${entry.target} is ${Math.abs(nearest - before)} frames away, more than maxShift.`);
  let skipped = '';
  for (const beat of reachable) {
    const step = reachBeat(document, layerId, pair.leftId, before, beat, minimumFrames, sources);
    if ('command' in step)
      return {
        entry: { ...entry, beat, target: kind(beat), after: step.after },
        command: step.command,
        document: step.document,
      };
    skipped ||= step.skipped;
  }
  return unchanged(skipped);
}

/**
 * Trims the clips of one Ripple track so that each boundary, left to right, lands on the nearest target
 * frame (beat, downbeat or hit): shortening the left clip, or lengthening it where its recording has footage
 * inside the kept ranges, else the nearest target on the other side; each clip stays at least `minimumFrames`
 * long. A trim moves every later clip, so boundaries are taken one at a time on the edited project.
 */
export function snapCutsToBeats(
  project: ProjectDocument,
  layerId: string,
  targets: readonly number[],
  minimumFrames: number,
  sources: SnapSources,
  options: SnapOptions = {},
): SnapResult {
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`The project has no video track ${layerId}.`);
  if (!layer.ripple) throw new Error('Snapping cuts needs a Ripple track, where later clips follow a shortened one.');
  let document = project;
  const commands: EditCommand[] = [];
  const result: SnappedBoundary[] = [];
  const originals = new Map(boundaries(project, layerId).map((item) => [item.leftId, item.frame]));
  for (const { leftId, rightId } of layer.transitions) {
    const pair = { leftId, rightId, original: originals.get(leftId)! };
    const step = snapBoundary(document, layerId, pair, targets, minimumFrames, sources, options);
    document = step.document;
    if (step.command) commands.push(step.command);
    result.push(step.entry);
  }
  return { commands, boundaries: result };
}
