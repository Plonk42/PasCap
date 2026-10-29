import { arrangeClipGroup } from './clip-group.js';
import type { EditCommand } from './command-schema.js';
import {
  defaultKeyframe,
  EMPTY_KEY_VALUES,
  interpolationSchema,
  KEYFRAME_SETTINGS,
  joiningEasing,
  keySettings,
  layerKeyframe,
  layerKeyframeSchema,
  upsertKey,
  withEasing,
  type Interpolation,
  type KeyframeSetting,
  type LayerKeyframe,
} from './keyframes.js';
import {
  clipSchema,
  createLayer,
  frameSchema,
  idSchema,
  layerSchema,
  MAX_BOOKMARKS,
  MAX_SELECTS,
  orderedSelectRanges,
  projectSchema,
  selectRangeSchema,
  transitionSchema,
  type ProjectDocument,
  type Transition,
  type VideoClip,
  type VideoLayer,
} from './model.js';
import { detailSchema } from './detail.js';
import {
  createAdjustment,
  createClipGrade,
  GRADE_SETTINGS,
  gradeKeyAsLayerKey,
  gradeKeyValuesPatchSchema,
  layerKeyAsGradeKey,
  MAX_ADJUSTMENTS,
  MAX_GRADE_KEYFRAMES,
  type Adjustment,
} from './grade.js';
import { colourCurveSchema, hslBandSchema } from './advanced-colour.js';
import { colourSchema, type ColourSettings, type ScalarColourSetting } from './colour.js';
import { spatialPoseSchema, spatialSettingsSchema } from './spatial.js';
import { clipDuration } from './speed.js';
import { trimByOutputFrames } from './source-range.js';
import { calculateLayout, layerClips, transitionOffset, type TimelineLayout } from './timeline.js';

const MAX_FRAME = 2_147_483_647;

export { editCommandSchema, type EditCommand } from './command-schema.js';

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
  if (!layer) throw new Error('Track no longer exists.');
  return layer;
}

/** The Colour and keyframes a command changes: a clip's grade or an adjustment, in the track keyframe shape. */
interface ColourOwner {
  kind: 'clip' | 'adjustment';
  name: string;
  colour: ColourSettings;
  keyframes: LayerKeyframe[];
}

/** A command's target: a clip's grade (clipId) or an adjustment (adjustmentId); exactly one is given. */
type ColourTargetFields = Partial<Record<'clipId' | 'adjustmentId', string | undefined>>;

function colourOwner(next: ProjectDocument, command: ColourTargetFields): { owner: ColourOwner; save: () => void } {
  if ((command.clipId === undefined) === (command.adjustmentId === undefined))
    throw new Error("Give either clipId, for a clip's own grade, or adjustmentId, for an adjustment.");
  const target =
    command.clipId === undefined
      ? requiredAdjustment(next, command.adjustmentId!)
      : next.clips.find((item) => item.id === command.clipId)?.grade;
  if (!target) throw new Error('Clip no longer exists.');
  const owner: ColourOwner = {
    kind: command.clipId === undefined ? 'adjustment' : 'clip',
    name: command.clipId === undefined ? `adjustment ${command.adjustmentId}` : `clip ${command.clipId}`,
    colour: target.colour,
    keyframes: target.keyframes.map(gradeKeyAsLayerKey),
  };
  return {
    owner,
    save: () => {
      if (owner.keyframes.some((key) => key.values.opacity !== null))
        throw new Error('Opacity belongs to the track Transform, not to a grade.');
      target.colour = owner.colour;
      target.keyframes = owner.keyframes.map(layerKeyAsGradeKey);
    },
  };
}

function requiredAdjustment(next: ProjectDocument, adjustmentId: string): Adjustment {
  const item = next.adjustments.find((candidate) => candidate.id === adjustmentId);
  if (!item) throw new Error('Adjustment no longer exists.');
  return item;
}

function maxKeyframes(_owner: ColourOwner): number {
  return MAX_GRADE_KEYFRAMES;
}

