import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { ColourCurvePoint, CurveChannel, HslBand } from '../../src/shared/advanced-colour.js';
import type { ColourSettings, ScalarColourSetting } from '../../src/shared/colour.js';
import { createColourSettings } from '../../src/shared/colour.js';
import { editCommandSchema, type EditCommand } from '../../src/shared/commands.js';
import { assistantEditCommandSchema, referencedEditCommandSchema } from '../../src/shared/command-schema.js';
import { createDetailSettings, type DetailSettings } from '../../src/shared/detail.js';
import type { Interpolation } from '../../src/shared/keyframes.js';
import {
  createClip,
  createLayer,
  type MusicLane,
  type SelectRange,
  type Transition,
  type VideoClip,
  type VideoLayer,
} from '../../src/shared/model.js';
import { createSpatialSettings, type SpatialChannel, type SpatialSettings } from '../../src/shared/spatial.js';
import type { SpeedSettings } from '../../src/shared/speed.js';

/**
 * The hand-written union `editCommandSchema` replaced (#228), plus the partial track settings (#252), with Colour
 * commands naming a clip grade or an adjustment (#286); the inferred type must stay identical.
 */
type FormerEditCommand =
  | {
      type: 'colour-setting';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      setting: ScalarColourSetting;
      value: number;
    }
  | {
      type: 'hsl-band';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      band: HslBand;
      values: { hue: number; saturation: number; lightness: number };
    }
  | {
      type: 'colour-curve';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      channel: CurveChannel;
      points: ColourCurvePoint[];
    }
  | { type: 'transform-setting'; layerId: string; setting: SpatialChannel; value: number }
  | { type: 'insert'; clip: Omit<VideoClip, 'grade'>; index: number }
  | { type: 'delete'; clipId: string }
  | { type: 'reorder'; clipIds: string[] }
  | { type: 'trim'; clipId: string; sourceIn: number; sourceOut: number }
  | { type: 'trim-place'; clipId: string; sourceIn: number; sourceOut: number; start: number }
  | { type: 'split'; clipId: string; sourceFrame: number; newClipId: string }
  | { type: 'remove-source-range'; clipId: string; sourceIn: number; sourceOut: number; newClipId: string }
  | { type: 'duplicate'; clipId: string; newClipId: string }
  | {
      type: 'colour';
      clipIds?: string[] | undefined;
      adjustmentId?: string | undefined;
      colour: ColourSettings;
    }
  | { type: 'speed'; clipId: string; speed: SpeedSettings }
  | { type: 'reverse'; clipId: string; reverse: boolean }
  | { type: 'transform'; layerId: string; transform: SpatialSettings }
  | { type: 'detail'; clipId: string; detail: DetailSettings }
  | { type: 'detail-clips'; clipIds: string[]; detail: DetailSettings }
  | { type: 'music'; music: MusicLane[] }
  | {
      type: 'layer-key-toggle';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      frame: number;
      setting: ScalarColourSetting;
      value: number;
    }
  | {
      type: 'layer-key-set';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      frame: number;
      values: { [K in ScalarColourSetting]?: number | null | undefined };
      easing?: Interpolation | { [K in ScalarColourSetting]?: Interpolation } | undefined;
      reset?: boolean | undefined;
    }
  | {
      type: 'layer-key-value';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      frame: number;
      setting: ScalarColourSetting;
      value: number;
    }
  | {
      type: 'layer-key-move';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      frame: number;
      nextFrame: number;
    }
  | { type: 'layer-key-remove'; clipId?: string | undefined; adjustmentId?: string | undefined; frame: number }
  | { type: 'layer-key-default'; clipId?: string | undefined; adjustmentId?: string | undefined; frame: number }
  | {
      type: 'layer-key-easing';
      clipId?: string | undefined;
      adjustmentId?: string | undefined;
      frame: number;
      setting: ScalarColourSetting | null;
      interpolation: Interpolation;
    }
  | { type: 'layer-add'; layer: VideoLayer }
  | { type: 'layer-update'; layer: VideoLayer }
  | { type: 'layer-create'; layerId: string; name: string }
  | {
      type: 'layer-options';
      layerId: string;
      name?: string | undefined;
      enabled?: boolean | undefined;
      ripple?: boolean | undefined;
    }
  | { type: 'layer-remove'; layerId: string }
  | { type: 'layer-order'; layerIds: string[] }
  | { type: 'place'; clipId: string; layerId: string; start: number; index: number }
  | { type: 'move-clips'; clipIds: string[]; delta: number; layerId: string | null }
  | { type: 'transition'; transition: Transition; keepCut?: boolean | undefined }
  | { type: 'fades'; layerId: string; opening: number; closing: number }
  | {
      type: 'adjustment-add';
      adjustmentId: string;
      start: number;
      duration: number;
      settings?: Partial<Record<ScalarColourSetting, number>> | undefined;
    }
  | { type: 'adjustment-remove'; adjustmentId: string }
  | { type: 'adjustment-range'; adjustmentId: string; start: number; duration: number; keyframes: 'move' | 'stay' }
  | { type: 'adjustment-split'; adjustmentId: string; frame: number; newAdjustmentId: string }
  | { type: 'bookmark-add'; frame: number }
  | { type: 'bookmark-move'; frame: number; nextFrame: number }
  | { type: 'bookmark-remove'; frame: number }
  | { type: 'select-set'; mediaId: string; ranges: SelectRange[] }
  | { type: 'select-narrow'; mediaId: string; ranges: SelectRange[] };

