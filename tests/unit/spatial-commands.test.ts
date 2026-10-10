import { describe, expect, it } from 'vitest';
import { clipSpeedPreset } from '../../src/shared/clip-speed.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { needsLayeredExport, planExport, planLayeredExport } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { trimOnTimeline, validateSourceRanges } from '../../src/shared/source-range.js';
import {
  createSpatialSettings,
  evaluateSpatial,
  NEUTRAL_SPATIAL_POSE,
  type SpatialSettings,
} from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

function settings(): SpatialSettings {
  return {
    base: { ...NEUTRAL_SPATIAL_POSE, cropTop: 0.125, translateY: -0.25 },
    keyframes: [
      { frame: 0, interpolation: 'smooth', values: { ...NEUTRAL_SPATIAL_POSE, rotation: -90 } },
      { frame: 100, interpolation: 'hold', values: { ...NEUTRAL_SPATIAL_POSE, scale: 2, translateX: 0.5 } },
    ],
  };
}

function fixture(): ProjectDocument {
  const document = createProject('spatial-commands', 'Spatial commands');
  document.layers[0]!.ripple = false;
  document.layers[0]!.opacity = 0.75;
  document.layers[0]!.keyframes = [
    { frame: 10, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, exposure: 0.25, opacity: 0.5 } },
  ];
  document.layers.push(createLayer('other', 'Other', false));
  document.clips = [{ ...createClip('clip', 'original', 20, 80), start: 10, spatial: settings() }];
  document.clips[0]!.speed = {
    mode: 'curve',
    keyframes: [
      { frame: 0, rate: 1, interpolation: 'linear' },
      { frame: 100, rate: 1, interpolation: 'hold' },
    ],
  };
  document.music = [
    {
      id: 'song',
      mediaId: 'audio',
      sourceIn: 0,
      sourceOut: 120,
      start: 0,
      duration: 120,
      gainDb: -6,
      fadeIn: 3,
      fadeOut: 4,
      loop: false,
    },
  ];
  document.media = { videoIds: ['original'], audioIds: ['audio'] };
  return projectSchema.parse(document);
}

