import type { ColourSettings } from './colour.js';
import {
  EMPTY_KEY_VALUES,
  KEYFRAME_SETTINGS,
  interpolationSchema,
  keySettings,
  layerKeyframeSchema,
  upsertKey,
  type Interpolation,
  type KeyframeSetting,
  type LayerKeyframe,
} from './keyframes.js';
import { compileLayerRetiming } from './layer-retiming.js';
import {
  clipSchema,
  frameSchema,
  idSchema,
  layerSchema,
  projectSchema,
  transitionSchema,
  type MusicTrack,
  type ProjectDocument,
  type Transition,
  type VideoClip,
  type VideoLayer,
} from './model.js';
import type { SpeedSettings } from './speed.js';
import { calculateLayout, layerClips, type TimelineLayout } from './timeline.js';

export type EditCommand =
  | { type: 'insert'; clip: VideoClip; index: number }
  | { type: 'delete'; clipId: string }
  | { type: 'reorder'; clipIds: string[] }
  | { type: 'trim'; clipId: string; sourceIn: number; sourceOut: number }
  | { type: 'trim-place'; clipId: string; sourceIn: number; sourceOut: number; start: number }
  | { type: 'split'; clipId: string; sourceFrame: number; newClipId: string }
  | { type: 'remove-source-range'; clipId: string; sourceIn: number; sourceOut: number; newClipId: string }
  | { type: 'duplicate'; clipId: string; newClipId: string }
  | { type: 'colour'; clipId: string; colour: ColourSettings }
  | { type: 'speed'; clipId: string; speed: SpeedSettings }
  | { type: 'music'; music: MusicTrack | null }
  | { type: 'opacity'; layerId: string; opacity: number }
  | { type: 'layer-key-toggle'; layerId: string; frame: number; setting: KeyframeSetting; value: number }
  | { type: 'layer-key-value'; layerId: string; frame: number; setting: KeyframeSetting; value: number }
  | { type: 'layer-key-move'; layerId: string; frame: number; nextFrame: number }
  | { type: 'layer-key-remove'; layerId: string; frame: number }
  | { type: 'layer-key-easing'; layerId: string; frame: number; interpolation: Interpolation }
  | { type: 'layer-add'; layer: VideoLayer }
  | { type: 'layer-update'; layer: VideoLayer }
  | { type: 'layer-remove'; layerId: string }
  | { type: 'layer-order'; layerIds: string[] }
  | { type: 'place'; clipId: string; layerId: string; start: number; index: number }
  | { type: 'transition'; transition: Transition }
  | { type: 'fades'; layerId: string; opening: number; closing: number };

function repairBoundaries(clips: VideoClip[], previous: Transition[]): Transition[] {
  return clips.slice(0, -1).map((clip, index) => {
    const rightId = clips[index + 1]!.id;
    return (
      previous.find((t) => t.leftId === clip.id && t.rightId === rightId) ?? {
        leftId: clip.id,
        rightId,
        type: 'cut',
        duration: 0,
      }
    );
  });
}

function requiredLayer(next: ProjectDocument, layerId: string): VideoLayer {
  const layer = next.layers.find((item) => item.id === layerId);
  if (!layer) throw new Error('Layer no longer exists.');
  return layer;
}

function repairLayerBoundaries(next: ProjectDocument, layerIds: readonly string[]): void {
  for (const layerId of new Set(layerIds)) {
    const layer = requiredLayer(next, layerId);
    layer.transitions = repairBoundaries(layerClips(next, layerId), layer.transitions);
  }
}

/** Structural edits retain the pre-edit first placement, not the new first
 * instance's former start. Only an explicit move of the retained first clip
 * changes a nonempty Ripple track's anchor. Empty tracks keep dormant fades. */
function preserveRippleAnchors(
  next: ProjectDocument,
  before: TimelineLayout,
  overrides: ReadonlyMap<string, number>,
): void {
  for (const layer of next.layers) {
    if (!layer.ripple) continue;
    const first = layerClips(next, layer.id)[0];
    if (!first) continue;
    const anchor = overrides.get(layer.id);
    const previous = before.clips.find((placed) => placed.clip.layerId === layer.id);
    if (anchor !== undefined) first.start = anchor;
    else if (previous) first.start = previous.start;
  }
}