function followsKeyframes(name: string, setting: string, keys: number, list: string): void {
  if (keys)
    throw new Error(
      `${setting} follows ${keys} ${list} keyframe${keys === 1 ? '' : 's'} on ${name}, so its base value is not used; change ${keys === 1 ? 'that keyframe' : 'those keyframes'} instead.`,
    );
}

type ColourSettingCommand = Extract<EditCommand, { type: 'colour-setting' | 'hsl-band' | 'colour-curve' }>;

/** Changes one Colour setting of a track or a clip's grade, keeping every other one as saved. */
function editColourSetting(owner: ColourOwner, command: ColourSettingCommand): void {
  const { colour } = owner;
  switch (command.type) {
    case 'colour-setting':
      followsKeyframes(owner.name, command.setting, keyCount(owner.keyframes, command.setting), owner.kind);
      owner.colour = { ...colour, [command.setting]: colourSchema.shape[command.setting].parse(command.value) };
      break;
    case 'hsl-band':
      owner.colour = { ...colour, hsl: { ...colour.hsl, [command.band]: hslBandSchema.parse(command.values) } };
      break;
    case 'colour-curve': {
      const points = colourCurveSchema.parse(command.points).map((point) => ({ ...point }));
      owner.colour = { ...colour, curves: { ...colour.curves, [command.channel]: points } };
      break;
    }
  }
}

function editTransformSetting(layer: VideoLayer, command: Extract<EditCommand, { type: 'transform-setting' }>): void {
  const { transform } = layer;
  followsKeyframes(layer.name, command.setting, keyCount(transform.keyframes, command.setting), 'Transform');
  layer.transform = {
    ...transform,
    base: { ...transform.base, [command.setting]: spatialPoseSchema.shape[command.setting].parse(command.value) },
  };
}

/** The same Colour on each listed clip's grade, or on an adjustment, keeping their keyframes. */
function setColour(next: ProjectDocument, command: Extract<EditCommand, { type: 'colour' }>): void {
  const colour = colourSchema.parse(command.colour);
  if ((command.adjustmentId === undefined) === (command.clipIds === undefined))
    throw new Error("Give either clipIds, for clips' own grades, or adjustmentId, for an adjustment.");
  if (command.adjustmentId !== undefined) {
    requiredAdjustment(next, command.adjustmentId).colour = structuredClone(colour);
    return;
  }
  const ids = new Set(command.clipIds);
  if (ids.size !== command.clipIds!.length) throw new Error('List each clip once.');
  const missing = command.clipIds!.find((id) => !next.clips.some((clip) => clip.id === id));
  if (missing !== undefined) throw new Error(`Clip ${missing} no longer exists.`);
  for (const clip of next.clips) if (ids.has(clip.id)) clip.grade = { ...clip.grade, colour: structuredClone(colour) };
}

function keyCount<K extends string>(keyframes: readonly { values: Record<K, number | null> }[], setting: K): number {
  return keyframes.filter((key) => key.values[setting] !== null).length;
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

/** `sourceFrame` is the source boundary; a reversed clip keeps its higher frames first. */
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
  const lower = { sourceIn: original.sourceIn, sourceOut: command.sourceFrame };
  const upper = { sourceIn: command.sourceFrame, sourceOut: original.sourceOut };
  const [first, second] = original.reverse ? [upper, lower] : [lower, upper];
  const leftDuration = clipDuration({ ...original, ...first });
  const right = {
    ...original,
    ...second,
    id: command.newClipId,
    start: placed.start + leftDuration,
  };
  next.clips[index] = { ...original, ...first, start: placed.start };
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

/** Where the retained piece after the removal starts: the first output frame of its first image.
 * Reversed, outputAt is the last frame showing a source frame, so the next one shows the frame below. */
function retainedRightStart(
  project: ProjectDocument,
  clip: VideoClip,
  removed: { sourceIn: number; sourceOut: number },
): number {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clip.id)!;
  return (
    placed.start +
    (clip.reverse ? placed.retiming.outputAt(removed.sourceIn) + 1 : placed.retiming.outputAt(removed.sourceOut))
  );
}

