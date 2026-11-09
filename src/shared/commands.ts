import { arrangeClipGroup } from './clip-group.js';
import type { EditCommand, KeySetting } from './command-schema.js';
import {
  defaultKeyframe,
  EMPTY_KEY_VALUES,
  interpolationSchema,
  KEYFRAME_SETTINGS,
  joiningEasing,
  keySettings,
  layerKeyframe,
  layerKeyframeSchema,
  uniformKeyframe,
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
import { detailSchema, NEUTRAL_DETAIL, type DetailSetting } from './detail.js';
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
  type ClipGrade,
} from './grade.js';
import type { ColorCurvePoint, CurveChannel, HslBand, HslSettings } from './advanced-color.js';
import { colorSchema, NEUTRAL_COLOR, type ColorSettings, type ScalarColorSetting } from './color.js';
import {
  MAX_TRANSFORM_KEYFRAMES,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  spatialPoseSchema,
  spatialSettingsSchema,
  type SpatialChannel,
  type SpatialKeyframe,
} from './spatial.js';
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

/** The Color and keyframes a command changes: a clip's grade or an adjustment, in the track keyframe shape. */
interface ColorOwner {
  kind: 'clip' | 'adjustment';
  name: string;
  color: ColorSettings;
  keyframes: LayerKeyframe[];
}

/** A command's target: a clip's grade (clipId) or an adjustment (adjustmentId); exactly one is given. */
type ColorTargetFields = Partial<Record<'clipId' | 'adjustmentId', string | undefined>>;

function colorOwner(next: ProjectDocument, command: ColorTargetFields): { owner: ColorOwner; save: () => void } {
  if ((command.clipId === undefined) === (command.adjustmentId === undefined))
    throw new Error("Give either clipId, for a clip's own grade, or adjustmentId, for an adjustment.");
  const target =
    command.clipId === undefined
      ? requiredAdjustment(next, command.adjustmentId!)
      : next.clips.find((item) => item.id === command.clipId)?.grade;
  if (!target) throw new Error('Clip no longer exists.');
  const owner: ColorOwner = {
    kind: command.clipId === undefined ? 'adjustment' : 'clip',
    name: command.clipId === undefined ? `adjustment ${command.adjustmentId}` : `clip ${command.clipId}`,
    color: target.color,
    keyframes: target.keyframes.map(gradeKeyAsLayerKey),
  };
  return {
    owner,
    save: () => {
      if (owner.keyframes.some((key) => key.values.opacity !== null))
        throw new Error('Opacity belongs to the track Transform, not to a grade.');
      if (command.clipId === undefined) requireKeysWithin(owner.keyframes, (target as Adjustment).duration);
      target.color = owner.color;
      target.keyframes = owner.keyframes.map(layerKeyAsGradeKey);
    },
  };
}

function requireKeysWithin(keyframes: readonly { frame: number }[], duration: number): void {
  if (keyframes.some((key) => key.frame < 0 || key.frame >= duration))
    throw new Error(
      `Adjustment keyframes must stay within the adjustment (frames 0–${duration - 1}). Move or remove them, or make the adjustment longer.`,
    );
}

function requiredAdjustment(next: ProjectDocument, adjustmentId: string): Adjustment {
  const item = next.adjustments.find((candidate) => candidate.id === adjustmentId);
  if (!item) throw new Error('Adjustment no longer exists.');
  return item;
}

function maxKeyframes(_owner: ColorOwner): number {
  return MAX_GRADE_KEYFRAMES;
}

function followsKeyframes(name: string, setting: string, keys: number, list: string): void {
  if (keys)
    throw new Error(
      `${setting} follows ${keys} ${list} keyframe${keys === 1 ? '' : 's'} on ${name}, so its base value is not used; change ${keys === 1 ? 'that keyframe' : 'those keyframes'} instead.`,
    );
}

/** Patch entries: a value sets a setting, null returns it to neutral. */
function listed<K extends string>(settings: Partial<Record<K, number | null>> | undefined): [K, number | null][] {
  return Object.entries(settings ?? {}) as [K, number | null][];
}