function reorderClips(next: ProjectDocument, ids: string[]): void {
  if (ids.length !== next.clips.length || new Set(ids).size !== next.clips.length)
    throw new Error('Reorder must contain each clip exactly once.');
  next.clips = ids.map((id) => {
    const clip = next.clips.find((item) => item.id === id);
    if (!clip) throw new Error('Unknown clip in reorder.');
    return clip;
  });
  repairLayerBoundaries(
    next,
    next.layers.map((layer) => layer.id),
  );
}

function splitClip(next: ProjectDocument, index: number, command: Extract<EditCommand, { type: 'split' }>): void {
  const original = next.clips[index]!;
  if (
    !Number.isSafeInteger(command.sourceFrame) ||
    command.sourceFrame <= original.sourceIn ||
    command.sourceFrame >= original.sourceOut
  )
    throw new Error('Split must be strictly inside a clip.');
  const placed = calculateLayout(next).clips.find((item) => item.clip.id === original.id)!;
  const layer = next.layers.find((item) => item.id === original.layerId)!;
  const leftDuration = compileLayerRetiming(
    { ...original, sourceOut: command.sourceFrame },
    layer,
    placed.start,
  ).duration;
  const right = {
    ...original,
    id: command.newClipId,
    sourceIn: command.sourceFrame,
    colour: { ...original.colour },
    start: placed.start + leftDuration,
  };
  next.clips[index] = { ...original, sourceOut: command.sourceFrame, start: placed.start };
  layer.transitions = layer.transitions.map((t) => (t.leftId === original.id ? { ...t, leftId: right.id } : t));
  next.clips.splice(index + 1, 0, right);
  repairLayerBoundaries(next, [layer.id]);
}

function validateRemoval(clip: VideoClip, sourceIn: number, sourceOut: number): void {
  if (!Number.isSafeInteger(sourceIn) || !Number.isSafeInteger(sourceOut))
    throw new Error('Removal needs integer source frames.');
  if (sourceOut <= sourceIn)
    throw new Error('Removal OUT must be after IN (exclusive), removing at least one source frame.');
  if (sourceIn < clip.sourceIn || sourceOut > clip.sourceOut)
    throw new Error('The removed source range must stay within the selected clip.');
}

function retainedRightStart(project: ProjectDocument, clip: VideoClip, sourceIn: number): number {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clip.id)!;
  return placed.start + placed.retiming.outputAt(sourceIn);
}

/** Remove only original-source frames from one excerpt. Positioned cut boundaries
 * use its pre-edit contextual map; Ripple rejoins retained pieces at its anchor.
 * Other tracks, music and absolute row points stay put.
 * Retained durations are recompiled/rounded like mapped splits, not overridden
 * to force the old OUT. Final schema validation rejects any resulting conflict.
 */
function removeSourceRange(
  next: ProjectDocument,
  index: number,
  command: Extract<EditCommand, { type: 'remove-source-range' }>,
): void {
  const original = next.clips[index]!;
  const layer = requiredLayer(next, original.layerId);
  validateRemoval(original, command.sourceIn, command.sourceOut);
  if (command.sourceIn === original.sourceIn && command.sourceOut === original.sourceOut) {
    next.clips.splice(index, 1);
  } else if (command.sourceIn === original.sourceIn) {
    next.clips[index] = {
      ...original,
      sourceIn: command.sourceOut,
      start: retainedRightStart(next, original, command.sourceOut),
    };
  } else if (command.sourceOut === original.sourceOut) {
    next.clips[index] = { ...original, sourceOut: command.sourceIn };
  } else {
    if (!idSchema.safeParse(command.newClipId).success)
      throw new Error('The new excerpt needs a valid clip-instance ID.');
    if (next.clips.some((clip) => clip.id === command.newClipId))
      throw new Error('The new excerpt clip ID must be unused.');
    const right = {
      ...original,
      id: command.newClipId,
      sourceIn: command.sourceOut,
      start: retainedRightStart(next, original, command.sourceOut),
    };
    next.clips[index] = { ...original, sourceOut: command.sourceIn };
    next.clips.splice(index + 1, 0, right);
    layer.transitions = layer.transitions.map((transition) =>
      transition.leftId === original.id ? { ...transition, leftId: right.id } : transition,
    );
  }
  repairLayerBoundaries(next, [layer.id]);
}