/** Remove only original-source frames from one excerpt. Positioned cut boundaries
 * use its pre-edit contextual map; Ripple rejoins retained pieces at its anchor.
 * Other tracks, music and absolute row points stay put. A reversed clip keeps
 * its higher source frames as the left piece.
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
  const lower =
    command.sourceIn === original.sourceIn ? null : { sourceIn: original.sourceIn, sourceOut: command.sourceIn };
  const upper =
    command.sourceOut === original.sourceOut ? null : { sourceIn: command.sourceOut, sourceOut: original.sourceOut };
  const [left, right] = original.reverse ? [upper, lower] : [lower, upper];
  const rightStart = (): number => retainedRightStart(next, original, command);
  if (!left && !right) {
    next.clips.splice(index, 1);
  } else if (!left) {
    next.clips[index] = { ...original, ...right!, start: rightStart() };
  } else if (!right) {
    next.clips[index] = { ...original, ...left };
  } else {
    if (!idSchema.safeParse(command.newClipId).success) throw new Error('The new clip needs a valid clip-instance ID.');
    if (next.clips.some((clip) => clip.id === command.newClipId)) throw new Error('The new clip ID must be unused.');
    const piece = { ...original, ...right, id: command.newClipId, start: rightStart() };
    next.clips[index] = { ...original, ...left };
    next.clips.splice(index + 1, 0, piece);
    layer.transitions = layer.transitions.map((transition) =>
      transition.leftId === original.id ? { ...transition, leftId: piece.id } : transition,
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
  {
    type:
      | 'layer-key-toggle'
      | 'layer-key-value'
      | 'layer-key-move'
      | 'layer-key-remove'
      | 'layer-key-easing'
      | 'layer-key-default';
  }
>;
type LayerValueCommand = Extract<LayerKeyCommand, { type: 'layer-key-toggle' | 'layer-key-value' }>;
function editLayerValue(layer: ColourOwner, point: LayerKeyframe | undefined, command: LayerValueCommand): void {
  if (!GRADE_SETTINGS.includes(command.setting as ScalarColourSetting)) throw new Error('Unknown keyframe setting.');
  layerKeyframeSchema.shape.values.shape[command.setting].unwrap().parse(command.value);
  const current = point?.values[command.setting];
  if (command.type === 'layer-key-value') {
    if (current === undefined || current === null)
      throw new Error(`The setting is not enabled at this ${layer.kind} keyframe.`);
    point!.values[command.setting] = command.value;
    return;
  }
  const participating = current !== undefined && current !== null;
  if (!point && layer.keyframes.length >= maxKeyframes(layer)) throw keyframeLimit(layer);
  const base = point ?? layerKeyframe(command.frame, EMPTY_KEY_VALUES, 'linear');
  const curve = point
    ? joiningEasing(
        layer.keyframes,
        point,
        KEYFRAME_SETTINGS.map((setting) => setting.key),
      )
    : 'linear';
  const changed = {
    frame: command.frame,
    values: { ...base.values, [command.setting]: participating ? null : command.value },
    easing: { ...base.easing, [command.setting]: participating ? null : curve },
    reset: base.reset,
  };
  layer.keyframes = keySettings(changed).length
    ? upsertKey(layer.keyframes, changed)
    : layer.keyframes.filter((key) => key.frame !== command.frame);
}

type LayerKeySet = Extract<EditCommand, { type: 'layer-key-set' }>;

/** Each listed setting's new value and Easing; the others keep theirs. */
function patchKeySettings(
  base: LayerKeyframe,
  patch: { [K in KeyframeSetting]?: number | null | undefined },
  easing: Interpolation | Partial<Record<KeyframeSetting, Interpolation>> | undefined,
  joining: Interpolation,
): Pick<LayerKeyframe, 'values' | 'easing'> {
  const values = { ...base.values };
  const curves: Record<KeyframeSetting, Interpolation | null> = { ...base.easing };
  for (const [setting, value] of Object.entries(patch) as [KeyframeSetting, number | null | undefined][]) {
    if (value === undefined) continue;
    const keyed = values[setting] !== null;
    values[setting] = value;
    if (value === null) curves[setting] = null;
    else if (typeof easing === 'string') curves[setting] = easing;
    else if (!keyed) curves[setting] = joining;
  }
  if (typeof easing !== 'object') return { values, easing: curves };
  for (const [setting, curve] of Object.entries(easing) as [KeyframeSetting, Interpolation][]) {
    if (values[setting] === null) throw new Error(`${setting} is not keyed at this keyframe, so it has no Easing.`);
    curves[setting] = curve;
  }
  return { values, easing: curves };
}

