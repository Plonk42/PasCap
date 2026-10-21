import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { musicClips } from '../shared/music-lanes.js';
import { clipDuration } from '../shared/speed.js';
import { calculateLayout, layerClips, transitionOffset, type PlacedClip } from '../shared/timeline.js';

export type TimelinePayload =
  | { kind: 'clip'; clipId: string; grabFrame: number }
  | { kind: 'media'; clips: readonly VideoClip[] }
  /** Selected clips dragged together by one of them, `clipId`. */
  | { kind: 'group'; clipIds: readonly string[]; clipId: string; grabFrame: number };
type SinglePayload = Exclude<TimelinePayload, { kind: 'group' }>;
export interface DropGhost {
  clipId: string;
  layerId: string;
  start: number;
  duration: number;
}
export interface DropPlan {
  layerId: string;
  start: number;
  duration: number;
  guide: number | null;
  mode: 'ripple' | 'position';
  index: number;
  command: EditCommand | null;
  error: string;
  /** Every moved clip of a group drag, the dragged one included. */
  ghosts?: DropGhost[];
}

/** Match either edge, never pull the moving clip toward its own old boundaries. */
export function snapPlacement(
  start: number,
  duration: number,
  points: readonly number[],
  tolerance: number,
): { start: number; guide: number | null } {
  let result = Math.max(0, Math.round(start));
  let guide: number | null = null;
  let closest = tolerance + 1e-8;
  for (const point of points) {
    for (const edge of [0, duration]) {
      const candidate = point - edge;
      if (candidate < 0) continue;
      const distance = Math.abs(candidate - start);
      if (distance < closest) {
        closest = distance;
        result = candidate;
        guide = point;
      }
    }
  }
  return { start: result, guide };
}

export function placementSnapPoints(
  project: ProjectDocument,
  excludedClipId: string | null,
  playhead: number,
): number[] {
  return snapPointsWithout(project, new Set(excludedClipId === null ? [] : [excludedClipId]), playhead);
}

function snapPointsWithout(project: ProjectDocument, excluded: ReadonlySet<string>, playhead: number): number[] {
  const layout = calculateLayout(project);
  const clips = layout.clips.filter((placed) => !excluded.has(placed.clip.id));
  const transitions = layout.transitions.filter(
    (region) => !excluded.has(region.transition.leftId) && !excluded.has(region.transition.rightId),
  );
  const points = [
    0,
    playhead,
    ...clips.flatMap((placed) => [placed.start, placed.end]),
    ...transitions.flatMap((region) => [region.start, region.boundary, region.end]),
  ];
  points.push(
    ...musicClips(project.music)
      .filter((clip) => !excluded.has(clip.id))
      .flatMap((clip) => [clip.start, clip.start + clip.duration]),
    ...project.bookmarks,
  );
  return [...new Set(points)].filter((point) => point >= 0).sort((left, right) => left - right);
}

interface InsertionSlot {
  index: number;
  start: number;
}
function rippleSlots(
  project: ProjectDocument,
  payload: TimelinePayload,
  layerId: string,
  firstId: string,
  requested: number,
): InsertionSlot[] {
  const clips = payload.kind === 'clip' ? project.clips.filter((clip) => clip.id !== payload.clipId) : project.clips;
  const layer = project.layers.find((item) => item.id === layerId)!;
  const ordered = layerClips({ ...project, clips }, layerId);
  if (!ordered.length) return [{ index: clips.length, start: requested }];
  const anchor = calculateLayout(project).clips.find((item) => item.clip.layerId === layerId)!.start;
  // Only this target track's temporary remainder determines insertion slots.
  // Preserve its old first anchor when removing the first instance. Compile
  // the contextual maps without validating temporary transition/fade regions:
  // reinsertion can restore their valid placement. Validate the full candidate.
  const transitions = ordered
    .slice(0, -1)
    .map(
      (left, index) =>
        layer.transitions.find(
          (transition) => transition.leftId === left.id && transition.rightId === ordered[index + 1]!.id,
        ) ?? { leftId: left.id, rightId: ordered[index + 1]!.id, type: 'cut' as const, duration: 0 as const },
    );
  let cursor = anchor;
  const placed = ordered.map((clip, index) => {
    cursor += transitionOffset(transitions[index - 1]);
    const start = cursor;
    cursor += clipDuration(clip);
    return { clip, start, end: cursor };
  });
  return Array.from({ length: ordered.length + 1 }, (_, order) => {
    const left = placed[order - 1];
    const incoming =
      left &&
      layer.transitions.find(
        (transition) =>
          transition.leftId === left.clip.id && transition.rightId === firstId && transitionOffset(transition) !== 0,
      );
    return {
      index: order < ordered.length ? clips.findIndex((clip) => clip.id === ordered[order]!.id) : clips.length,
      start: left ? left.end + transitionOffset(incoming) : anchor,
    };
  });
}

