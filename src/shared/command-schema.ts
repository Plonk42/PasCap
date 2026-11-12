import { z } from 'zod';
import { colorCurveSchema, CURVE_CHANNELS, HSL_BANDS, hslBandSchema } from './advanced-color.js';
import { COLOR_CONTROLS, colorSchema, NEUTRAL_COLOR } from './color.js';
import { described } from './described.js';
import { detailSchema } from './detail.js';
import { GRADE_SETTINGS, gradeSettingSchema } from './grade.js';
import { interpolationSchema } from './keyframes.js';
import {
  frameSchema,
  idSchema,
  layerSchema,
  MAX_SELECTS,
  musicTracksSchema,
  newClipSchema,
  selectRangeSchema,
  transitionSchema,
} from './model.js';
import { SPATIAL_CHANNELS, spatialPoseSchema, type SpatialChannel } from './spatial.js';
import { speedSchema } from './speed.js';

/** A grade setting, or a Transform setting of a track. */
export type KeySetting = (typeof GRADE_SETTINGS)[number] | SpatialChannel;

function command<const T extends string, S extends z.ZodRawShape>(type: T, description: string, shape: S) {
  return described(z.object({ type: z.literal(type), ...shape }).strict(), description);
}

const clipId = described(idSchema, 'ID of an existing video clip.');
const layerId = described(idSchema, 'ID of an existing video track.');
const adjustmentId = described(idSchema, 'ID of an existing adjustment.');
const colorAdjustmentId = described(idSchema.optional(), 'Adjustment ID; or clipId.');
const gradeClipId = described(idSchema.optional(), 'Clip ID, for its grade; or adjustmentId.');
const colorOwner = { clipId: gradeClipId, adjustmentId: colorAdjustmentId };
/** Grade keyframes of a clip or an adjustment, or a track's Transform keyframes. */
const keyOwner = {
  clipId: described(idSchema.optional(), 'Clip ID, for its grade keyframes; or adjustmentId or layerId.'),
  adjustmentId: described(idSchema.optional(), 'Adjustment ID; or clipId or layerId.'),
  layerId: described(idSchema.optional(), 'Video track ID, for its Transform keyframes; or clipId or adjustmentId.'),
};
const newClipId = (use: string) =>
  described(idSchema, `Unused clip ID (letters, digits, "_" and "-", at most 100) for ${use}.`);
const sourceIn = described(frameSchema, 'First kept source frame of the recording (inclusive).');
const sourceOut = described(frameSchema, 'Source frame after the last kept one (exclusive); must be after sourceIn.');
/** Clip grade keys are at source frames; adjustment keys count from its start and may precede it (commands check). */
const gradeFrame = z.number().int();
const frameTerms = 'source frame (clip), or from its start (adjustment)';
const keyFrameTerms = `${frameTerms}, or project frame (track)`;
const keyFrame = described(gradeFrame, `Frame of the existing keyframe: ${frameTerms}.`);
const ownerFrame = described(gradeFrame, `Frame of the keyframe: ${frameTerms}.`);
const trackName = described(z.string().trim().min(1).max(100), 'Track name, 1–100 characters.');
const neutralNotZero = COLOR_CONTROLS.filter((control) => NEUTRAL_COLOR[control.key] !== 0).map(
  (control) => `${control.key} ${NEUTRAL_COLOR[control.key]}`,
);
/** Each scalar Color setting's bounds and neutral value, which is not always 0. */
const colorRanges = COLOR_CONTROLS.map((control) => `${control.key} ${control.min}–${control.max}`).join(', ');
const colorBounds = `Bounds: ${colorRanges}. Neutral (no change): ${neutralNotZero.join(', ')}, every other 0; Saturation 0 is grayscale.`;
const keyframeSetting = described(
  gradeSettingSchema,
  'Scalar Color setting; bounds and neutral values as in color-patch.',
);
const keySetting = z.enum([...GRADE_SETTINGS, ...SPATIAL_CHANNELS] as [KeySetting, ...KeySetting[]]);
const transformBounds =
  'cropLeft, cropRight, cropTop and cropBottom 0–1 (fractions of the recording), scale 0.1–8, translateX and translateY −2–2 (fractions of the output), rotation −180–180° clockwise, opacity 0–1; neutral: scale 1, opacity 1, every other 0';