describe('strict schema-15 spatial persistence', () => {
  it('creates independent explicit neutral settings and round-trips complete poses and off-trim keys', () => {
    const first = createClip('first', 'original', 0, 1);
    const second = createClip('second', 'original', 0, 1);
    expect(first.spatial).toEqual(createSpatialSettings());
    expect(first.spatial).not.toBe(second.spatial);
    expect(first.spatial.base).not.toBe(second.spatial.base);
    expect(first.spatial.keyframes).not.toBe(second.spatial.keyframes);
    const document = fixture();
    expect(document.schemaVersion).toBe(15);
    expect(projectSchema.parse(JSON.parse(JSON.stringify(document)))).toEqual(document);
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
      expect(projectSchema.safeParse({ ...document, schemaVersion }).success).toBe(false);
  });

  const malformed: { name: string; change: (spatial: SpatialSettings) => void }[] = [
    {
      name: 'missing base',
      change: (value) => {
        Reflect.deleteProperty(value, 'base');
      },
    },
    {
      name: 'missing key array',
      change: (value) => {
        Reflect.deleteProperty(value, 'keyframes');
      },
    },
    {
      name: 'missing pose field',
      change: (value) => {
        Reflect.deleteProperty(value.base, 'scale');
      },
    },
    {
      name: 'unknown settings',
      change: (value) => {
        Object.assign(value, { migration: true });
      },
    },
    {
      name: 'unknown pose',
      change: (value) => {
        Object.assign(value.base, { opacity: 1 });
      },
    },
    {
      name: 'nonfinite base',
      change: (value) => {
        value.base.rotation = Infinity;
      },
    },
    {
      name: 'NaN key pose',
      change: (value) => {
        value.keyframes[0]!.values.scale = NaN;
      },
    },
    {
      name: 'null base setting',
      change: (value) => {
        Object.assign(value.base, { scale: null });
      },
    },
    {
      name: 'key without an enabled setting',
      change: (value) => {
        for (const channel of Object.keys(value.keyframes[0]!.values))
          Object.assign(value.keyframes[0]!.values, { [channel]: null });
      },
    },
    {
      name: 'key missing a nullable setting',
      change: (value) => {
        Reflect.deleteProperty(value.keyframes[0]!.values, 'cropLeft');
      },
    },
    {
      name: 'missing key easing',
      change: (value) => {
        Reflect.deleteProperty(value.keyframes[0]!, 'interpolation');
      },
    },
    {
      name: 'missing key pose',
      change: (value) => {
        Reflect.deleteProperty(value.keyframes[0]!, 'values');
      },
    },
    {
      name: 'unknown key metadata',
      change: (value) => {
        Object.assign(value.keyframes[0]!, { clipId: 'other' });
      },
    },
    {
      name: 'invalid easing',
      change: (value) => {
        Object.assign(value.keyframes[0]!, { interpolation: 'cubic' });
      },
    },
    {
      name: 'fractional source anchor',
      change: (value) => {
        value.keyframes[0]!.frame = 0.5;
      },
    },
    {
      name: 'negative source anchor',
      change: (value) => {
        value.keyframes[0]!.frame = -1;
      },
    },
    {
      name: 'duplicate anchors',
      change: (value) => {
        value.keyframes[1]!.frame = 0;
      },
    },
    {
      name: 'unordered anchors',
      change: (value) => {
        value.keyframes.reverse();
      },
    },
    {
      name: 'too many anchors',
      change: (value) => {
        value.keyframes = Array.from({ length: 257 }, (_, frame) => ({
          frame,
          interpolation: 'linear',
          values: { ...NEUTRAL_SPATIAL_POSE },
        }));
      },
    },
  ];
  it.each(malformed)('rejects $name without mutating the document or losing redo', ({ change }) => {
    const document = fixture();
    const history = new EditHistory(document);
    const accepted = history.commit({ type: 'spatial', clipId: 'clip', spatial: createSpatialSettings() });
    history.undo();
    const spatial = settings();
    change(spatial);
    expect(projectSchema.safeParse({ ...document, clips: [{ ...document.clips[0]!, spatial }] }).success).toBe(false);
    expect(() => history.commit({ type: 'spatial', clipId: 'clip', spatial })).toThrow();
    expect(history.current).toEqual(document);
    expect(document).toEqual(fixture());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toEqual(accepted);
  });
  it('rejects missing spatial settings, accepts 256 anchors, and validates against the original rather than trim', () => {
    const document = fixture();
    const incomplete = structuredClone(document);
    Reflect.deleteProperty(incomplete.clips[0]!, 'spatial');
    expect(projectSchema.safeParse(incomplete).success).toBe(false);
    expect(() => validateSourceRanges(document, new Map([['original', 100]]))).not.toThrow();
    document.clips[0]!.spatial.keyframes[1]!.frame = 101;
    expect(projectSchema.safeParse(document).success).toBe(true);
    expect(() => validateSourceRanges(document, new Map([['original', 100]]))).toThrow('spatial keyframes exceed');
    document.clips[0]!.spatial.keyframes = Array.from({ length: 256 }, (_, frame) => ({
      frame,
      interpolation: 'hold',
      values: { ...NEUTRAL_SPATIAL_POSE },
    }));
    expect(projectSchema.safeParse(document).success).toBe(true);
    expect(() => validateSourceRanges(document, new Map([['original', 255]]))).not.toThrow();
  });
});