function candidateDocument(project: ProjectDocument, payload: SinglePayload, plan: DropPlan): ProjectDocument {
  if (payload.kind === 'clip') return applyCommand(project, plan.command!);
  let document = project;
  let cursor = plan.start;
  for (const [offset, clip] of payload.clips.entries()) {
    document = applyCommand(document, {
      type: 'insert',
      clip: { ...clip, layerId: plan.layerId, start: cursor },
      index: plan.index + offset,
    });
    cursor = calculateLayout(document).clips.find((placed) => placed.clip.id === clip.id)!.end;
  }
  return document;
}

function draggedClips(project: ProjectDocument, payload: SinglePayload): readonly VideoClip[] {
  if (payload.kind === 'media') {
    if (!payload.clips.length) throw new Error('The dragged clip is unavailable.');
    return payload.clips;
  }
  const clip = project.clips.find((item) => item.id === payload.clipId);
  if (!clip) throw new Error('The dragged clip is unavailable.');
  return [clip];
}

/** The delta bringing a moved clip's leading or trailing edge closest to a snap point, within tolerance. */
function snapGroupDelta(
  moved: readonly PlacedClip[],
  requested: number,
  points: readonly number[],
  tolerance: number,
): { delta: number; guide: number | null } {
  let delta = requested;
  let guide: number | null = null;
  let closest = tolerance + 1e-8;
  for (const point of points)
    for (const placed of moved)
      for (const edge of [placed.start, placed.end]) {
        const candidate = point - edge;
        if (Math.abs(candidate - requested) < closest && moved.every((item) => item.start + candidate >= 0)) {
          closest = Math.abs(candidate - requested);
          delta = candidate;
          guide = point;
        }
      }
  return { delta, guide };
}

/**
 * Selected clips move by the dragged clip's delta. Clips from one track follow the pointer to its track;
 * clips from several tracks stay on theirs. Ripple-off destinations snap any moved edge; a Ripple
 * destination places them in its sequence. The shared command validates the whole move.
 */
function planGroupDrop(
  project: ProjectDocument,
  payload: Extract<TimelinePayload, { kind: 'group' }>,
  pointerLayerId: string,
  pointerFrame: number,
  snapping: boolean,
  tolerance: number,
  playhead: number,
): DropPlan {
  const layout = calculateLayout(project);
  const moved = layout.clips.filter((placed) => payload.clipIds.includes(placed.clip.id));
  const grabbed = moved.find((placed) => placed.clip.id === payload.clipId);
  if (!grabbed || moved.length !== payload.clipIds.length) throw new Error('The dragged clips are unavailable.');
  const layerId = new Set(moved.map((placed) => placed.clip.layerId)).size === 1 ? pointerLayerId : null;
  const destination = (placed: PlacedClip): string => layerId ?? placed.clip.layerId;
  const rippleOn = (placed: PlacedClip): boolean =>
    project.layers.find((layer) => layer.id === destination(placed))!.ripple;
  let delta = Math.round(pointerFrame - payload.grabFrame) - grabbed.start;
  let guide: number | null = null;
  const free = moved.filter((placed) => !rippleOn(placed));
  if (snapping && free.length) {
    const points = snapPointsWithout(project, new Set(payload.clipIds), playhead);
    ({ delta, guide } = snapGroupDelta(free, delta, points, tolerance));
  }
  const command: EditCommand = { type: 'move-clips', clipIds: [...payload.clipIds], delta, layerId };
  const requestedGhosts = moved.map((placed) => ({
    clipId: placed.clip.id,
    layerId: destination(placed),
    start: placed.start + delta,
    duration: placed.duration,
  }));
  const plan: DropPlan = {
    layerId: destination(grabbed),
    start: grabbed.start + delta,
    duration: grabbed.duration,
    guide,
    mode: rippleOn(grabbed) ? 'ripple' : 'position',
    index: -1,
    command,
    error: '',
    ghosts: requestedGhosts,
  };
  try {
    const candidate = calculateLayout(applyCommand(project, command)).clips;
    plan.ghosts = moved.map((placed) => {
      const next = candidate.find((item) => item.clip.id === placed.clip.id)!;
      return { clipId: next.clip.id, layerId: next.clip.layerId, start: next.start, duration: next.duration };
    });
    plan.start = plan.ghosts.find((ghost) => ghost.clipId === grabbed.clip.id)!.start;
  } catch (cause) {
    plan.command = null;
    plan.error = cause instanceof Error ? cause.message : 'These clips cannot move here.';
  }
  return plan;
}