function keyframeLimit(owner: ColourOwner): Error {
  const what = owner.kind === 'clip' ? 'This clip' : 'This adjustment';
  return new Error(`${what} already has ${maxKeyframes(owner)} keyframes. Change one of them, or remove one.`);
}

/** A grade frame: a source frame of a clip, or a frame counted from an adjustment's start, which may be negative. */
function requireGradeFrame(frame: number): void {
  if (!Number.isInteger(frame) || Math.abs(frame) > MAX_FRAME) throw new Error('Keyframe frames are whole frames.');
}

function gradeEasingPatch(
  easing: Interpolation | Partial<Record<string, Interpolation>>,
): Interpolation | Partial<Record<ScalarColourSetting, Interpolation>> {
  if (typeof easing === 'string') return interpolationSchema.parse(easing);
  for (const [setting, curve] of Object.entries(easing)) {
    if (!GRADE_SETTINGS.includes(setting as ScalarColourSetting)) throw new Error(`Unknown setting ${setting}.`);
    interpolationSchema.parse(curve);
  }
  return easing as Partial<Record<ScalarColourSetting, Interpolation>>;
}

/** Keys, changes or disables several settings of one keyframe at once, like their toggles together. */
function setLayerKey(layer: ColourOwner, command: LayerKeySet): void {
  requireGradeFrame(command.frame);
  const patch = gradeKeyValuesPatchSchema.parse(command.values);
  const easing = command.easing === undefined ? undefined : gradeEasingPatch(command.easing);
  if (command.reset !== undefined && typeof command.reset !== 'boolean')
    throw new Error('Reset must be true or false.');
  const point = layer.keyframes.find((key) => key.frame === command.frame);
  if (!point && layer.keyframes.length >= maxKeyframes(layer)) throw keyframeLimit(layer);
  const order = KEYFRAME_SETTINGS.map((setting) => setting.key);
  const base = point ?? layerKeyframe(command.frame, EMPTY_KEY_VALUES, 'linear');
  const joining = point ? joiningEasing(layer.keyframes, point, order) : 'linear';
  const changed = {
    frame: command.frame,
    ...patchKeySettings(base, patch, easing, joining),
    reset: command.reset ?? base.reset,
  };
  layer.keyframes = keySettings(changed).length
    ? upsertKey(layer.keyframes, changed)
    : layer.keyframes.filter((key) => key.frame !== command.frame);
}

/** Adds a default keyframe at `frame`, or removes the one there; a grade's has no Opacity. */
function toggleDefaultKey(layer: ColourOwner, point: LayerKeyframe | undefined, frame: number): void {
  if (point && !point.reset)
    throw new Error('A keyframe already exists at this frame. Choose another frame for a default keyframe.');
  if (point) {
    layer.keyframes = layer.keyframes.filter((key) => key !== point);
    return;
  }
  if (layer.keyframes.length >= maxKeyframes(layer)) throw keyframeLimit(layer);
  const added = { ...defaultKeyframe(frame) };
  added.values = { ...added.values, opacity: null };
  added.easing = { ...added.easing, opacity: null };
  layer.keyframes = upsertKey(layer.keyframes, added);
}