describe('atomic spatial replacement and source-anchor preservation', () => {
  it('replaces only spatial settings in one Undo and owns all caller-supplied values', () => {
    const document = fixture();
    const replacement = settings();
    replacement.base.scale = 1.23456789;
    replacement.keyframes[0]!.values.rotation = 15;
    const history = new EditHistory(document);
    const next = history.commit({ type: 'spatial', clipId: 'clip', spatial: replacement });
    expect(next).toEqual({ ...document, clips: [{ ...document.clips[0]!, spatial: replacement }] });
    const geometry = (value: ProjectDocument) =>
      calculateLayout(value).clips.map(({ start, end, duration }) => ({ start, end, duration }));
    expect(geometry(next)).toEqual(geometry(document));
    replacement.base.scale = 8;
    replacement.keyframes[0]!.values.rotation = 180;
    expect(history.current.clips[0]!.spatial.base.scale).toBe(1.23456789);
    expect(history.current.clips[0]!.spatial.keyframes[0]!.values.rotation).toBe(15);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(next);
    expect(() => applyCommand(document, { type: 'spatial', clipId: 'missing', spatial: settings() })).toThrow(
      'Clip no longer exists',
    );
    const unchanged = new EditHistory(document);
    unchanged.commit({ type: 'spatial', clipId: 'clip', spatial: settings() });
    expect(unchanged.canUndo).toBe(false);
  });
  it('does not rewrite stored Ripple suffix timing during an appearance-only replacement', () => {
    const document = createProject('suffix', 'Suffix');
    document.clips = [createClip('a', 'original', 0, 10), { ...createClip('b', 'original', 10, 20), start: 99 }];
    document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
    const spatial = settings();
    expect(applyCommand(document, { type: 'spatial', clipId: 'a', spatial })).toEqual({
      ...document,
      clips: [{ ...document.clips[0]!, spatial }, document.clips[1]!],
    });
  });

  it.each(['trim', 'trim-place', 'place', 'split', 'remove-source-range', 'duplicate'] as const)(
    'retains complete original-source base/keys and independent deep copies through %s',
    (type) => {
      const document = fixture();
      const commands: Record<typeof type, EditCommand> = {
        trim: { type: 'trim', clipId: 'clip', sourceIn: 30, sourceOut: 70 },
        'trim-place': trimOnTimeline(document, 'clip', 'in', 10, 100, 'source'),
        place: { type: 'place', clipId: 'clip', layerId: 'other', start: 15, index: 0 },
        split: { type: 'split', clipId: 'clip', sourceFrame: 50, newClipId: 'right' },
        'remove-source-range': {
          type: 'remove-source-range',
          clipId: 'clip',
          sourceIn: 40,
          sourceOut: 60,
          newClipId: 'right',
        },
        duplicate: { type: 'duplicate', clipId: 'clip', newClipId: 'right' },
      };
      const next = applyCommand(document, commands[type]);
      expect(next.layers.map(({ transitions: _transitions, ...layer }) => layer)).toEqual(
        document.layers.map(({ transitions: _transitions, ...layer }) => layer),
      );
      expect(next.music).toEqual(document.music);
      for (const clip of next.clips) {
        expect(clip.spatial).toEqual(document.clips[0]!.spatial);
        expect(clip.spatial).not.toBe(document.clips[0]!.spatial);
        expect(clip.spatial.base).not.toBe(document.clips[0]!.spatial.base);
        expect(clip.spatial.keyframes[0]!.values).not.toBe(document.clips[0]!.spatial.keyframes[0]!.values);
      }
      if (next.clips.length === 2) {
        expect(next.clips[0]!.spatial).not.toBe(next.clips[1]!.spatial);
        next.clips[1]!.spatial.base.scale = 8;
        next.clips[1]!.spatial.keyframes[0]!.values.rotation = 180;
        expect(next.clips[0]!.spatial).toEqual(settings());
      }
      expect(document).toEqual(fixture());
    },
  );
  it.each([
    [20, 40],
    [60, 80],
  ])('retains all off-trim anchors after prefix/suffix removal %s–%s', (sourceIn, sourceOut) => {
    const document = fixture();
    const next = applyCommand(document, {
      type: 'remove-source-range',
      clipId: 'clip',
      sourceIn,
      sourceOut,
      newClipId: 'unused',
    });
    expect(next.clips).toHaveLength(1);
    expect(next.clips[0]!.spatial).toEqual(settings());
  });
  it('restores the full original after trimming without pruning or shifting either spatial endpoint', () => {
    const document = fixture();
    const trimmed = applyCommand(document, { type: 'trim', clipId: 'clip', sourceIn: 40, sourceOut: 60 });
    const restored = applyCommand(trimmed, { type: 'trim', clipId: 'clip', sourceIn: 0, sourceOut: 100 });
    expect(restored.clips[0]!.spatial).toEqual(settings());
    expect(restored.clips[0]!.start).toBe(document.clips[0]!.start);
    expect(restored.layers).toEqual(document.layers);
    expect(restored.music).toEqual(document.music);
    expect(() => validateSourceRanges(restored, new Map([['original', 100]]))).not.toThrow();
    expect(trimmed.clips[0]!.spatial).toEqual(settings());
    expect(document).toEqual(fixture());
  });
});

