import type { ProjectDocument, VideoClip, VideoLayer } from './model.js';
import { clipDuration } from './speed.js';
import { transitionOffset, type PlacedClip, type TimelineLayout } from './timeline.js';

/** Several selected clips moved together by one timeline-frame delta. */
export interface ClipGroupMove {
  clipIds: readonly string[];
  delta: number;
  /** The destination track of clips that all come from one track; null keeps every clip on its own track. */
  layerId: string | null;
}

export interface ClipGroupArrangement {
  clips: VideoClip[];
  /** Tracks whose clip pairs changed and need their transitions repaired. */
  layerIds: string[];
  /** Ripple tracks whose first clip moved with the group, and its new start. */
  anchors: Map<string, number>;
}

interface Block {
  ids: string[];
  requested: number;
}

function requireStart(start: number): number {
  if (start < 0) throw new Error('The selected clips cannot start before timeline frame 0.');
  return start;
}

function movedClips(before: TimelineLayout, move: ClipGroupMove): PlacedClip[] {
  const ids = new Set(move.clipIds);
  if (!ids.size || ids.size !== move.clipIds.length) throw new Error('Select each clip once to move them together.');
  if (!Number.isSafeInteger(move.delta)) throw new Error('Clips move by whole timeline frames.');
  const moved = before.clips.filter((placed) => ids.has(placed.clip.id));
  if (moved.length !== ids.size) throw new Error('Clip no longer exists.');
  if (move.layerId !== null && new Set(moved.map((placed) => placed.clip.layerId)).size > 1)
    throw new Error('Clips from several tracks move in time only, each on its own track.');
  return moved;
}

/**
 * Selected clips that were consecutive on their own Ripple track move as one block. Each block asks for
 * its start in the sequence of the clips left behind, so a zero delta leaves every block in place.
 */
function ownTrackBlocks(selected: ReadonlySet<string>, previous: readonly PlacedClip[], delta: number): Block[] {
  const blocks: Block[] = [];
  let removed = 0;
  let run: Block | null = null;
  for (const placed of previous) {
    if (!selected.has(placed.clip.id)) {
      run = null;
      continue;
    }
    if (!run) {
      run = { ids: [], requested: placed.start - removed + delta };
      blocks.push(run);
    }
    run.ids.push(placed.clip.id);
    removed += placed.duration;
  }
  return blocks;
}

/** Starts where a block can join the remaining Ripple sequence: before each remaining clip, or after the last. */
function rippleSlots(layer: VideoLayer, remainder: readonly VideoClip[], anchor: number, first: string): number[] {
  const slots = [anchor];
  let cursor = anchor;
  for (const [index, clip] of remainder.entries()) {
    const left = remainder[index - 1];
    const pair = left && layer.transitions.find((item) => item.leftId === left.id && item.rightId === clip.id);
    cursor += transitionOffset(pair) + clipDuration(clip);
    const incoming = layer.transitions.find((item) => item.leftId === clip.id && item.rightId === first);
    slots.push(cursor + transitionOffset(incoming));
  }
  return slots;
}

function nearestSlot(slots: readonly number[], requested: number): number {
  return slots.reduce(
    (best, start, index) => (Math.abs(start - requested) < Math.abs(slots[best]! - requested) ? index : best),
    0,
  );
}

/** A Ripple destination packs the moved clips at the slots nearest their new starts, in their order. */
function rippleSequence(
  layer: VideoLayer,
  remaining: readonly VideoClip[],
  group: readonly PlacedClip[],
  before: TimelineLayout,
  delta: number,
  clips: ReadonlyMap<string, VideoClip>,
  anchors: Map<string, number>,
): VideoClip[] {
  const previous = before.clips.filter((placed) => placed.clip.layerId === layer.id);
  const remainder = remaining.filter((clip) => clip.layerId === layer.id);
  const blocks = group.every((placed) => placed.clip.layerId === layer.id)
    ? ownTrackBlocks(new Set(group.map((placed) => placed.clip.id)), previous, delta)
    : [{ ids: group.map((placed) => placed.clip.id), requested: group[0]!.start + delta }];
  const slots = blocks.map((block) =>
    remainder.length
      ? nearestSlot(rippleSlots(layer, remainder, previous[0]!.start, block.ids[0]!), block.requested)
      : 0,
  );
  // Only the track's own first clip, still first, sets a new anchor; an empty track starts where asked.
  const leading = blocks[slots.indexOf(0)];
  if (leading && (!previous.length || leading.ids[0] === previous[0]!.clip.id)) {
    const start = requireStart(leading.requested);
    if (previous.length) anchors.set(layer.id, start);
    clips.get(leading.ids[0]!)!.start = start;
  }
  const sequence: VideoClip[] = [];
  for (let slot = 0; slot <= remainder.length; slot++) {
    for (const [index, block] of blocks.entries())
      if (slots[index] === slot) sequence.push(...block.ids.map((id) => clips.get(id)!));
    if (slot < remainder.length) sequence.push(remainder[slot]!);
  }
  return sequence;
}

/** Each Ripple track's new sequence takes the place of its first remaining clip; other moved clips follow. */
function assemble(
  remaining: readonly VideoClip[],
  sequences: ReadonlyMap<string, VideoClip[]>,
  positioned: readonly VideoClip[],
): VideoClip[] {
  const arranged: VideoClip[] = [];
  const emitted = new Set<string>();
  for (const clip of remaining) {
    const sequence = sequences.get(clip.layerId);
    if (!sequence) arranged.push(clip);
    else if (!emitted.has(clip.layerId)) {
      emitted.add(clip.layerId);
      arranged.push(...sequence);
    }
  }
  for (const [layerId, sequence] of sequences) if (!emitted.has(layerId)) arranged.push(...sequence);
  return [...arranged, ...positioned];
}

/**
 * Moves selected clips together. On a Ripple destination they follow its sequence; elsewhere each keeps
 * its offset from the others. Clips from several tracks stay on their own tracks. The caller repairs
 * transitions, applies the anchors and validates the whole result atomically.
 */
export function arrangeClipGroup(
  project: ProjectDocument,
  before: TimelineLayout,
  move: ClipGroupMove,
): ClipGroupArrangement {
  const moved = movedClips(before, move);
  const clips = new Map(project.clips.map((clip) => [clip.id, clip]));
  const remaining = project.clips.filter((clip) => !move.clipIds.includes(clip.id));
  const destinations = new Map<string, PlacedClip[]>();
  for (const placed of moved) {
    const layerId = move.layerId ?? placed.clip.layerId;
    destinations.set(layerId, [...(destinations.get(layerId) ?? []), placed]);
  }
  const anchors = new Map<string, number>();
  const sequences = new Map<string, VideoClip[]>();
  const positioned: VideoClip[] = [];
  for (const [layerId, group] of destinations) {
    const layer = project.layers.find((item) => item.id === layerId);
    if (!layer) throw new Error('Track no longer exists.');
    for (const placed of group) clips.get(placed.clip.id)!.layerId = layerId;
    if (layer.ripple) {
      sequences.set(layerId, rippleSequence(layer, remaining, group, before, move.delta, clips, anchors));
      continue;
    }
    for (const placed of group) {
      const clip = clips.get(placed.clip.id)!;
      clip.start = requireStart(placed.start + move.delta);
      positioned.push(clip);
    }
  }
  return {
    clips: assemble(remaining, sequences, positioned),
    layerIds: [...new Set([...moved.map((placed) => placed.clip.layerId), ...destinations.keys()])],
    anchors,
  };
}