function patched<K extends string>(
  values: Readonly<Record<K, number>>,
  entries: readonly [K, number | null][],
  neutral: Readonly<Record<K, number>>,
): Record<K, number> {
  return { ...values, ...Object.fromEntries(entries.map(([setting, value]) => [setting, value ?? neutral[setting]])) };
}

const NOTHING_LISTED = 'List at least one setting to change.';

function patchTransform(layer: VideoLayer, command: Extract<EditCommand, { type: 'transform-patch' }>): void {
  const { transform } = layer;
  const entries = listed<SpatialChannel>(command.settings);
  if (!entries.length) throw new Error(NOTHING_LISTED);
  for (const [setting] of entries)
    followsKeyframes(layer.name, setting, keyCount(transform.keyframes, setting), 'Transform');
  layer.transform = {
    ...transform,
    base: spatialPoseSchema.parse(patched(transform.base, entries, NEUTRAL_SPATIAL_POSE)),
  };
}

/** Each listed clip, once and existing, or none of them. */
function listedClips(next: ProjectDocument, ids: readonly string[]): VideoClip[] {
  if (new Set(ids).size !== ids.length) throw new Error('List each clip once.');
  return ids.map((id) => {
    const clip = next.clips.find((item) => item.id === id);
    if (!clip) throw new Error(`Clip ${id} no longer exists.`);
    return clip;
  });
}

/** The clip grades (clipIds) or the adjustment (adjustmentId) a command changes. */
function colorTargets(
  next: ProjectDocument,
  command: Extract<EditCommand, { type: 'color' | 'color-patch' }>,
): { kind: string; name: string; grade: Pick<ClipGrade, 'color' | 'keyframes'> }[] {
  if ((command.adjustmentId === undefined) === (command.clipIds === undefined))
    throw new Error("Give either clipIds, for clips' own grades, or adjustmentId, for an adjustment.");
  if (command.adjustmentId !== undefined) {
    const grade = requiredAdjustment(next, command.adjustmentId);
    return [{ kind: 'adjustment', name: `adjustment ${command.adjustmentId}`, grade }];
  }
  return listedClips(next, command.clipIds!).map((clip) => ({
    kind: 'clip',
    name: `clip ${clip.id}`,
    grade: clip.grade,
  }));
}

/** The same Color on each listed clip's grade, or on an adjustment, keeping their keyframes. */
function setColor(next: ProjectDocument, command: Extract<EditCommand, { type: 'color' }>): void {
  const color = colorSchema.parse(command.color);
  for (const { grade } of colorTargets(next, command)) grade.color = structuredClone(color);
}

