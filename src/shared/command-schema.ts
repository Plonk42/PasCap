import { z } from 'zod';
import { colourCurveSchema, curvesSchema, hslBandSchema, hslSchema } from './advanced-colour.js';
import { COLOUR_CONTROLS, colourSchema, NEUTRAL_COLOUR, type ScalarColourSetting } from './colour.js';
import { described } from './described.js';
import { detailSchema } from './detail.js';
import { interpolationSchema, keyframeSettingSchema } from './keyframes.js';
import {
  clipSchema,
  frameSchema,
  idSchema,
  layerSchema,
  MAX_SELECTS,
  musicTracksSchema,
  selectRangeSchema,
  transitionSchema,
} from './model.js';
import { spatialPoseSchema, spatialSettingsSchema } from './spatial.js';
import { speedSchema } from './speed.js';

function command<const T extends string, S extends z.ZodRawShape>(type: T, description: string, shape: S) {
  return described(z.object({ type: z.literal(type), ...shape }).strict(), description);
}

const clipId = described(idSchema, 'ID of an existing video clip.');
const layerId = described(idSchema, 'ID of an existing video track.');
const newClipId = (use: string) =>
  described(idSchema, `Unused clip ID (letters, digits, "_" and "-", at most 100) for ${use}.`);
const sourceIn = described(frameSchema, 'First kept source frame of the recording (inclusive).');
const sourceOut = described(frameSchema, 'Source frame after the last kept one (exclusive); must be after sourceIn.');
const keyFrame = described(frameSchema, 'Project frame of the existing track keyframe.');
const neutralNotZero = COLOUR_CONTROLS.filter((control) => NEUTRAL_COLOUR[control.key] !== 0).map(
  (control) => `${control.key} ${NEUTRAL_COLOUR[control.key]}`,
);
/** Each scalar Colour setting's bounds and neutral value, which is not always 0. */
const colourRanges = COLOUR_CONTROLS.map((control) => `${control.key} ${control.min}–${control.max}`).join(', ');
const colourBounds = `Bounds: ${colourRanges}. Neutral (no change): ${neutralNotZero.join(', ')}, every other 0; Saturation 0 is greyscale.`;
const keyframeSetting = described(
  keyframeSettingSchema,
  `Track setting: opacity (0–1, neutral 1) or a scalar Colour setting. ${colourBounds}`,
);
const mediaId = described(idSchema, 'ID of a video recording of the project.');
const selectRanges = described(
  z.array(selectRangeSchema).max(MAX_SELECTS),
  `Kept source ranges (OUT exclusive), ascending and separated by at least one frame, at most ${MAX_SELECTS}.`,
);
const colourSetting = described(
  z.enum(COLOUR_CONTROLS.map((control) => control.key) as [ScalarColourSetting, ...ScalarColourSetting[]]),
  `Scalar Colour setting. ${colourBounds}`,
);
const settingValue = described(z.number(), "New base value, within the setting's bounds.");