describe('continuous placed-map spatial sampling and export dispatch', () => {
  it.each(['constant', 'ramp-up', 'curve'] as const)(
    'evaluates spatial at the actual %s source position while grade/Opacity stay in project time',
    (mode) => {
      const document = fixture();
      const clip = document.clips[0]!;
      if (mode === 'constant') clip.speed = { mode: 'constant', rate: 0.5 };
      if (mode === 'ramp-up') clip.speed = clipSpeedPreset(clip, mode);
      if (mode === 'curve')
        clip.speed = {
          mode: 'curve',
          keyframes: [
            { frame: 0, rate: 0.5, interpolation: 'linear' },
            { frame: 100, rate: 2, interpolation: 'hold' },
          ],
        };
      const layout = calculateLayout(document);
      const placed = layout.clips[0]!;
      const sample = sampleTimeline(document, placed.start + 1, layout)[0]!;
      expect(sample.sourceFrame).toBe(placed.retiming.sourceAt(1));
      expect(sample.sourcePosition).toBe(placed.retiming.sourcePositionAt(1));
      expect(sample.sourcePosition).not.toBe(sample.sourceFrame);
      expect(sample.spatial).toEqual(evaluateSpatial(clip.spatial, sample.sourcePosition));
      expect(sample.spatial).not.toEqual(evaluateSpatial(clip.spatial, sample.sourceFrame));
      expect(sample.colour.exposure).toBe(0.25);
      expect(sample.opacity).toBe(0.5);
    },
  );
  it('samples each dissolve source independently at its own continuous position', () => {
    const document = createProject('dissolve-spatial', 'Dissolve spatial');
    document.clips = [
      { ...createClip('left', 'one', 0, 20), speed: { mode: 'constant', rate: 0.5 }, spatial: settings() },
      { ...createClip('right', 'two', 40, 60), speed: { mode: 'constant', rate: 0.5 }, spatial: settings() },
    ];
    document.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cross-dissolve', duration: 10 }];
    const samples = sampleTimeline(document, 31);
    expect(samples.map((sample) => sample.sourcePosition)).toEqual([15.5, 40.5]);
    expect(samples.map((sample) => sample.spatial)).toEqual([
      evaluateSpatial(settings(), 15.5),
      evaluateSpatial(settings(), 40.5),
    ]);
    expect(samples.map((sample) => sample.blendWeight)).toEqual([0.9, 0.1]);
  });
  it.each(['base', 'neutral-key', 'off-trim-key'] as const)(
    'requires layered export for %s without changing the document',
    (kind) => {
      const document = createProject('export-spatial', 'Export spatial');
      document.clips = [createClip('clip', 'original', 20, 80)];
      expect(needsLayeredExport(document)).toBe(false);
      if (kind === 'base') document.clips[0]!.spatial.base.translateX = Number.EPSILON;
      else
        document.clips[0]!.spatial.keyframes = [
          { frame: kind === 'neutral-key' ? 20 : 100, interpolation: 'hold', values: { ...NEUTRAL_SPATIAL_POSE } },
        ];
      const before = structuredClone(document);
      expect(needsLayeredExport(document)).toBe(true);
      expect(() => planExport(document)).toThrow('spatial edits');
      expect(planLayeredExport(document).duration).toBe(60);
      expect(document).toEqual(before);
    },
  );
});
