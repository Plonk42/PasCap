import { applyCommand, type EditCommand } from './commands.js';
import type { MusicTrack, ProjectDocument, Transition } from './model.js';
import { MUSIC_SAMPLES_PER_FRAME } from './music-format.js';
import type { PlacedBeat } from './music-analysis.js';
import { trimAtPlayhead } from './rush-editing.js';
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

/** The nearest beat to a frame, and the signed offset frame − beat; null without beats. */
export function nearestBeat(beats: readonly PlacedBeat[], frame: number): { beat: number; offset: number } | null {
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
  /** The beat aimed at, or null when none lies at or before the boundary. */
  beat: number | null;
  after: number;
  /** Why the boundary was left where it is, or null. */
  skipped: string | null;
}

function lastAtOrBefore(sorted: readonly number[], frame: number): number | null {
  let found: number | null = null;
  for (const value of sorted) if (value <= frame) found = value;
  return found;
}

/** One boundary's trim on the project as edited so far, or why it is skipped. */
function snapBoundary(
  document: ProjectDocument,
  layerId: string,
  pair: { leftId: string; rightId: string },
  targets: readonly number[],
  minimumFrames: number,
): { entry: SnappedBoundary; command: EditCommand | null; document: ProjectDocument } {
  const before = boundaries(document, layerId).find((item) => item.leftId === pair.leftId)!.frame;
  const beat = lastAtOrBefore(targets, before);
  const entry: SnappedBoundary = { ...pair, before, beat, after: before, skipped: null };
  if (beat === null) return { entry: { ...entry, skipped: 'No beat at or before it.' }, command: null, document };
  if (beat === before) return { entry, command: null, document };
  const left = calculateLayout(document).clips.find((placed) => placed.clip.id === pair.leftId)!;
  const end = left.end - (before - beat);
  if (end - left.start < minimumFrames)
    return {
      entry: { ...entry, skipped: 'Reaching the beat would make the left clip shorter than the minimum.' },
      command: null,
      document,
    };
  try {
    const command = trimAtPlayhead(document, pair.leftId, end - 1, 'out');
    const next = applyCommand(document, command);
    const after = boundaries(next, layerId).find((item) => item.leftId === pair.leftId)!.frame;
    return { entry: { ...entry, after }, command, document: next };
  } catch (error) {
    const skipped = error instanceof Error ? error.message : 'The trim was rejected.';
    return { entry: { ...entry, skipped }, command: null, document };
  }
}

/**
 * Shortens the clips of one Ripple track so that each boundary, left to right, lands on the nearest
 * beat (or downbeat) at or before it, keeping each clip at least `minimumFrames` long. Shortening the
 * left clip's OUT moves every later clip, so boundaries are taken one at a time on the edited project.
 */
export function snapCutsToBeats(
  project: ProjectDocument,
  layerId: string,
  beats: readonly PlacedBeat[],
  downbeatsOnly: boolean,
  minimumFrames: number,
): SnapResult {
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error(`The project has no video track ${layerId}.`);
  if (!layer.ripple) throw new Error('Snapping cuts needs a Ripple track, where later clips follow a shortened one.');
  const targets = beats.filter((beat) => !downbeatsOnly || beat.downbeat).map((beat) => beat.frame);
  let document = project;
  const commands: EditCommand[] = [];
  const result: SnappedBoundary[] = [];
  for (const { leftId, rightId } of layer.transitions) {
    const step = snapBoundary(document, layerId, { leftId, rightId }, targets, minimumFrames);
    document = step.document;
    if (step.command) commands.push(step.command);
    result.push(step.entry);
  }
  return { commands, boundaries: result };
}