/** Descriptions are written for an LLM; rules JSON Schema cannot express are stated in them. */
export const editCommandSchema = z.discriminatedUnion('type', [
  command(
    'insert',
    'Insert a new video clip into the project clip array. A Ripple track plays its clips in array order, packed from its first clip; a track without Ripple places it at clip.start, and it must not overlap another clip.',
    {
      clip: described(
        clipSchema,
        'The complete new clip: unused id, mediaId of a prepared recording of the project, layerId of its track, start (project frame), sourceIn/sourceOut (OUT exclusive, after IN, within the recording), speed, reverse and detail.',
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
    'colour',
    "Replace a video track's complete Colour; it applies to every clip on the track. Settings with track keyframes follow their keyframes instead of these base values.",
    {
      layerId,
      colour: described(
        colourSchema,
        'Every Colour setting of the track: twelve scalar settings, hdr, localContrast, hsl and curves.',
      ),
    },
  ),
  command(
    'colour-setting',
    'Set one scalar Colour setting of a video track, keeping every other one. Rejected while the setting has track keyframes, which it then follows: change those with layer-key-value.',
    { layerId, setting: colourSetting, value: settingValue },
  ),
  command('hsl-band', "Set one HSL range of a video track's Colour, keeping the other ranges and settings.", {
    layerId,
    band: described(hslSchema.keyof(), 'Colour range: red, orange, yellow, green, cyan, blue, purple or magenta.'),
    values: described(
      hslBandSchema,
      'Hue shift −30–30°, saturation −1–1 and lightness −0.5–0.5 of the range; all 0 is neutral.',
    ),
  }),
  command('colour-curve', "Replace one curve of a video track's Colour, keeping the other curves and settings.", {
    layerId,
    channel: described(curvesSchema.keyof(), 'Curve: master, red, green or blue.'),
    points: described(
      colourCurveSchema,
      '2–16 control nodes {x, y} in 0–1 with inputs strictly ascending from 0 to 1; identity is (0,0), (0.5,0.5), (1,1).',
    ),
  }),
  command(
    'transform-setting',
    'Set one Transform base setting of a video track, keeping the others. Rejected while the setting has Transform keyframes, which it then follows.',
    {
      layerId,
      setting: described(
        spatialPoseSchema.keyof(),
        'Transform setting: cropLeft, cropRight, cropTop and cropBottom 0–1 (fractions of the recording), scale 0.1–8, translateX and translateY −2–2 (fractions of the output), rotation −180–180° clockwise. Neutral: scale 1, every other 0.',
      ),
      value: settingValue,
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
  command('transform', "Replace a video track's Transform; it applies to every clip on the track at project time.", {
    layerId,
    transform: described(
      spatialSettingsSchema,
      'Base pose (crop, scale, translation, rotation) and keyframes at project frames.',
    ),
  }),
  command('detail', "Set a clip's static detail filters, applied before the track's Colour.", {
    clipId,
    detail: described(detailSchema, 'Sharpen 0–2, Clarity −1–1 and Denoise 0–1; 0 is neutral.'),
  }),
  command('music', 'Replace every music track of the project.', {
    music: described(
      musicTracksSchema,
      'At most 8 music tracks, each with gain, Ripple, fades, 1–8 clips and one transition between each pair of adjacent clips.',
    ),
  }),
  command('opacity', "Set a video track's Opacity where it has no Opacity keyframes; it applies to every clip.", {
    layerId,
    opacity: described(layerSchema.shape.opacity, 'Opacity from 0 (transparent) to 1 (opaque).'),
  }),
  command(
    'layer-key-toggle',
    'Enable a setting at a track keyframe with value, creating the keyframe at frame if needed; or disable it there if it is already enabled, removing the keyframe with its last setting.',
    {
      layerId,
      frame: described(frameSchema, 'Project frame of the keyframe.'),
      setting: keyframeSetting,
      value: described(z.number(), "Value to key, within the setting's bounds; checked even when disabling."),
    },
  ),
  command('layer-key-value', 'Change the value of a setting already enabled at a track keyframe.', {
    layerId,
    frame: keyFrame,
    setting: keyframeSetting,
    value: described(z.number(), "New value, within the setting's bounds."),
  }),
  command(
    'layer-key-move',
    'Move a whole track keyframe, with all its settings and Easing, to another project frame; an occupied frame rejects the edit.',
    { layerId, frame: keyFrame, nextFrame: described(frameSchema, 'Destination project frame.') },
  ),
  command('layer-key-remove', 'Remove a whole track keyframe.', { layerId, frame: keyFrame }),
  command(
    'layer-key-default',
    'Add a default keyframe, which returns every Colour setting and Opacity to neutral from its frame on, or remove the default keyframe already there. Rejected where an ordinary keyframe exists.',
    { layerId, frame: described(frameSchema, 'Project frame of the default keyframe.') },
  ),
  command('layer-key-easing', "Set the Easing of a track keyframe's settings toward their next keyframes.", {
    layerId,
    frame: keyFrame,
    setting: described(keyframeSetting.nullable(), 'Setting to change; null sets every enabled setting.'),
    interpolation: described(interpolationSchema, 'Easing: hold, linear, ease-in, ease-out or smooth.'),
  }),
  command('layer-add', 'Add a video track on top of the others; a project has at most 8.', {
    layer: described(
      layerSchema,
      'The complete new track: unused id, name, enabled, opacity, colour, keyframes, transform, ripple, transitions (empty) and fades.',
    ),
  }),
  command(
    'layer-update',
    "Replace a video track's settings. Turning Ripple on packs its clips from the first one's start; turning it off keeps their current starts.",
    { layer: described(layerSchema, 'The complete track with the same id as an existing one.') },
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
        idSchema.nullable(),
        'Destination track for clips that all come from one track; null keeps each clip on its own track.',
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
    },
  ),
  command('fades', "Set a video track's fade from black at its first clip and to black at its last clip.", {
    layerId,
    opening: described(frameSchema, 'Frames of fade from black at the start of the first clip.'),
    closing: described(frameSchema, 'Frames of fade to black at the end of the last clip.'),
  }),
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
]);

export type EditCommand = z.infer<typeof editCommandSchema>;

const commandTypes = editCommandSchema.options.map((option) => option.shape.type.value);

/**
 * A command for tools other than edit (previews and pictures): published as a type plus fields, so each tool
 * does not repeat edit's whole schema, and validated exactly like edit.
 */
export const referencedEditCommandSchema = z
  .object({ type: described(z.enum(commandTypes as [EditCommand['type'], ...EditCommand['type'][]]), 'Command type.') })
  .catchall(z.unknown())
  .meta({ description: "An edit command exactly as the edit tool takes it: its type and that command's fields." })
  .pipe(editCommandSchema);
