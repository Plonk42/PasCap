import type { ColourSettings } from './colour.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, interpolationSchema, keySettings, layerKeyframeSchema, upsertKey, type Interpolation, type KeyframeSetting, type LayerKeyframe } from './keyframes.js';
import { compileLayerRetiming } from './layer-retiming.js';
import { frameSchema, idSchema, projectSchema, type MusicTrack, type ProjectDocument, type Transition, type VideoClip, type VideoLayer } from './model.js';
import type { SpeedSettings } from './speed.js';
import { calculateLayout, primaryClips } from './timeline.js';

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
  | { type: 'opacity'; clipId: string; opacity: number }
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
  | { type: 'fades'; opening: number; closing: number };

function repairBoundaries(clips: VideoClip[], previous: Transition[]): Transition[] {
  return clips.slice(0, -1).map((clip, index) => {
    const rightId = clips[index + 1]!.id;
    return previous.find((t) => t.leftId === clip.id && t.rightId === rightId) ?? { leftId: clip.id, rightId, type: 'cut', duration: 0 };
  });
}

function reorderClips(next: ProjectDocument, ids: string[]): void {
  if (ids.length !== next.clips.length || new Set(ids).size !== next.clips.length) throw new Error('Reorder must contain each clip exactly once.');
  next.clips = ids.map((id) => {
    const clip = next.clips.find((item) => item.id === id);
    if (!clip) throw new Error('Unknown clip in reorder.');
    return clip;
  });
  next.transitions = repairBoundaries(primaryClips(next), next.transitions);
}

function splitClip(next: ProjectDocument, index: number, command: Extract<EditCommand, { type: 'split' }>): void {
  const original = next.clips[index]!;
  if (!Number.isSafeInteger(command.sourceFrame) || command.sourceFrame <= original.sourceIn || command.sourceFrame >= original.sourceOut) throw new Error('Split must be strictly inside a clip.');
  const placed = calculateLayout(next).clips.find((item) => item.clip.id === original.id)!;
  const layer = next.layers.find((item) => item.id === original.layerId)!;
  const leftDuration = compileLayerRetiming({ ...original, sourceOut: command.sourceFrame }, layer, placed.start).duration;
  const right = { ...original, id: command.newClipId, sourceIn: command.sourceFrame, colour: { ...original.colour }, start: original.layerId === next.layers[0]!.id ? 0 : placed.start + leftDuration };
  next.clips[index] = { ...original, sourceOut: command.sourceFrame };
  const preserved = next.transitions.map((t) => t.leftId === original.id ? { ...t, leftId: right.id } : t);
  next.clips.splice(index + 1, 0, right);
  next.transitions = repairBoundaries(primaryClips(next), preserved);
}

function validateRemoval(clip: VideoClip, sourceIn: number, sourceOut: number): void {
  if (!Number.isSafeInteger(sourceIn) || !Number.isSafeInteger(sourceOut)) throw new Error('Removal needs integer source frames.');
  if (sourceOut <= sourceIn) throw new Error('Removal OUT must be after IN (exclusive), removing at least one source frame.');
  if (sourceIn < clip.sourceIn || sourceOut > clip.sourceOut) throw new Error('The removed source range must stay within the selected clip.');
}

function retainedRightStart(project: ProjectDocument, clip: VideoClip, sourceIn: number): number {
  if (clip.layerId === project.layers[0]!.id) return 0;
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clip.id)!;
  return placed.start + placed.retiming.outputAt(sourceIn);
}

/** Remove only original-source frames from one excerpt. Overlay cut boundaries
 * use its pre-edit contextual map; neighbours and absolute row points stay put.
 * Retained durations are recompiled/rounded like mapped splits, not overridden
 * to force the old OUT. Final schema validation rejects any resulting conflict.
 */