function moveLayerKey(layer: ColourOwner, point: LayerKeyframe, nextFrame: number): void {
  requireGradeFrame(nextFrame);
  if (layer.keyframes.some((key) => key !== point && key.frame === nextFrame))
    throw new Error(
      `${layer.kind === 'clip' ? 'A clip grade' : 'An adjustment'} keyframe already exists at the destination frame.`,
    );
  layer.keyframes = upsertKey(
    layer.keyframes.filter((key) => key !== point),
    { ...point, frame: nextFrame },
  );
}

function editLayerKey(layer: ColourOwner, command: LayerKeyCommand): void {
  requireGradeFrame(command.frame);
  const point = layer.keyframes.find((key) => key.frame === command.frame);
  if (command.type === 'layer-key-toggle' || command.type === 'layer-key-value') {
    editLayerValue(layer, point, command);
    return;
  }
  if (command.type === 'layer-key-default') {
    toggleDefaultKey(layer, point, command.frame);
    return;
  }
  if (!point) throw new Error(`${layer.kind === 'clip' ? 'Clip grade' : 'Adjustment'} keyframe no longer exists.`);
  switch (command.type) {
    case 'layer-key-move':
      moveLayerKey(layer, point, command.nextFrame);
      break;
    case 'layer-key-remove':
      layer.keyframes = layer.keyframes.filter((key) => key !== point);
      break;
    case 'layer-key-easing':
      if (command.setting !== null && !GRADE_SETTINGS.includes(command.setting))
        throw new Error('Unknown keyframe setting.');
      point.easing = withEasing<KeyframeSetting>(point, command.setting, command.interpolation);
      break;
  }
}

type LayerCommand = Extract<
  EditCommand,
  { type: 'layer-add' | 'layer-create' | 'layer-update' | 'layer-options' | 'layer-remove' | 'layer-order' }