const mediaId = described(idSchema, 'ID of a video recording of the project.');
const selectRanges = described(
  z.array(selectRangeSchema).max(MAX_SELECTS),
  `Kept source ranges (OUT exclusive), ascending and separated by at least one frame, at most ${MAX_SELECTS}.`,
);
/** Descriptions are written for an LLM; rules JSON Schema cannot express are stated in them. */
export const editCommandSchema = z.discriminatedUnion('type', [
  command(
    'insert',
    'Insert a new video clip into the project clip array. A Ripple track plays its clips in array order, packed from its first clip; a track without Ripple places it at clip.start, and it must not overlap another clip.',
    {
      clip: described(
        newClipSchema,
        'The complete new clip: unused id, mediaId of a prepared recording of the project, layerId of its track, start (project frame), sourceIn/sourceOut (OUT exclusive, after IN, within the recording), speed, reverse and detail. It starts with a neutral grade.',
      ),
      index: described(
        z.number().int().nonnegative(),
        'Position in the project clip array, from 0 to the number of clips.',
      ),
    },
  ),
  command(
    'delete',
    'Remove a clip. A Ripple track closes the gap; on a track without Ripple the other clips keep their starts.',
    { clipId },
  ),
  command(
    'reorder',
    'Reorder the whole project clip array; Ripple tracks play their clips in this order. Transitions between clips that are no longer adjacent become cuts.',
    { clipIds: described(z.array(idSchema), 'Every clip ID of the project exactly once, in the new order.') },
  ),
  command(
    'trim',
    "Change a clip's source range. Its start stays; a Ripple track re-sequences the clips after it. Transitions or fades that no longer fit reject the edit.",
    { clipId, sourceIn, sourceOut },
  ),
  command(
    'trim-place',
    "Change a clip's source range and start together, like a left-edge trim. On a Ripple track only the first clip's start can change; later starts follow the sequence.",
    { clipId, sourceIn, sourceOut, start: described(frameSchema, 'New project frame of the first output frame.') },
  ),
  command(
    'split',
    'Split a clip into two clips with independent settings, joined by a cut; the second clip on the timeline gets newClipId. A reversed clip keeps its higher source frames first.',
    {
      clipId,
      sourceFrame: described(
        frameSchema,
        "Source boundary strictly between the clip's sourceIn and sourceOut: frames below it form one piece, frames from it the other.",
      ),
      newClipId: newClipId('the second piece'),
    },
  ),
  command(
    'remove-source-range',
    "Cut source frames [sourceIn, sourceOut) out of a clip. Removing the middle leaves two clips; removing an end trims the clip; removing everything deletes it. A Ripple track closes the gap; otherwise the remaining pieces keep their timeline positions. The range must lie within the clip's own range.",
    { clipId, sourceIn, sourceOut, newClipId: newClipId('the piece after the removed middle; unused otherwise') },
  ),
  command(
    'duplicate',
    "Copy a clip (range, speed, direction and detail) right after it. A Ripple track inserts the copy into its sequence; otherwise it starts at the original's end and must not overlap another clip.",
    { clipId, newClipId: newClipId('the copy') },
  ),
  command(
    'color',
    "Replace the whole Color of clips' grades or of an adjustment; keyed settings follow their keyframes.",
    {
      clipIds: described(z.array(idSchema).min(1).optional(), 'Clips whose grade to set, each once; or adjustmentId.'),
      adjustmentId: colorAdjustmentId,
      color: described(colorSchema, 'Every Color setting: twelve scalar settings, hdr, localContrast, hsl and curves.'),
    },
  ),
  command(
    'color-patch',
    "Change Color settings of clips' grades or of an adjustment: a listed setting takes its value, null returns it to neutral, and settings left out keep theirs. Rejected as a whole while a listed scalar setting has keyframes on a target: change those with layer-key-set.",
    {
      clipIds: described(
        z.array(idSchema).min(1).optional(),
        'Clips whose grade to change, each once; or adjustmentId.',
      ),
      adjustmentId: colorAdjustmentId,
      settings: described(
        z.partialRecord(gradeSettingSchema, z.number().nullable()).optional(),
        `Scalar Color settings: a value, or null for neutral. ${colorBounds}`,
      ),
      hsl: described(
        z.partialRecord(z.enum(HSL_BANDS), hslBandSchema.nullable()).optional(),
        'HSL ranges (red, orange, yellow, green, cyan, blue, purple, magenta): hue shift −30–30°, saturation −1–1 and lightness −0.5–0.5, or null for neutral (all 0).',
      ),
      curves: described(
        z.partialRecord(z.enum(CURVE_CHANNELS), colorCurveSchema.nullable()).optional(),
        'Curves (master, red, green, blue): 2–16 control nodes {x, y} in 0–1 with inputs strictly ascending from 0 to 1, or null for identity (0,0), (0.5,0.5), (1,1).',
      ),
    },
  ),
  command(
    'transform-patch',
    'Change Transform base settings of a video track: a listed setting takes its value, null returns it to neutral, and settings left out keep theirs. Rejected as a whole while a listed setting has Transform keyframes, which it then follows.',
    {
      layerId,
      settings: described(
        z.partialRecord(spatialPoseSchema.keyof(), z.number().nullable()),
        `Transform settings: a value, or null for neutral. ${transformBounds}.`,
      ),
    },
  ),
  command(
    'speed',
    "Set a clip's speed. Its duration changes with it: a Ripple track re-sequences the clips after it, and overlaps or transitions that no longer fit reject the edit.",
    {
      clipId,
      speed: described(
        speedSchema,
        'Constant rate 0.1–8, or a curve of 1–256 keyframes at original source frames with an Easing toward the next one.',
      ),
    },
  ),
  command('reverse', 'Play a clip backwards or forwards; its duration and placement do not change.', {
    clipId,
    reverse: described(z.boolean(), 'True plays the clip from its last frame back to its first.'),
  }),
  command('detail', "Set a clip's static detail filters, applied before its grade.", {
    clipId,
    detail: described(detailSchema, 'Sharpen 0–2, Clarity −1–1 and Denoise 0–1; 0 is neutral.'),
  }),
  command(
    'detail-patch',
    'Change the static detail filters of one or several clips: a listed filter takes its value, null returns it to neutral 0, and filters left out keep theirs. An unknown clip rejects the whole command.',
    {
      clipIds: described(z.array(idSchema).min(1), 'The clips, each once.'),
      settings: described(
        z.partialRecord(detailSchema.keyof(), z.number().nullable()),
        'Sharpen 0–2, Clarity −1–1 and Denoise 0–1, or null for neutral 0.',
      ),
    },
  ),
  command('music', 'Replace every music track of the project.', {
    music: described(
      musicTracksSchema,
      'At most 8 music tracks, each with gain, Ripple, fades, 1–8 clips and one transition between each pair of adjacent clips.',
    ),
  }),
  command(
    'layer-key-toggle',
    'Enable a setting at a keyframe with value, creating the keyframe if needed; or disable it if enabled, removing the keyframe with its last setting.',
    {
      ...colorOwner,
      frame: ownerFrame,
      setting: keyframeSetting,
      value: described(z.number(), "Value to key, within the setting's bounds; checked even when disabling."),
    },
  ),
  command(
    'layer-key-set',
    'Create or change the keyframe at frame of a clip grade, an adjustment or a track Transform in one command: each listed setting is keyed at its value (or disabled with null), others keep theirs, and a keyframe left without settings is removed. Without values it changes only the Easing or default flag of an existing keyframe, or with reset true alone adds a default keyframe (every setting neutral, held), as the editor button does. Rejected as a whole on an out-of-bounds value, a setting the target does not have, an Easing for a setting not keyed there, or a keyframe beyond the limit (64 per grade, 256 per Transform).',
    {
      ...keyOwner,
      frame: described(gradeFrame, `Frame of the keyframe: ${keyFrameTerms}.`),
      values: described(
        z.partialRecord(keySetting, z.number().nullable()).optional(),
        `Settings to key at their value, or null to disable them here; at least one when given. Color settings of a grade: ${colorBounds} Transform settings of a track: ${transformBounds}.`,
      ),
      easing: described(
        interpolationSchema.or(z.partialRecord(keySetting, interpolationSchema)).optional(),
        'One Easing (hold, linear, ease-in, ease-out or smooth) for every setting keyed by this command (every setting keyed there when values is omitted), or an Easing per setting keyed here. Omitted: a newly keyed setting adopts the Easing the keyframe already agrees on, else linear; others keep theirs.',
      ),
      reset: described(
        z.boolean().optional(),
        "True makes it a default keyframe, whose values never reach back to earlier frames; omitted keeps the keyframe's current flag (false for a new one).",
      ),
    },
  ),
  command('layer-key-value', 'Change the value of a setting already enabled at a keyframe.', {
    ...colorOwner,
    frame: keyFrame,
    setting: keyframeSetting,
    value: described(z.number(), "New value, within the setting's bounds."),
  }),
  command('layer-key-move', 'Move a whole keyframe to another frame; an occupied frame rejects the edit.', {
    ...keyOwner,
    frame: described(gradeFrame, `Frame of the existing keyframe: ${keyFrameTerms}.`),
    nextFrame: described(gradeFrame, 'Destination frame, in the same terms as frame.'),
  }),
  command('layer-key-remove', 'Remove a whole keyframe.', {
    ...keyOwner,
    frame: described(gradeFrame, `Frame of the existing keyframe: ${keyFrameTerms}.`),
  }),
  command('layer-add', 'Add a video track on top of the others; a project has at most 8.', {
    layer: described(
      layerSchema,
      'The complete new track: unused id, name, enabled, transform, ripple, transitions (empty) and fades.',
    ),
  }),
  command(
    'layer-update',
    "Replace a video track's settings. Turning Ripple on packs its clips from the first one's start; turning it off keeps their current starts.",
    { layer: described(layerSchema, 'The complete track with the same id as an existing one.') },
  ),
  command(
    'layer-create',
    'Add a video track on top of the others, with a neutral Transform (Opacity 1), Ripple on and no clips; a project has at most 8.',
    { layerId: described(idSchema, 'Unused ID of the new track.'), name: trackName },
  ),
  command(
    'layer-options',
    "Rename a video track, show or hide it, or turn its Ripple on or off; omitted fields keep their value. Turning Ripple on packs its clips from the first one's start; turning it off keeps their current starts.",
    {
      layerId,
      name: described(trackName.optional(), 'New track name, 1–100 characters.'),
      enabled: described(z.boolean().optional(), 'Whether the track is shown and rendered.'),
      ripple: described(z.boolean().optional(), 'Whether its clips play one after another.'),
    },
  ),
  command('layer-remove', 'Delete a video track and its clips; the last track cannot be deleted.', { layerId }),
  command('layer-order', 'Set the composition order of the video tracks, bottom first.', {
    layerIds: described(z.array(idSchema), 'Every track ID exactly once, bottom first.'),
  }),
  command(
    'place',
    'Move a clip to a track and position. On a Ripple track the array position decides its place in the sequence and start must equal the resulting start, unless it is the first clip.',
    {
      clipId,
      layerId: described(idSchema, 'Destination video track.'),
      start: described(frameSchema, 'Project frame of the first output frame.'),
      index: described(
        z.number().int().nonnegative(),
        'Position in the project clip array after removing the clip from it.',
      ),
    },
  ),
  command(
    'move-clips',
    'Move several clips together by the same number of frames. Overlaps, a start before frame 0 or transitions that no longer fit reject the whole move.',
    {
      clipIds: described(z.array(idSchema).min(1), 'The clips to move, each once.'),
      delta: described(z.number().int(), 'Project frames to move by; negative moves earlier.'),
      layerId: described(
        idSchema.optional(),
        'Destination track for clips that all come from one track; omitted keeps each clip on its own track.',
      ),
    },
  ),
  command(
    'transition',
    'Set the transition between two adjacent clips of a track. Non-cut transitions need touching clips or an existing dissolve; without Ripple a dissolve or pause moves the right clip.',
    {
      transition: described(
        transitionSchema,
        'cut (duration 0), fade-through-black (duration ≥ 2), cross-dissolve (overlap duration ≥ 1) or fade-black-pause (fade and pause frames), with leftId and rightId of the clips.',
      ),
      keepCut: described(
        z.boolean().optional(),
        "On a Ripple track, keep the perceived change and every later clip in place: a dissolve's overlap lengthens the left clip's end and the right clip's start by half each (shortening it trims them back), refused when the recordings or kept ranges lack the footage. Without it the right clip and every later one move earlier by the overlap.",
      ),
    },
  ),
  command(
    'fades',
    "Change a video track's fade from black at its first clip or to black at its last clip: a listed fade takes its length, null removes it, and a fade left out keeps its length.",
    {
      layerId,
      opening: described(
        frameSchema.nullable().optional(),
        'Frames of fade from black at the start of the first clip.',
      ),
      closing: described(frameSchema.nullable().optional(), 'Frames of fade to black at the end of the last clip.'),
    },
  ),
  command(
    'adjustment-add',
    'Add an adjustment: a grade of every video track over a range, after clip grades. No overlaps; at most 1024.',
    {
      adjustmentId: described(idSchema, 'Unused ID of the new adjustment.'),
      start: described(frameSchema, 'Its first project frame.'),
      duration: described(frameSchema.min(1), 'Frames it grades from start.'),
      settings: described(
        z.partialRecord(gradeSettingSchema, z.number()).optional(),
        'Its scalar Color settings, as in color-patch; others neutral.',
      ),
    },
  ),
  command('adjustment-remove', 'Remove an adjustment and its keyframes.', { adjustmentId }),
  command('adjustment-range', 'Move or resize an adjustment; no overlaps.', {
    adjustmentId,
    start: described(frameSchema, 'Its new first project frame.'),
    duration: described(frameSchema.min(1), 'Its new length in frames.'),
    keyframes: described(
      z.enum(['move', 'stay']),
      'move: keyframes move with it; stay: they keep their project frames, as in a trim. Refused if a keyframe would fall outside the new range.',
    ),
  }),
  command(
    'adjustment-split',
    'Split an adjustment: both pieces keep its whole grade and the keyframes within their ranges.',
    {
      adjustmentId,
      frame: described(frameSchema, 'First frame of the second piece, strictly inside it.'),
      newAdjustmentId: described(idSchema, 'Unused ID of the second piece.'),
    },
  ),
  command(
    'adjustment-enable',
    'Turn adjustments on or off, as the eye on each one does in the editor: one that is off keeps its range, Color and keyframes but grades nothing in stills, sheets and export. In the commands of still or timeline_sheet it compares a look with and without an adjustment without saving.',
    {
      adjustmentIds: described(z.array(idSchema).min(1), 'Existing adjustments, each once.'),
      enabled: described(z.boolean(), 'True turns them on; false turns them off.'),
    },
  ),
  command('bookmark-add', 'Add a bookmark, a snap point that is never rendered; at most 1,000.', {
    frame: described(frameSchema, 'Project frame without a bookmark.'),
  }),
  command('bookmark-move', 'Move a bookmark; an occupied frame rejects the edit.', {
    frame: described(frameSchema, 'Project frame of the existing bookmark.'),
    nextFrame: described(frameSchema, 'Destination project frame.'),
  }),
  command('bookmark-remove', 'Remove a bookmark.', {
    frame: described(frameSchema, 'Project frame of the existing bookmark.'),
  }),
  command(
    'select-set',
    "Replace a recording's kept ranges; an empty list makes the whole recording available again. Kept ranges never retime or render anything.",
    { mediaId, ranges: selectRanges },
  ),
  command(
    'select-narrow',
    "Replace a recording's kept ranges with ranges inside the existing ones; it never keeps more frames.",
    { mediaId, ranges: described(selectRanges.min(1), 'At least one range inside the kept ones.') },
  ),
  command('select-done', "Mark a recording's range selection done, or not done; it never changes its kept ranges.", {
    mediaId,
    done: described(z.boolean(), 'True marks it done; false marks it as still to review.'),
  }),
]);