function removeSourceRange(next: ProjectDocument, index: number, command: Extract<EditCommand, { type: 'remove-source-range' }>): void {
  const original = next.clips[index]!;
  validateRemoval(original, command.sourceIn, command.sourceOut);
  if (command.sourceIn === original.sourceIn && command.sourceOut === original.sourceOut) {
    next.clips.splice(index, 1);
    if (!primaryClips(next).length) { next.openingFade = 0; next.closingFade = 0; }
  } else if (command.sourceIn === original.sourceIn) {
    next.clips[index] = { ...original, sourceIn: command.sourceOut, start: retainedRightStart(next, original, command.sourceOut) };
  } else if (command.sourceOut === original.sourceOut) {
    next.clips[index] = { ...original, sourceOut: command.sourceIn };
  } else {
    if (!idSchema.safeParse(command.newClipId).success) throw new Error('The new excerpt needs a valid clip-instance ID.');
    if (next.clips.some((clip) => clip.id === command.newClipId)) throw new Error('The new excerpt clip ID must be unused.');
    const right = { ...original, id: command.newClipId, sourceIn: command.sourceOut, start: retainedRightStart(next, original, command.sourceOut) };
    next.clips[index] = { ...original, sourceOut: command.sourceIn };
    next.clips.splice(index + 1, 0, right);
    next.transitions = next.transitions.map((transition) => transition.leftId === original.id ? { ...transition, leftId: right.id } : transition);
  }
  next.transitions = repairBoundaries(primaryClips(next), next.transitions);
}

function duplicateClip(next: ProjectDocument, index: number, newClipId: string): void {
  const original = next.clips[index]!;
  const placed = calculateLayout(next).clips.find((item) => item.clip.id === original.id)!;
  const duplicate = { ...original, id: newClipId, start: original.layerId === next.layers[0]!.id ? 0 : placed.end };
  next.clips.splice(index + 1, 0, duplicate);
  next.transitions = repairBoundaries(primaryClips(next), next.transitions);
}

type LayerKeyCommand = Extract<EditCommand, { type: 'layer-key-toggle' | 'layer-key-value' | 'layer-key-move' | 'layer-key-remove' | 'layer-key-easing' }>;
type LayerValueCommand = Extract<LayerKeyCommand, { type: 'layer-key-toggle' | 'layer-key-value' }>;
function editLayerValue(layer: VideoLayer, point: LayerKeyframe | undefined, command: LayerValueCommand): void {
  if (!KEYFRAME_SETTINGS.some((setting) => setting.key === command.setting)) throw new Error('Unknown keyframe setting.');
  layerKeyframeSchema.shape.values.shape[command.setting].unwrap().parse(command.value);
  const current = point?.values[command.setting];
  if (command.type === 'layer-key-value') {
    if (current === undefined || current === null) throw new Error('The setting does not participate at this layer point.');
    point!.values[command.setting] = command.value;
    return;
  }
  const participating = current !== undefined && current !== null;
  const values = { ...(point ? point.values : EMPTY_KEY_VALUES), [command.setting]: participating ? null : command.value };
  const changed = { frame: command.frame, interpolation: point ? point.interpolation : 'linear' as const, values };
  layer.keyframes = keySettings(changed).length ? upsertKey(layer.keyframes, changed) : layer.keyframes.filter((key) => key.frame !== command.frame);
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
      if (layer.keyframes.some((key) => key !== point && key.frame === command.nextFrame)) throw new Error('A shared layer point already exists at the destination frame.');
      layer.keyframes = upsertKey(layer.keyframes.filter((key) => key !== point), { ...point, frame: command.nextFrame });
      break;
    case 'layer-key-remove': layer.keyframes = layer.keyframes.filter((key) => key !== point); break;
    case 'layer-key-easing': point.interpolation = interpolationSchema.parse(command.interpolation); break;
  }
}

type LayerCommand = Extract<EditCommand, { type: 'layer-add' | 'layer-update' | 'layer-remove' | 'layer-order' }>;
function editLayer(next: ProjectDocument, command: LayerCommand): void {
  switch (command.type) {
    case 'layer-add': next.layers.push(command.layer); break;
    case 'layer-update': {
      const position = next.layers.findIndex((layer) => layer.id === command.layer.id);
      if (position < 0) throw new Error('Layer no longer exists.');
      next.layers[position] = command.layer;
      break;
    }
    case 'layer-remove':
      if (command.layerId === next.layers[0]!.id) throw new Error('The primary layer cannot be removed.');
      if (!next.layers.some((layer) => layer.id === command.layerId)) throw new Error('Layer no longer exists.');
      next.layers = next.layers.filter((layer) => layer.id !== command.layerId);
      next.clips = next.clips.filter((clip) => clip.layerId !== command.layerId);
      break;
    case 'layer-order':
      if (command.layerIds.length !== next.layers.length || new Set(command.layerIds).size !== next.layers.length) throw new Error('Layer order must contain each layer once.');
      next.layers = command.layerIds.map((id) => {
        const layer = next.layers.find((item) => item.id === id);
        if (!layer) throw new Error('Unknown layer.');
        return layer;
      });
      break;
  }
}