const samples: { [K in EditCommand['type']]: Extract<EditCommand, { type: K }> } = {
  insert: { type: 'insert', clip: newClip('clip-2', 'rec-1', 0, 30), index: 1 },
  delete: { type: 'delete', clipId: 'clip-1' },
  reorder: { type: 'reorder', clipIds: ['clip-2', 'clip-1'] },
  trim: { type: 'trim', clipId: 'clip-1', sourceIn: 5, sourceOut: 20 },
  'trim-place': { type: 'trim-place', clipId: 'clip-1', sourceIn: 5, sourceOut: 20, start: 10 },
  split: { type: 'split', clipId: 'clip-1', sourceFrame: 12, newClipId: 'clip-3' },
  'remove-source-range': {
    type: 'remove-source-range',
    clipId: 'clip-1',
    sourceIn: 5,
    sourceOut: 8,
    newClipId: 'clip-3',
  },
  duplicate: { type: 'duplicate', clipId: 'clip-1', newClipId: 'clip-3' },
  colour: { type: 'colour', adjustmentId: 'look', colour: createColourSettings() },
  'colour-setting': { type: 'colour-setting', clipId: 'clip-1', setting: 'exposure', value: 0.5 },
  'hsl-band': {
    type: 'hsl-band',
    adjustmentId: 'look',
    band: 'blue',
    values: { hue: 5, saturation: 0.2, lightness: 0 },
  },
  'colour-curve': {
    type: 'colour-curve',
    clipId: 'clip-1',
    channel: 'master',
    points: [
      { x: 0, y: 0.05 },
      { x: 1, y: 0.95 },
    ],
  },
  'transform-setting': { type: 'transform-setting', layerId: 'video-1', setting: 'opacity', value: 0.5 },
  speed: { type: 'speed', clipId: 'clip-1', speed: { mode: 'constant', rate: 2 } },
  reverse: { type: 'reverse', clipId: 'clip-1', reverse: true },
  transform: { type: 'transform', layerId: 'video-1', transform: createSpatialSettings() },
  detail: { type: 'detail', clipId: 'clip-1', detail: createDetailSettings() },
  'detail-clips': { type: 'detail-clips', clipIds: ['clip-1', 'clip-2'], detail: createDetailSettings() },
  music: { type: 'music', music: [] },
  'layer-key-toggle': { type: 'layer-key-toggle', clipId: 'clip-1', frame: 4, setting: 'exposure', value: 0.5 },
  'layer-key-set': {
    type: 'layer-key-set',
    adjustmentId: 'look',
    frame: -4,
    values: { exposure: 0.5, contrast: null },
    easing: { exposure: 'hold' },
    reset: false,
  },
  'layer-key-value': { type: 'layer-key-value', clipId: 'clip-1', frame: 4, setting: 'tint', value: 0.2 },
  'layer-key-move': { type: 'layer-key-move', adjustmentId: 'look', frame: -4, nextFrame: 9 },
  'layer-key-remove': { type: 'layer-key-remove', clipId: 'clip-1', frame: 4 },
  'layer-key-default': { type: 'layer-key-default', adjustmentId: 'look', frame: 4 },
  'layer-key-easing': {
    type: 'layer-key-easing',
    clipId: 'clip-1',
    frame: 4,
    setting: null,
    interpolation: 'smooth',
  },
  'layer-add': { type: 'layer-add', layer: createLayer('video-2', 'Track 2') },
  'layer-update': { type: 'layer-update', layer: createLayer('video-1', 'Renamed', false) },
  'layer-create': { type: 'layer-create', layerId: 'video-3', name: 'Overlay' },
  'layer-options': { type: 'layer-options', layerId: 'video-1', ripple: false },
  'layer-remove': { type: 'layer-remove', layerId: 'video-2' },
  'layer-order': { type: 'layer-order', layerIds: ['video-2', 'video-1'] },
  place: { type: 'place', clipId: 'clip-1', layerId: 'video-2', start: 30, index: 0 },
  'move-clips': { type: 'move-clips', clipIds: ['clip-1', 'clip-2'], delta: -3, layerId: null },
  transition: {
    type: 'transition',
    transition: { leftId: 'clip-1', rightId: 'clip-2', type: 'cross-dissolve', duration: 10 },
  },
  fades: { type: 'fades', layerId: 'video-1', opening: 15, closing: 0 },
  'adjustment-add': { type: 'adjustment-add', adjustmentId: 'look', start: 30, duration: 60 },
  'adjustment-remove': { type: 'adjustment-remove', adjustmentId: 'look' },
  'adjustment-range': { type: 'adjustment-range', adjustmentId: 'look', start: 0, duration: 90, keyframes: 'stay' },
  'adjustment-split': { type: 'adjustment-split', adjustmentId: 'look', frame: 30, newAdjustmentId: 'look-2' },
  'bookmark-add': { type: 'bookmark-add', frame: 30 },
  'bookmark-move': { type: 'bookmark-move', frame: 30, nextFrame: 45 },
  'bookmark-remove': { type: 'bookmark-remove', frame: 45 },
  'select-set': { type: 'select-set', mediaId: 'rec-1', ranges: [] },
  'select-narrow': { type: 'select-narrow', mediaId: 'rec-1', ranges: [{ sourceIn: 3, sourceOut: 9 }] },
};