/** Listed settings take their value, or neutral for null, on every target; the others keep theirs. */
function patchColor(next: ProjectDocument, command: Extract<EditCommand, { type: 'color-patch' }>): void {
  const settings = listed<ScalarColorSetting>(command.settings);
  const bands = Object.entries(command.hsl ?? {}) as [HslBand, HslSettings[HslBand] | null][];
  const curves = Object.entries(command.curves ?? {}) as [CurveChannel, ColorCurvePoint[] | null][];
  if (settings.length + bands.length + curves.length === 0) throw new Error(NOTHING_LISTED);
  for (const { kind, name, grade } of colorTargets(next, command)) {
    for (const [setting] of settings) followsKeyframes(name, setting, keyCount(grade.keyframes, setting), kind);
    const { color } = grade;
    const changed = {
      ...patched(color, settings, NEUTRAL_COLOR),
      hsl: {
        ...color.hsl,
        ...Object.fromEntries(bands.map(([band, values]) => [band, values ?? NEUTRAL_COLOR.hsl[band]])),
      },
      curves: {
        ...color.curves,
        ...Object.fromEntries(curves.map(([channel, points]) => [channel, points ?? NEUTRAL_COLOR.curves[channel]])),
      },
    };
    grade.color = structuredClone(colorSchema.parse(changed));
  }
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
function editLayerValue(layer: ColorOwner, point: LayerKeyframe | undefined, command: LayerValueCommand): void {
  if (!GRADE_SETTINGS.includes(command.setting as ScalarColorSetting)) throw new Error('Unknown keyframe setting.');
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
function patchKeySettings<K extends string>(
  base: { values: Readonly<Record<K, number | null>>; easing: Readonly<Record<K, Interpolation | null>> },
  patch: { [S in K]?: number | null | undefined },
  easing: Interpolation | Partial<Record<K, Interpolation>> | undefined,
  joining: Interpolation,
): { values: Record<K, number | null>; easing: Record<K, Interpolation | null> } {
  const values: Record<K, number | null> = { ...base.values };
  const curves: Record<K, Interpolation | null> = { ...base.easing };
  const listed = (Object.entries(patch) as [K, number | null | undefined][]).filter(
    (entry): entry is [K, number | null] => entry[1] !== undefined,
  );
  for (const [setting, value] of listed) {
    const keyed = values[setting] !== null;
    values[setting] = value;
    if (value === null) curves[setting] = null;
    else if (typeof easing === 'string') curves[setting] = easing;
    else if (!keyed) curves[setting] = joining;
  }
  if (typeof easing === 'string' && !listed.length)
    for (const setting of Object.keys(values) as K[]) if (values[setting] !== null) curves[setting] = easing;
  if (typeof easing === 'object') easePerSetting(values, curves, easing);
  return { values, easing: curves };
}

function easePerSetting<K extends string>(
  values: Readonly<Record<K, number | null>>,
  curves: Record<K, Interpolation | null>,
  easing: Partial<Record<K, Interpolation>>,
): void {
  for (const [setting, curve] of Object.entries(easing) as [K, Interpolation][]) {
    if (values[setting] === null) throw new Error(`${setting} is not keyed at this keyframe, so it has no Easing.`);
    curves[setting] = curve;
  }
}

function keyframeLimit(owner: ColorOwner): Error {
  const what = owner.kind === 'clip' ? 'This clip' : 'This adjustment';
  return new Error(`${what} already has ${maxKeyframes(owner)} keyframes. Change one of them, or remove one.`);
}

/** Without values, layer-key-set changes only an existing keyframe's Easing or default flag. */
function requireKeyChange(command: LayerKeySet, exists: boolean): void {
  if (command.values !== undefined) return;
  if (command.easing === undefined && command.reset === undefined)
    throw new Error('List values, an Easing or reset to change.');
  if (!exists) throw new Error(`No keyframe at frame ${command.frame}: list values to create one.`);
}

/** A grade frame: a source frame of a clip, or a frame counted from an adjustment's start, which may be negative. */
function requireGradeFrame(frame: number): void {
  if (!Number.isInteger(frame) || Math.abs(frame) > MAX_FRAME) throw new Error('Keyframe frames are whole frames.');
}

function gradeEasingPatch(
  easing: Interpolation | Partial<Record<string, Interpolation>>,
): Interpolation | Partial<Record<ScalarColorSetting, Interpolation>> {
  if (typeof easing === 'string') return interpolationSchema.parse(easing);
  for (const [setting, curve] of Object.entries(easing)) {
    if (!GRADE_SETTINGS.includes(setting as ScalarColorSetting)) throw new Error(`Unknown setting ${setting}.`);
    interpolationSchema.parse(curve);
  }
  return easing as Partial<Record<ScalarColorSetting, Interpolation>>;
}

/** Keys, changes or disables several settings of one keyframe at once, like their toggles together. */
function setLayerKey(layer: ColorOwner, command: LayerKeySet): void {
  requireGradeFrame(command.frame);
  const foreign = Object.keys(command.values ?? {}).find(
    (setting) => !GRADE_SETTINGS.includes(setting as ScalarColorSetting),
  );
  if (foreign !== undefined)
    throw new Error(`${foreign} is not a Color setting: Transform keyframes belong to a track (layerId).`);
  const patch = command.values === undefined ? {} : gradeKeyValuesPatchSchema.parse(command.values);
  const easing = command.easing === undefined ? undefined : gradeEasingPatch(command.easing);
  if (command.reset !== undefined && typeof command.reset !== 'boolean')
    throw new Error('Reset must be true or false.');
  const point = layer.keyframes.find((key) => key.frame === command.frame);
  requireKeyChange(command, point !== undefined);
  if (!point && layer.keyframes.length >= maxKeyframes(layer)) throw keyframeLimit(layer);
  const order = KEYFRAME_SETTINGS.map((setting) => setting.key);
  const base = point ?? layerKeyframe(command.frame, EMPTY_KEY_VALUES, 'linear');
  const joining = point ? joiningEasing(layer.keyframes, point, order) : 'linear';
  const changed = {
    frame: command.frame,
    ...patchKeySettings<KeyframeSetting>(base, patch, easing, joining),
    reset: command.reset ?? base.reset,
  };
  layer.keyframes = keySettings(changed).length
    ? upsertKey(layer.keyframes, changed)
    : layer.keyframes.filter((key) => key.frame !== command.frame);
}

/** Adds a default keyframe at `frame`, or removes the one there; a grade's has no Opacity. */
function toggleDefaultKey(layer: ColorOwner, point: LayerKeyframe | undefined, frame: number): void {
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

function moveLayerKey(layer: ColorOwner, point: LayerKeyframe, nextFrame: number): void {
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

function editLayerKey(layer: ColorOwner, command: LayerKeyCommand): void {
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

type KeyframeCommand = LayerKeyCommand | LayerKeySet;
type TransformKeyCommand = Extract<KeyframeCommand, { type: 'layer-key-set' | 'layer-key-move' | 'layer-key-remove' }>;

/** Edits the keyframes of a clip grade or an adjustment, or of a track's Transform. */
function editKeyframes(next: ProjectDocument, command: KeyframeCommand): 'grade' | 'transform' {
  if ('layerId' in command && command.layerId !== undefined) {
    if (command.clipId !== undefined || command.adjustmentId !== undefined)
      throw new Error('Give one of clipId, adjustmentId or layerId.');
    editTransformKey(requiredLayer(next, command.layerId), command);
    return 'transform';
  }
  const { owner, save } = colorOwner(next, command);
  if (command.type === 'layer-key-set') setLayerKey(owner, command);
  else editLayerKey(owner, command);
  save();
  return 'grade';
}

function requireProjectFrame(frame: number): void {
  if (!Number.isInteger(frame) || frame < 0 || frame > MAX_FRAME)
    throw new Error('Transform keyframes are at whole project frames from 0.');
}

function editTransformKey(layer: VideoLayer, command: TransformKeyCommand): void {
  requireProjectFrame(command.frame);
  const keys = layer.transform.keyframes;
  const point = keys.find((key) => key.frame === command.frame);
  let keyframes: SpatialKeyframe[];
  if (command.type === 'layer-key-set') keyframes = setTransformKey(keys, point, command);
  else if (!point) throw new Error('Transform keyframe no longer exists.');
  else if (command.type === 'layer-key-remove') keyframes = keys.filter((key) => key !== point);
  else keyframes = moveTransformKey(keys, point, command.nextFrame);
  layer.transform = { ...layer.transform, keyframes };
}

function moveTransformKey(keys: SpatialKeyframe[], point: SpatialKeyframe, nextFrame: number): SpatialKeyframe[] {
  requireProjectFrame(nextFrame);
  if (keys.some((key) => key !== point && key.frame === nextFrame))
    throw new Error('A Transform keyframe already exists at the destination frame.');
  return upsertKey(
    keys.filter((key) => key !== point),
    { ...point, frame: nextFrame },
  );
}

const NO_TRANSFORM_KEY_VALUES = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<
  SpatialChannel,
  number | null
>;

const isTransformSetting = (setting: string): setting is SpatialChannel =>
  (SPATIAL_CHANNELS as readonly string[]).includes(setting);

/** The Transform settings a command keys, each within its bounds, or null to disable it. */
function transformKeyPatch(
  values: Partial<Record<KeySetting, number | null>> | undefined,
): Partial<Record<SpatialChannel, number | null>> {
  if (values === undefined) return {};
  const entries = Object.entries(values);
  if (!entries.length) throw new Error('List at least one setting.');
  for (const [setting, value] of entries) {
    if (!isTransformSetting(setting))
      throw new Error(`${setting} is not a Transform setting: Color keyframes belong to a clip or an adjustment.`);
    if (value !== null) spatialPoseSchema.shape[setting].parse(value);
  }
  return values as Partial<Record<SpatialChannel, number | null>>;
}

function transformEasingPatch(
  easing: Interpolation | Partial<Record<string, Interpolation>>,
): Interpolation | Partial<Record<SpatialChannel, Interpolation>> {
  if (typeof easing === 'string') return interpolationSchema.parse(easing);
  for (const [setting, curve] of Object.entries(easing)) {
    if (!isTransformSetting(setting)) throw new Error(`Unknown setting ${setting}.`);
    interpolationSchema.parse(curve);
  }
  return easing as Partial<Record<SpatialChannel, Interpolation>>;
}

/** Keys, changes or disables several Transform settings at one project frame, like layer-key-set on a grade. */
function setTransformKey(
  keys: SpatialKeyframe[],
  point: SpatialKeyframe | undefined,
  command: LayerKeySet,
): SpatialKeyframe[] {
  const patch = transformKeyPatch(command.values);
  const easing = command.easing === undefined ? undefined : transformEasingPatch(command.easing);
  if (command.reset !== undefined && typeof command.reset !== 'boolean')
    throw new Error('Reset must be true or false.');
  requireKeyChange(command, point !== undefined);
  if (!point && keys.length >= MAX_TRANSFORM_KEYFRAMES)
    throw new Error(
      `This track already has ${MAX_TRANSFORM_KEYFRAMES} Transform keyframes. Change one of them, or remove one.`,
    );
  const base = point ?? { ...uniformKeyframe(command.frame, NO_TRANSFORM_KEY_VALUES, 'linear'), reset: false };
  const joining = point ? joiningEasing(keys, point, SPATIAL_CHANNELS) : 'linear';
  const changed = {
    frame: command.frame,
    ...patchKeySettings(base, patch, easing, joining),
    reset: command.reset ?? base.reset,
  };
  return SPATIAL_CHANNELS.some((channel) => changed.values[channel] !== null)
    ? upsertKey(keys, changed)
    : keys.filter((key) => key.frame !== command.frame);
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

/** The user's own review mark: it never changes kept ranges, clips or rendering. */
function markSelectsDone(next: ProjectDocument, command: Extract<EditCommand, { type: 'select-done' }>): void {
  const mediaId = idSchema.parse(command.mediaId);
  if (!next.media.videoIds.includes(mediaId)) throw new Error('Only a recording of this project can be marked done.');
  const others = next.selectsDone.filter((id) => id !== mediaId);
  if (!command.done) next.selectsDone = others;
  else if (others.length === next.selectsDone.length) next.selectsDone = [...others, mediaId];
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

function patchFades(layer: VideoLayer, command: Extract<EditCommand, { type: 'fades' }>): void {
  if (command.opening === undefined && command.closing === undefined) throw new Error('List a fade to change.');
  if (command.opening !== undefined) layer.openingFade = command.opening ?? 0;
  if (command.closing !== undefined) layer.closingFade = command.closing ?? 0;
}

/** The listed detail filters on every listed clip, or none of them. */
function patchClipsDetail(next: ProjectDocument, command: Extract<EditCommand, { type: 'detail-patch' }>): void {
  const entries = listed<DetailSetting>(command.settings);
  if (!entries.length) throw new Error(NOTHING_LISTED);
  for (const clip of listedClips(next, command.clipIds))
    clip.detail = detailSchema.parse(patched(clip.detail, entries, NEUTRAL_DETAIL));
}

/** Integer project frames for an adjustment: never before 0, its OUT within the supported range. */
function adjustmentRange(start: number, duration: number): void {
  frameSchema.parse(start);
  if (!Number.isInteger(duration) || duration < 1) throw new Error('An adjustment lasts at least one frame.');
  if (start + duration > MAX_FRAME)
    throw new Error('Adjustment OUT exceeds the supported integer project-frame range.');
}

function overlappingAdjustment(items: readonly Adjustment[], start: number, duration: number, except?: string) {
  return items.find(
    (item) => item.id !== except && item.start < start + duration && start < item.start + item.duration,
  );
}

/** Both pieces keep the whole grade; each keeps the keyframes within its range, the second's rebased onto its start. */
function splitAdjustment(next: ProjectDocument, command: Extract<EditCommand, { type: 'adjustment-split' }>): void {
  const item = requiredAdjustment(next, command.adjustmentId);
  if (command.frame <= item.start || command.frame >= item.start + item.duration)
    throw new Error('Split an adjustment at a frame inside it, after its first frame.');
  if (next.adjustments.some((other) => other.id === command.newAdjustmentId))
    throw new Error('An adjustment with this ID already exists.');
  if (next.adjustments.length >= MAX_ADJUSTMENTS)
    throw new Error(`A project has at most ${MAX_ADJUSTMENTS} adjustments. Remove one first.`);
  const offset = command.frame - item.start;
  next.adjustments.push({
    ...structuredClone(item),
    id: command.newAdjustmentId,
    start: command.frame,
    duration: item.duration - offset,
    keyframes: item.keyframes
      .filter((key) => key.frame >= offset)
      .map((key) => ({ ...structuredClone(key), frame: key.frame - offset })),
  });
  item.keyframes = item.keyframes.filter((key) => key.frame < offset);
  item.duration = offset;
  next.adjustments.sort((left, right) => left.start - right.start);
}

function editAdjustment(
  next: ProjectDocument,
  command: Extract<
    EditCommand,
    { type: 'adjustment-add' | 'adjustment-remove' | 'adjustment-range' | 'adjustment-split' }
  >,
): void {
  if (command.type === 'adjustment-remove') {
    requiredAdjustment(next, command.adjustmentId);
    next.adjustments = next.adjustments.filter((item) => item.id !== command.adjustmentId);
    return;
  }
  if (command.type === 'adjustment-split') {
    splitAdjustment(next, command);
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
    const item = createAdjustment(command.adjustmentId, command.start, command.duration);
    item.color = colorSchema.parse({ ...item.color, ...command.settings });
    next.adjustments.push(item);
  } else {
    const item = requiredAdjustment(next, command.adjustmentId);
    if (command.keyframes !== 'move' && command.keyframes !== 'stay')
      throw new Error('Keyframes must move with the adjustment or stay at their project frames.');
    // Staying keyframes keep their project frame: their offset changes by the start's change.
    const shift = command.keyframes === 'stay' ? item.start - command.start : 0;
    item.keyframes = item.keyframes.map((key) => ({ ...key, frame: key.frame + shift }));
    requireKeysWithin(item.keyframes, command.duration);
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
    case 'color':
      setColor(next, command);
      return projectSchema.parse(next);
    case 'color-patch':
      patchColor(next, command);
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
    case 'detail-patch':
      patchClipsDetail(next, command);
      return projectSchema.parse(next);
    case 'transform-patch':
      patchTransform(requiredLayer(next, command.layerId), command);
      return projectSchema.parse(next);
    case 'music':
      next.music = command.music;
      break;
    case 'adjustment-add':
    case 'adjustment-remove':
    case 'adjustment-range':
    case 'adjustment-split':
      editAdjustment(next, command);
      // Adjustments never move clips or extend the project.
      return projectSchema.parse(next);
    case 'layer-key-set':
    case 'layer-key-toggle':
    case 'layer-key-value':
    case 'layer-key-move':
    case 'layer-key-remove':
    case 'layer-key-easing':
    case 'layer-key-default':
      // Like transform, a Transform keyframe edit never rewrites stored timing.
      if (editKeyframes(next, command) === 'transform') return projectSchema.parse(next);
      break;
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
    case 'fades':
      patchFades(requiredLayer(next, command.layerId), command);
      break;
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
    case 'select-done':
      markSelectsDone(next, command);
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