function durationAt(clips: readonly VideoClip[]): number {
  return clips.reduce((total, clip) => total + clipDuration(clip), 0);
}

/** Leading or trailing edge snaps; a clip keeps its own duration wherever it moves. */
function snapRowPlacement(
  clips: readonly VideoClip[],
  requested: number,
  points: readonly number[],
  tolerance: number,
): { start: number; guide: number | null } {
  let start = requested;
  let guide: number | null = null;
  let closest = tolerance + 1e-8;
  const consider = (candidate: number, point: number): void => {
    const distance = Math.abs(candidate - requested);
    if (candidate >= 0 && distance < closest) {
      start = candidate;
      guide = point;
      closest = distance;
    }
  };
  const duration = durationAt(clips);
  for (const point of points) {
    consider(point, point);
    consider(point - duration, point);
  }
  return { start, guide };
}

/** Both drag feedback and drop commit consume this same integer-frame plan. */
export function planTimelineDrop(
  project: ProjectDocument,
  payload: TimelinePayload,
  layerId: string,
  pointerFrame: number,
  snapping: boolean,
  tolerance: number,
  playhead: number,
): DropPlan {
  if (!project.layers.some((item) => item.id === layerId)) throw new Error('Choose a video track before dropping.');
  return payload.kind === 'group'
    ? planGroupDrop(project, payload, layerId, pointerFrame, snapping, tolerance, playhead)
    : planSingleDrop(project, payload, layerId, pointerFrame, snapping, tolerance, playhead);
}

function planSingleDrop(
  project: ProjectDocument,
  payload: SinglePayload,
  layerId: string,
  pointerFrame: number,
  snapping: boolean,
  tolerance: number,
  playhead: number,
): DropPlan {
  const layer = project.layers.find((item) => item.id === layerId)!;
  const clips = draggedClips(project, payload);
  const first = clips[0]!;
  const requested = Math.max(0, Math.round(pointerFrame - (payload.kind === 'clip' ? payload.grabFrame : 0)));
  const mode = layer.ripple ? 'ripple' : 'position';
  let index =
    payload.kind === 'clip' ? project.clips.findIndex((clip) => clip.id === payload.clipId) : project.clips.length;
  let start = requested;
  let guide: number | null = null;
  const plan: DropPlan = { layerId, start, duration: 0, guide, mode, index, command: null, error: '' };
  try {
    if (mode === 'ripple') {
      const slots = rippleSlots(project, payload, layerId, first.id, requested);
      const slot = slots.reduce(
        (nearest, candidate) =>
          Math.abs(candidate.start - requested) < Math.abs(nearest.start - requested) ? candidate : nearest,
        slots[0]!,
      );
      index = slot.index;
      start = slot.start;
      // Reordering preserves the old anchor, but explicitly moving the same
      // first clip while it remains first is allowed to set a new anchor.
      const previousFirst = layerClips(project, layerId)[0];
      if (payload.kind === 'clip' && previousFirst?.id === first.id && slot === slots[0]) start = requested;
    } else if (snapping) {
      const snapped = snapRowPlacement(
        clips,
        requested,
        placementSnapPoints(project, payload.kind === 'clip' ? payload.clipId : null, playhead),
        tolerance,
      );
      start = snapped.start;
      guide = snapped.guide;
    }
    plan.index = index;
    plan.start = start;
    plan.guide = guide;
    plan.command = payload.kind === 'clip' ? { type: 'place', clipId: payload.clipId, layerId, start, index } : null;
    plan.duration = durationAt(clips);
    const candidate = candidateDocument(project, payload, plan);
    const layout = calculateLayout(candidate);
    const placed = layout.clips.find((item) => item.clip.id === first.id)!;
    plan.start = placed.start;
    plan.duration =
      Math.max(...clips.map((clip) => layout.clips.find((item) => item.clip.id === clip.id)!.end)) - placed.start;
  } catch (cause) {
    plan.error = cause instanceof Error ? cause.message : 'This placement is not valid.';
  }
  return plan;
}