function duplicateClip(next: ProjectDocument, index: number, newClipId: string): void {
  const original = next.clips[index]!;
  const placed = calculateLayout(next).clips.find((item) => item.clip.id === original.id)!;
  const duplicate = { ...original, id: newClipId, start: placed.end };
  next.clips.splice(index + 1, 0, duplicate);
  repairLayerBoundaries(next, [original.layerId]);
}

type LayerKeyCommand = Extract<
  EditCommand,
  { type: 'layer-key-toggle' | 'layer-key-value' | 'layer-key-move' | 'layer-key-remove' | 'layer-key-easing' }
>;
type LayerValueCommand = Extract<LayerKeyCommand, { type: 'layer-key-toggle' | 'layer-key-value' }>;
function editLayerValue(layer: VideoLayer, point: LayerKeyframe | undefined, command: LayerValueCommand): void {
  if (!KEYFRAME_SETTINGS.some((setting) => setting.key === command.setting))
    throw new Error('Unknown keyframe setting.');
  layerKeyframeSchema.shape.values.shape[command.setting].unwrap().parse(command.value);
  const current = point?.values[command.setting];
  if (command.type === 'layer-key-value') {
    if (current === undefined || current === null)
      throw new Error('The setting does not participate at this layer point.');
    point!.values[command.setting] = command.value;
    return;
  }
  const participating = current !== undefined && current !== null;
  const values = {
    ...(point ? point.values : EMPTY_KEY_VALUES),
    [command.setting]: participating ? null : command.value,
  };
  const changed = { frame: command.frame, interpolation: point ? point.interpolation : ('linear' as const), values };
  layer.keyframes = keySettings(changed).length
    ? upsertKey(layer.keyframes, changed)
    : layer.keyframes.filter((key) => key.frame !== command.frame);
}

function editLayerKey(next: ProjectDocument, command: LayerKeyCommand): void {
  const layer = next.layers.find((item) => item.id === command.layerId);
  if (!layer) throw new Error('Layer no longer exists.');
  frameSchema.parse(command.frame);
  const point = layer.keyframes.find((key) => key.frame === command.frame);
  if (command.type === 'layer-key-toggle' || command.type === 'layer-key-value') {
    editLayerValue(layer, point, command);
    return;
  }
  if (!point) throw new Error('Layer point no longer exists.');
  switch (command.type) {
    case 'layer-key-move':
      frameSchema.parse(command.nextFrame);
      if (layer.keyframes.some((key) => key !== point && key.frame === command.nextFrame))
        throw new Error('A shared layer point already exists at the destination frame.');
      layer.keyframes = upsertKey(
        layer.keyframes.filter((key) => key !== point),
        { ...point, frame: command.nextFrame },
      );
      break;
    case 'layer-key-remove':
      layer.keyframes = layer.keyframes.filter((key) => key !== point);
      break;
    case 'layer-key-easing':
      point.interpolation = interpolationSchema.parse(command.interpolation);
      break;
  }
}

type LayerCommand = Extract<EditCommand, { type: 'layer-add' | 'layer-update' | 'layer-remove' | 'layer-order' }>;
function updateLayer(next: ProjectDocument, updated: VideoLayer, before: TimelineLayout): void {
  const position = next.layers.findIndex((layer) => layer.id === updated.id);
  if (position < 0) throw new Error('Layer no longer exists.');
  const previous = next.layers[position]!;
  next.layers[position] = layerSchema.parse(updated);
  if (previous.ripple === updated.ripple) return;
  const placed = before.clips.filter((item) => item.clip.layerId === updated.id);
  // Both toggle directions snapshot actual integer placements. Enabling packs
  // this chronological order from its preserved first start in the final layout.
  for (const item of placed) next.clips.find((clip) => clip.id === item.clip.id)!.start = item.start;
  if (updated.ripple) {
    const ordered = placed.map((item) => next.clips.find((clip) => clip.id === item.clip.id)!);
    let cursor = 0;
    next.clips = next.clips.map((clip) => (clip.layerId === updated.id ? ordered[cursor++]! : clip));
  }
  repairLayerBoundaries(next, [updated.id]);
}