>;
function updateLayer(next: ProjectDocument, updated: VideoLayer, before: TimelineLayout): void {
  const position = next.layers.findIndex((layer) => layer.id === updated.id);
  if (position < 0) throw new Error('Track no longer exists.');
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
    case 'layer-create':
      next.layers.push(createLayer(command.layerId, command.name));
      break;
    case 'layer-update':
      updateLayer(next, command.layer, before);
      break;
    case 'layer-options': {
      const layer = next.layers.find((item) => item.id === command.layerId);
      if (!layer) throw new Error('Track no longer exists.');
      const { name = layer.name, enabled = layer.enabled, ripple = layer.ripple } = command;
      updateLayer(next, { ...layer, name, enabled, ripple }, before);
      break;
    }
    case 'layer-remove':
      if (!next.layers.some((layer) => layer.id === command.layerId)) throw new Error('Track no longer exists.');
      if (next.layers.length === 1) throw new Error('The last video track cannot be removed.');
      next.layers = next.layers.filter((layer) => layer.id !== command.layerId);
      next.clips = next.clips.filter((clip) => clip.layerId !== command.layerId);
      break;
    case 'layer-order':
      if (command.layerIds.length !== next.layers.length || new Set(command.layerIds).size !== next.layers.length)
        throw new Error('Track order must contain each track once.');
      next.layers = command.layerIds.map((id) => {
        const layer = next.layers.find((item) => item.id === id);
        if (!layer) throw new Error('Unknown track.');
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
  if (transition.type !== 'cut' && transitionOffset(previous) === 0 && right.start !== left.end)
    throw new Error(
      'Non-cut transitions require touching clips or an existing dissolve; close the gap explicitly first.',
    );
  layer.transitions[boundary] = transition;
  if (!layer.ripple && (transitionOffset(transition) !== 0 || transitionOffset(previous) !== 0)) {
    next.clips.find((clip) => clip.id === right.clip.id)!.start = left.end + transitionOffset(transition);
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

type BookmarkCommand = Extract<EditCommand, { type: 'bookmark-add' | 'bookmark-move' | 'bookmark-remove' }>;
/** Bookmarks never merge: an occupied frame rejects the whole edit. */
function editBookmark(next: ProjectDocument, command: BookmarkCommand): void {
  frameSchema.parse(command.frame);
  const exists = next.bookmarks.includes(command.frame);
  if (command.type === 'bookmark-add') {
    if (exists) throw new Error('A bookmark already exists at this frame.');
    if (next.bookmarks.length >= MAX_BOOKMARKS)
      throw new Error(`A project holds at most ${MAX_BOOKMARKS.toLocaleString('en')} bookmarks.`);
    next.bookmarks = [...next.bookmarks, command.frame].sort((left, right) => left - right);
    return;
  }
  if (!exists) throw new Error('Bookmark no longer exists.');
  const others = next.bookmarks.filter((frame) => frame !== command.frame);
  if (command.type === 'bookmark-remove') {
    next.bookmarks = others;
    return;
  }
  frameSchema.parse(command.nextFrame);
  if (others.includes(command.nextFrame)) throw new Error('A bookmark already exists at the destination frame.');
  next.bookmarks = [...others, command.nextFrame].sort((left, right) => left - right);
}

type SelectCommand = Extract<EditCommand, { type: 'select-set' | 'select-narrow' }>;
/** Selects only record what the user keeps; they never retime, render or move a clip. */
function editSelects(next: ProjectDocument, command: SelectCommand): void {
  const mediaId = idSchema.parse(command.mediaId);
  const inBin = next.media.videoIds.includes(mediaId);
  if (!inBin && !next.clips.some((clip) => clip.mediaId === mediaId))
    throw new Error('Kept ranges need a recording that belongs to this project.');
  const ranges = command.ranges.map((range) => ({ ...selectRangeSchema.parse(range) }));
  if (ranges.length > MAX_SELECTS)
    throw new Error(`A recording keeps at most ${MAX_SELECTS.toLocaleString('en')} ranges.`);
  if (!orderedSelectRanges(ranges))
    throw new Error('Kept ranges must be ascending and separated by at least one frame.');
  const { [mediaId]: previous, ...others } = next.selects;
  if (command.type === 'select-narrow') {
    if (!ranges.length) throw new Error('Narrowing needs at least one range; remove the recording instead.');
    const outside = ranges.some(
      (range) =>
        previous !== undefined &&
        !previous.some((kept) => range.sourceIn >= kept.sourceIn && range.sourceOut <= kept.sourceOut),
    );
    if (outside) throw new Error('Narrowing can only keep frames that are already kept.');
  }
  if (!inBin) next.media.videoIds = [...next.media.videoIds, mediaId];
  next.selects = ranges.length ? { ...others, [mediaId]: ranges } : others;
}

/** Frames the two clips of a transition overlap. */
function overlapOf(transition: Transition): number {
  return Math.max(0, -transitionOffset(transition));
}

/**
 * Sets a transition on a Ripple track keeping its perceived change and every later clip in place: a longer
 * overlap lengthens the left clip's end and the right clip's start by half of it each, a shorter one trims
 * them back. The recordings' lengths and kept ranges are checked when the edit is saved.
 */
function keepCutTransition(document: ProjectDocument, value: Transition): ProjectDocument {
  const transition = transitionSchema.parse(value);
  const left = document.clips.find((clip) => clip.id === transition.leftId);
  const right = document.clips.find((clip) => clip.id === transition.rightId);
  if (!left || !right) throw new Error('Transition clips no longer exist.');
  const layer = requiredLayer(document, left.layerId);
  if (!layer.ripple)
    throw new Error(
      'Keeping the cut in place needs Ripple: without it a dissolve already leaves later clips where they are.',
    );
  const previous = layer.transitions.find((t) => t.leftId === left.id && t.rightId === right.id);
  if (!previous) throw new Error('Transition is not between adjacent clips.');
  const change = overlapOf(transition) - overlapOf(previous);
  const toLeft = Math.floor(change / 2);
  const toRight = change - toLeft;
  const trims = (project: ProjectDocument): ProjectDocument => {
    const clip = (id: string) => project.clips.find((item) => item.id === id)!;
    // The displayed end and start: a reversed clip shows its source OUT first.
    const lengthenEnd = (item: VideoClip, frames: number) =>
      trimByOutputFrames(item, item.reverse ? 'in' : 'out', item.reverse ? -frames : frames, MAX_FRAME);
    const lengthenStart = (item: VideoClip, frames: number) =>
      trimByOutputFrames(item, item.reverse ? 'out' : 'in', item.reverse ? frames : -frames, MAX_FRAME);
    const widened = applyCommand(project, lengthenStart(clip(right.id), toRight));
    return applyCommand(widened, lengthenEnd(clip(left.id), toLeft));
  };
  const command = { type: 'transition', transition } as const;
  // Lengthen before a longer overlap and shorten after a shorter one, so every step is a valid project.
  const result = change >= 0 ? applyCommand(trims(document), command) : trims(applyCommand(document, command));
  const endOf = (project: ProjectDocument) =>
    calculateLayout(project).clips.find((item) => item.clip.id === right.id)!.end;
  // A trim stops at the recording's first or last frame; speed curves may round by one frame.
  if (Math.abs(endOf(result) - endOf(document)) > 1)
    throw new Error('The recordings have no footage to keep the cut in place with this overlap.');
  return result;
}

/** The same detail filters on every listed clip, or none of them. */
function setClipsDetail(next: ProjectDocument, clipIds: readonly string[], value: VideoClip['detail']): void {
  const detail = detailSchema.parse(value);
  const ids = new Set(clipIds);
  if (ids.size !== clipIds.length) throw new Error('List each clip once.');
  const missing = clipIds.find((id) => !next.clips.some((clip) => clip.id === id));
  if (missing !== undefined) throw new Error(`Clip ${missing} no longer exists.`);
  next.clips = next.clips.map((clip) => (ids.has(clip.id) ? { ...clip, detail: { ...detail } } : clip));
}

/** Integer project frames for an adjustment: never before 0, its OUT within the supported range. */
function adjustmentRange(start: number, duration: number): void {
  frameSchema.parse(start);
  if (!Number.isInteger(duration) || duration < 1) throw new Error('An adjustment lasts at least one frame.');
  if (start + duration > MAX_FRAME) throw new Error('Adjustment OUT exceeds the supported integer project-frame range.');
}

function overlappingAdjustment(items: readonly Adjustment[], start: number, duration: number, except?: string) {
  return items.find(
    (item) => item.id !== except && item.start < start + duration && start < item.start + item.duration,
  );
}

function editAdjustment(
  next: ProjectDocument,
  command: Extract<EditCommand, { type: 'adjustment-add' | 'adjustment-remove' | 'adjustment-range' }>,
): void {
  if (command.type === 'adjustment-remove') {
    requiredAdjustment(next, command.adjustmentId);
    next.adjustments = next.adjustments.filter((item) => item.id !== command.adjustmentId);
    return;
  }
  adjustmentRange(command.start, command.duration);
  const except = command.type === 'adjustment-range' ? command.adjustmentId : undefined;
  const overlap = overlappingAdjustment(next.adjustments, command.start, command.duration, except);
  if (overlap)
    throw new Error(
      `Adjustments cannot overlap: frames ${overlap.start}–${overlap.start + overlap.duration - 1} already have one.`,
    );
  if (command.type === 'adjustment-add') {
    if (next.adjustments.some((item) => item.id === command.adjustmentId))
      throw new Error('An adjustment with this ID already exists.');
    if (next.adjustments.length >= MAX_ADJUSTMENTS)
      throw new Error(`A project has at most ${MAX_ADJUSTMENTS} adjustments. Remove one first.`);
    next.adjustments.push(createAdjustment(command.adjustmentId, command.start, command.duration));
  } else {
    const item = requiredAdjustment(next, command.adjustmentId);
    if (command.keyframes !== 'move' && command.keyframes !== 'stay')
      throw new Error('Keyframes must move with the adjustment or stay at their project frames.');
    // Staying keyframes keep their project frame: their offset changes by the start's change.
    const shift = command.keyframes === 'stay' ? item.start - command.start : 0;
    item.keyframes = item.keyframes.map((key) => ({ ...key, frame: key.frame + shift }));
    item.start = command.start;
    item.duration = command.duration;
  }
  next.adjustments.sort((left, right) => left.start - right.start);
}

export function applyCommand(document: ProjectDocument, command: EditCommand): ProjectDocument {
  if (command.type === 'transition' && command.keepCut) return keepCutTransition(document, command.transition);
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
      next.clips.splice(command.index, 0, clipSchema.parse({ grade: createClipGrade(), ...command.clip }));
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
      setColour(next, command);
      return projectSchema.parse(next);
    case 'speed':
      next.clips[index] = { ...next.clips[index]!, speed: { ...command.speed } };
      break;
    case 'reverse':
      if (typeof command.reverse !== 'boolean') throw new Error('Reverse must be on or off.');
      // Direction never changes duration or placement.
      next.clips[index] = { ...next.clips[index]!, reverse: command.reverse };
      return projectSchema.parse(next);
    case 'transform':
      requiredLayer(next, command.layerId).transform = spatialSettingsSchema.parse(command.transform);
      // Appearance-only replacement must not normalize or rewrite stored timing.
      return projectSchema.parse(next);
    case 'detail':
      next.clips[index] = { ...next.clips[index]!, detail: detailSchema.parse(command.detail) };
      return projectSchema.parse(next);
    case 'detail-clips':
      setClipsDetail(next, command.clipIds, command.detail);
      return projectSchema.parse(next);
    case 'colour-setting':
    case 'hsl-band':
    case 'colour-curve': {
      const { owner, save } = colourOwner(next, command);
      editColourSetting(owner, command);
      save();
      return projectSchema.parse(next);
    }
    case 'transform-setting':
      editTransformSetting(requiredLayer(next, command.layerId), command);
      return projectSchema.parse(next);
    case 'music':
      next.music = command.music;
      break;
    case 'adjustment-add':
    case 'adjustment-remove':
    case 'adjustment-range':
      editAdjustment(next, command);
      // Adjustments never move clips or extend the project.
      return projectSchema.parse(next);
    case 'layer-key-set': {
      const { owner, save } = colourOwner(next, command);
      setLayerKey(owner, command);
      save();
      break;
    }
    case 'layer-key-toggle':
    case 'layer-key-value':
    case 'layer-key-move':
    case 'layer-key-remove':
    case 'layer-key-easing':
    case 'layer-key-default': {
      const { owner, save } = colourOwner(next, command);
      editLayerKey(owner, command);
      save();
      break;
    }
    case 'layer-add':
    case 'layer-create':
    case 'layer-update':
    case 'layer-options':
    case 'layer-remove':
    case 'layer-order':
      editLayer(next, command, before);
      break;
    case 'place':
      placeClip(next, index, command, before, anchors);
      break;
    case 'move-clips': {
      const arrangement = arrangeClipGroup(next, before, command);
      next.clips = arrangement.clips;
      repairLayerBoundaries(next, arrangement.layerIds);
      for (const [layerId, start] of arrangement.anchors) anchors.set(layerId, start);
      break;
    }
    case 'transition':
      setTransition(next, command.transition, before);
      break;
    case 'fades': {
      const layer = requiredLayer(next, command.layerId);
      layer.openingFade = command.opening;
      layer.closingFade = command.closing;
      break;
    }
    case 'bookmark-add':
    case 'bookmark-move':
    case 'bookmark-remove':
      editBookmark(next, command);
      // Editing aids only: never normalize or rewrite stored timing.
      return projectSchema.parse(next);
    case 'select-set':
    case 'select-narrow':
      editSelects(next, command);
      return projectSchema.parse(next);
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