function descriptionOf(schema: z.ZodType): string | undefined {
  return z.globalRegistry.get(schema)?.description;
}

/** The value a field makes optional and/or nullable. */
function unwrapped(field: z.ZodType): z.ZodType {
  return field instanceof z.ZodNullable || field instanceof z.ZodOptional
    ? unwrapped(field.unwrap() as z.ZodType)
    : field;
}

/** Paths of object fields without a description on the field or on the value it makes optional or nullable. */
function undescribedFields(schema: z.ZodType, path: string): string[] {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
    return undescribedFields(schema.unwrap() as z.ZodType, path);
  if (schema instanceof z.ZodArray) return undescribedFields(schema.element as z.ZodType, `${path}[]`);
  if (schema instanceof z.ZodUnion)
    return (schema.options as z.ZodType[]).flatMap((option) => undescribedFields(option, path));
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([name, field]) => {
    const own =
      field instanceof z.ZodLiteral || descriptionOf(field) || descriptionOf(unwrapped(field))
        ? []
        : [`${path}.${name}`];
    return [...own, ...undescribedFields(field, `${path}.${name}`)];
  });
}

function newClip(id: string, mediaId: string, sourceIn: number, sourceOut: number): Omit<VideoClip, 'grade'> {
  const { grade: _grade, ...clip } = createClip(id, mediaId, sourceIn, sourceOut);
  return clip;
}