function placeClip(next: ProjectDocument, index: number, command: Extract<EditCommand, { type: 'place' }>): void {
  if (!Number.isInteger(command.index) || command.index < 0 || command.index >= next.clips.length) throw new Error('Invalid placement index.');
  const clip = next.clips.splice(index, 1)[0]!;
  clip.layerId = command.layerId; clip.start = command.start;
  // The placement index refers to the final array, after removing the instance.
  next.clips.splice(command.index, 0, clip);
  next.transitions = repairBoundaries(primaryClips(next), next.transitions);
  if (!primaryClips(next).length) { next.openingFade = 0; next.closingFade = 0; }
}

function setTransition(next: ProjectDocument, transition: Transition): void {
  const boundary = next.transitions.findIndex((t) => t.leftId === transition.leftId && t.rightId === transition.rightId);
  if (boundary < 0) throw new Error('Transition is not between adjacent clips.');
  next.transitions[boundary] = transition;
}

export function applyCommand(document: ProjectDocument, command: EditCommand): ProjectDocument {
  const next = projectSchema.parse(document);
  const index = 'clipId' in command ? next.clips.findIndex((clip) => clip.id === command.clipId) : -1;
  if ('clipId' in command && index < 0) throw new Error('Clip no longer exists.');
  switch (command.type) {
    case 'insert':
      if (!Number.isInteger(command.index) || command.index < 0 || command.index > next.clips.length) throw new Error('Invalid insertion index.');
      next.clips.splice(command.index, 0, command.clip);
      next.transitions = repairBoundaries(primaryClips(next), next.transitions);
      break;
    case 'delete':
      next.clips.splice(index, 1);
      next.transitions = repairBoundaries(primaryClips(next), next.transitions);
      if (primaryClips(next).length === 0) { next.openingFade = 0; next.closingFade = 0; }
      break;
    case 'reorder': reorderClips(next, command.clipIds); break;
    case 'trim':
      next.clips[index] = { ...next.clips[index]!, sourceIn: command.sourceIn, sourceOut: command.sourceOut };
      break;
    case 'trim-place': next.clips[index] = { ...next.clips[index]!, sourceIn: command.sourceIn, sourceOut: command.sourceOut, start: command.start }; break;
    case 'split': splitClip(next, index, command); break;
    case 'remove-source-range': removeSourceRange(next, index, command); break;
    case 'duplicate': duplicateClip(next, index, command.newClipId); break;
    case 'colour': next.clips[index] = { ...next.clips[index]!, colour: { ...command.colour } }; break;
    case 'speed': next.clips[index] = { ...next.clips[index]!, speed: { ...command.speed } }; break;
    case 'music': next.music = command.music; break;
    case 'opacity': next.clips[index] = { ...next.clips[index]!, opacity: command.opacity }; break;
    case 'layer-key-toggle':
    case 'layer-key-value':
    case 'layer-key-move':
    case 'layer-key-remove':
    case 'layer-key-easing': editLayerKey(next, command); break;
    case 'layer-add':
    case 'layer-update':
    case 'layer-remove':
    case 'layer-order': editLayer(next, command); break;
    case 'place': placeClip(next, index, command); break;
    case 'transition': setTransition(next, command.transition); break;
    case 'fades': next.openingFade = command.opening; next.closingFade = command.closing; break;
    default: throw new Error('Unknown edit command.');
  }
  // Validation runs after, but no mutation has touched the caller's committed document.
  return projectSchema.parse(next);
}

export class EditHistory {
  #current: ProjectDocument;
  readonly #past: ProjectDocument[] = [];
  #future: ProjectDocument[] = [];
  constructor(document: ProjectDocument) { this.#current = projectSchema.parse(document); }
  get current(): ProjectDocument { return projectSchema.parse(this.#current); }
  get canUndo(): boolean { return this.#past.length > 0; }
  get canRedo(): boolean { return this.#future.length > 0; }
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
    if (previous) { this.#future.push(this.#current); this.#current = previous; }
    return this.current;
  }
  redo(): ProjectDocument {
    const next = this.#future.pop();
    if (next) { this.#past.push(this.#current); this.#current = next; }
    return this.current;
  }
}