function editLayer(next: ProjectDocument, command: LayerCommand, before: TimelineLayout): void {
  switch (command.type) {
    case 'layer-add':
      next.layers.push(layerSchema.parse(command.layer));
      break;
    case 'layer-update':
      updateLayer(next, command.layer, before);
      break;
    case 'layer-remove':
      if (!next.layers.some((layer) => layer.id === command.layerId)) throw new Error('Layer no longer exists.');
      if (next.layers.length === 1) throw new Error('The last video track cannot be removed.');
      next.layers = next.layers.filter((layer) => layer.id !== command.layerId);
      next.clips = next.clips.filter((clip) => clip.layerId !== command.layerId);
      break;
    case 'layer-order':
      if (command.layerIds.length !== next.layers.length || new Set(command.layerIds).size !== next.layers.length)
        throw new Error('Layer order must contain each layer once.');
      next.layers = command.layerIds.map((id) => {
        const layer = next.layers.find((item) => item.id === id);
        if (!layer) throw new Error('Unknown layer.');
        return layer;
      });
      break;
  }
}

function placeClip(
  next: ProjectDocument,
  index: number,
  command: Extract<EditCommand, { type: 'place' }>,
  before: TimelineLayout,
  anchors: Map<string, number>,
): void {
  if (!Number.isInteger(command.index) || command.index < 0 || command.index >= next.clips.length)
    throw new Error('Invalid placement index.');
  frameSchema.parse(command.start);
  const target = requiredLayer(next, command.layerId);
  const clip = next.clips.splice(index, 1)[0]!;
  const sourceId = clip.layerId;
  clip.layerId = command.layerId;
  clip.start = command.start;
  // The placement index refers to the final array, after removing the instance.
  next.clips.splice(command.index, 0, clip);
  repairLayerBoundaries(next, [sourceId, target.id]);
  const previousFirst = before.clips.find((item) => item.clip.layerId === target.id);
  const first = layerClips(next, target.id)[0]!;
  if (target.ripple && sourceId === target.id && previousFirst?.clip.id === clip.id && first.id === clip.id)
    anchors.set(target.id, command.start);
}

function setTransition(next: ProjectDocument, value: Transition, before: TimelineLayout): void {
  const transition = transitionSchema.parse(value);
  const left = before.clips.find((item) => item.clip.id === transition.leftId);
  const right = before.clips.find((item) => item.clip.id === transition.rightId);
  if (!left || !right) throw new Error('Transition clips no longer exist.');
  if (left.clip.layerId !== right.clip.layerId) throw new Error('Transition must join clips on the same track.');
  const layer = requiredLayer(next, left.clip.layerId);
  const boundary = layer.transitions.findIndex(
    (t) => t.leftId === transition.leftId && t.rightId === transition.rightId,
  );
  if (boundary < 0) throw new Error('Transition is not between adjacent clips.');
  const previous = layer.transitions[boundary]!;
  if (transition.type !== 'cut' && previous.type !== 'cross-dissolve' && right.start !== left.end)
    throw new Error(
      'Non-cut transitions require touching clips or an existing dissolve; close the gap explicitly first.',
    );
  layer.transitions[boundary] = transition;
  if (!layer.ripple && (transition.type === 'cross-dissolve' || previous.type === 'cross-dissolve')) {
    next.clips.find((clip) => clip.id === right.clip.id)!.start =
      left.end - (transition.type === 'cross-dissolve' ? transition.duration : 0);
  }
}

function trimPlacedClip(
  next: ProjectDocument,
  index: number,
  command: Extract<EditCommand, { type: 'trim-place' }>,
  before: TimelineLayout,
  anchors: Map<string, number>,
): void {
  frameSchema.parse(command.start);
  const clip = next.clips[index]!;
  const layer = requiredLayer(next, clip.layerId);
  const first = before.clips.find((item) => item.clip.layerId === layer.id)!;
  if (layer.ripple && first.clip.id === clip.id) anchors.set(layer.id, command.start);
  next.clips[index] = { ...clip, sourceIn: command.sourceIn, sourceOut: command.sourceOut, start: command.start };
}

function normalizePlacements(next: ProjectDocument, command: EditCommand): void {
  const layout = calculateLayout(next);
  if (command.type === 'place' || command.type === 'trim-place') {
    const placed = layout.clips.find((item) => item.clip.id === command.clipId)!;
    if (requiredLayer(next, placed.clip.layerId).ripple && placed.start !== command.start)
      throw new Error(
        'Ripple is on: later clips follow the packed sequence. Choose an insertion slot, move the first clip, or turn Ripple off to set an independent start.',
      );
  }
  for (const placed of layout.clips) {
    if (requiredLayer(next, placed.clip.layerId).ripple) placed.clip.start = placed.start;
  }
}