describe('editCommandSchema', () => {
  it('infers exactly the former EditCommand union', () => {
    expectTypeOf<EditCommand>().toEqualTypeOf<FormerEditCommand>();
  });

  it('accepts one valid command of every type unchanged', () => {
    expect(editCommandSchema.options).toHaveLength(Object.keys(samples).length);
    for (const sample of Object.values(samples)) expect(editCommandSchema.parse(sample)).toEqual(sample);
  });

  it('describes every command and every field for an LLM', () => {
    for (const option of editCommandSchema.options) {
      const type = option.shape.type.value;
      expect(descriptionOf(option), type).toBeTruthy();
      for (const [field, schema] of Object.entries(option.shape)) {
        if (field !== 'type') expect(descriptionOf(schema as z.ZodType), `${type}.${field}`).toBeTruthy();
      }
    }
  });

  it('describes every nested field of the clips, tracks and settings a command carries', () => {
    expect(undescribedFields(editCommandSchema, 'command')).toEqual([]);
  });

  it('converts to a JSON Schema carrying those descriptions', () => {
    const json = z.toJSONSchema(editCommandSchema) as { oneOf?: { description?: string }[]; anyOf?: unknown[] };
    const variants = (json.oneOf ?? json.anyOf) as { description?: string; properties: Record<string, unknown> }[];
    expect(variants).toHaveLength(editCommandSchema.options.length);
    for (const variant of variants) expect(variant.description).toBeTruthy();
  });

  it('rejects unknown types, unknown fields and invalid values with a reason', () => {
    expect(editCommandSchema.safeParse({ type: 'export' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples.delete, clip: 'clip-1' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['bookmark-add'], frame: 1.5 }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['layer-key-value'], setting: 'gamma' }).success).toBe(false);
    // Opacity belongs to the track Transform, and a track has no Colour of its own.
    expect(editCommandSchema.safeParse({ ...samples['layer-key-value'], setting: 'opacity' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ type: 'opacity', layerId: 'video-1', opacity: 0.5 }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['colour-setting'], layerId: 'video-1' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['adjustment-range'], keyframes: 'follow' }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['adjustment-add'], duration: 0 }).success).toBe(false);
    expect(editCommandSchema.safeParse({ ...samples['select-narrow'], ranges: [] }).success).toBe(false);
    const error = editCommandSchema.safeParse({ ...samples.trim, sourceIn: -1 }).error;
    expect(error?.issues[0]?.path).toEqual(['sourceIn']);
  });

  it('validates commands other tools refer to exactly like edit, publishing only their type', () => {
    const assistant = Object.values(samples).filter((sample) => !['layer-add', 'layer-update'].includes(sample.type));
    for (const sample of assistant)
      expect(referencedEditCommandSchema.parse(sample)).toEqual(editCommandSchema.parse(sample));
    expect(referencedEditCommandSchema.safeParse({ ...samples.delete, clip: 'clip-1' }).success).toBe(false);
    expect(referencedEditCommandSchema.safeParse({ ...samples['bookmark-add'], frame: 1.5 }).success).toBe(false);
    expect(referencedEditCommandSchema.safeParse({ type: 'export' }).success).toBe(false);
    const published = JSON.stringify(z.toJSONSchema(referencedEditCommandSchema, { io: 'input' }));
    expect(published).toContain('colour-setting');
    expect(published.length).toBeLessThan(1_500);
  });

  it('offers the assistant every command but the two carrying a whole track', () => {
    const types = assistantEditCommandSchema.options.map((option) => option.shape.type.value);
    expect(types).toHaveLength(editCommandSchema.options.length - 2);
    expect(types).not.toContain('layer-add');
    expect(types).not.toContain('layer-update');
    expect(types).toContain('adjustment-split');
    expect(assistantEditCommandSchema.safeParse(samples['layer-update']).success).toBe(false);
    expect(referencedEditCommandSchema.safeParse(samples['layer-add']).success).toBe(false);
    expect(assistantEditCommandSchema.parse(samples['layer-create'])).toEqual(samples['layer-create']);
    expect(JSON.stringify(z.toJSONSchema(assistantEditCommandSchema, { io: 'input' })).length).toBeLessThan(60_000);
  });
});