export type EditCommand = z.infer<typeof editCommandSchema>;

/**
 * Editor commands replacing a whole value or mirroring one keyframe gesture (the assistant changes settings with
 * the patch commands and keyframes with layer-key-set, -move and -remove) or the user's own review marks.
 */
const EDITOR_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'layer-add',
  'layer-update',
  'color',
  'detail',
  'layer-key-toggle',
  'layer-key-value',
  'select-done',
]);

/** The commands of the edit operation. */
export const assistantEditCommandSchema = z.discriminatedUnion(
  'type',
  editCommandSchema.options.filter(
    (option) => !EDITOR_ONLY_COMMANDS.has(option.shape.type.value),
  ) as unknown as typeof editCommandSchema.options,
);

const commandTypes = assistantEditCommandSchema.options.map((option) => option.shape.type.value);

/**
 * A command for tools other than edit (previews and pictures): published as a type plus fields, so each tool
 * does not repeat edit's whole schema, and validated exactly like edit.
 */
export const referencedEditCommandSchema = z
  .object({ type: described(z.enum(commandTypes as [EditCommand['type'], ...EditCommand['type'][]]), 'Command type.') })
  .catchall(z.unknown())
  .meta({ description: "An edit command exactly as the edit tool takes it: its type and that command's fields." })
  .pipe(assistantEditCommandSchema);