export function applyCommand(document: ProjectDocument, command: EditCommand): ProjectDocument {
  const next = projectSchema.parse(document);
  // Keep the snapshot attached to the untouched committed document. In-place
  // moves of cloned clips must not change its original track/first-clip identity.
  const before = calculateLayout(document);
  const anchors = new Map<string, number>();
  const index = 'clipId' in command ? next.clips.findIndex((clip) => clip.id === command.clipId) : -1;
  if ('clipId' in command && index < 0) throw new Error('Clip no longer exists.');
  switch (command.type) {
    case 'insert':
      if (!Number.isInteger(command.index) || command.index < 0 || command.index > next.clips.length)
        throw new Error('Invalid insertion index.');
      next.clips.splice(command.index, 0, clipSchema.parse(command.clip));
      repairLayerBoundaries(next, [command.clip.layerId]);
      break;
    case 'delete': {
      const layerId = next.clips[index]!.layerId;
      next.clips.splice(index, 1);
      repairLayerBoundaries(next, [layerId]);
      break;
    }
    case 'reorder':
      reorderClips(next, command.clipIds);
      break;
    case 'trim':
      next.clips[index] = { ...next.clips[index]!, sourceIn: command.sourceIn, sourceOut: command.sourceOut };
      break;
    case 'trim-place':
      trimPlacedClip(next, index, command, before, anchors);
      break;
    case 'split':
      splitClip(next, index, command);
      break;
    case 'remove-source-range':
      removeSourceRange(next, index, command);
      break;
    case 'duplicate':
      duplicateClip(next, index, command.newClipId);
      break;
    case 'colour':
      next.clips[index] = { ...next.clips[index]!, colour: { ...command.colour } };
      break;
    case 'speed':
      next.clips[index] = { ...next.clips[index]!, speed: { ...command.speed } };
      break;
    case 'music':
      next.music = command.music;
      break;
    case 'opacity':
      requiredLayer(next, command.layerId).opacity = layerSchema.shape.opacity.parse(command.opacity);
      break;
    case 'layer-key-toggle':
    case 'layer-key-value':
    case 'layer-key-move':
    case 'layer-key-remove':
    case 'layer-key-easing':
      editLayerKey(next, command);
      break;
    case 'layer-add':
    case 'layer-update':
    case 'layer-remove':
    case 'layer-order':
      editLayer(next, command, before);
      break;
    case 'place':
      placeClip(next, index, command, before, anchors);
      break;
    case 'transition':
      setTransition(next, command.transition, before);
      break;
    case 'fades': {
      const layer = requiredLayer(next, command.layerId);
      layer.openingFade = command.opening;
      layer.closingFade = command.closing;
      break;
    }
    default:
      throw new Error('Unknown edit command.');
  }
  preserveRippleAnchors(next, before, anchors);
  // Persist the same derived integer starts used by preview/export, never stale
  // suffix snapshots. Validation is atomic; the caller's document is untouched.
  normalizePlacements(next, command);
  return projectSchema.parse(next);
}

export class EditHistory {
  #current: ProjectDocument;
  readonly #past: ProjectDocument[] = [];
  #future: ProjectDocument[] = [];
  constructor(document: ProjectDocument) {
    this.#current = projectSchema.parse(document);
  }
  get current(): ProjectDocument {
    return projectSchema.parse(this.#current);
  }
  get canUndo(): boolean {
    return this.#past.length > 0;
  }
  get canRedo(): boolean {
    return this.#future.length > 0;
  }
  commit(command: EditCommand): ProjectDocument {
    return this.replace(applyCommand(this.#current, command));
  }
  /** Batch insertions and a completed pointer gesture still produce one undo step. */
  replace(document: ProjectDocument): ProjectDocument {
    const next = projectSchema.parse(document);
    if (JSON.stringify(next) === JSON.stringify(this.#current)) return this.current;
    this.#past.push(this.#current);
    if (this.#past.length > 100) this.#past.shift();
    this.#current = next;
    this.#future = [];
    return this.current;
  }
  undo(): ProjectDocument {
    const previous = this.#past.pop();
    if (previous) {
      this.#future.push(this.#current);
      this.#current = previous;
    }
    return this.current;
  }
  redo(): ProjectDocument {
    const next = this.#future.pop();
    if (next) {
      this.#past.push(this.#current);
      this.#current = next;
    }
    return this.current;
  }
}
