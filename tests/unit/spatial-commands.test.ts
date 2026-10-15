import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { needsLayeredExport, planExport, planLayeredExport } from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES, layerKeyframe, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { trimOnTimeline } from '../../src/shared/source-range.js';
import {
  createSpatialSettings,
  evaluateSpatial,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  type SpatialKeyframe,
  type SpatialPose,
  type SpatialSettings,
} from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

function key(frame: number, values: SpatialPose, curve: 'smooth' | 'hold' | 'linear'): SpatialKeyframe {
  return { ...uniformKeyframe(frame, values, curve), reset: false };
}

function settings(): SpatialSettings {
  return {
    base: { ...NEUTRAL_SPATIAL_POSE, cropTop: 0.125, translateY: -0.25 },
    keyframes: [
      key(0, { ...NEUTRAL_SPATIAL_POSE, rotation: -90 }, 'smooth'),
      key(100, { ...NEUTRAL_SPATIAL_POSE, scale: 2, translateX: 0.5 }, 'hold'),
    ],
  };
}

function fixture(): ProjectDocument {
  const document = createProject('spatial-commands', 'Spatial commands');
  document.layers[0]!.ripple = false;
  document.layers[0]!.opacity = 0.75;
  document.layers[0]!.keyframes = [layerKeyframe(10, { ...EMPTY_KEY_VALUES, exposure: 0.25, opacity: 0.5 }, 'linear')];
  document.layers[0]!.transform = settings();
  document.layers.push(createLayer('other', 'Other', false));
  document.clips = [{ ...createClip('clip', 'original', 20, 80), start: 10 }];
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

function withTransform(document: ProjectDocument, transform: unknown): unknown {
  return { ...document, layers: [{ ...document.layers[0]!, transform }, ...document.layers.slice(1)] };
}

describe('strict schema-21 track Transform persistence', () => {
  it('creates independent explicit neutral track settings and round-trips complete poses and keys', () => {
    const first = createLayer('first', 'First');
    const second = createLayer('second', 'Second');
    expect(first.transform).toEqual(createSpatialSettings());
    expect(first.transform).not.toBe(second.transform);
    expect(first.transform.base).not.toBe(second.transform.base);
    expect(first.transform.keyframes).not.toBe(second.transform.keyframes);
    expect(createClip('clip', 'original', 0, 1)).not.toHaveProperty('spatial');
    const document = fixture();
    expect(document.schemaVersion).toBe(21);
    expect(projectSchema.parse(JSON.parse(JSON.stringify(document)))).toEqual(document);
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
      expect(projectSchema.safeParse({ ...document, schemaVersion }).success).toBe(false);
  });

  it('rejects a missing track Transform and any saved clip spatial field, without defaults', () => {
    const document = fixture();
    const missing = structuredClone(document);
    Reflect.deleteProperty(missing.layers[0]!, 'transform');
    expect(projectSchema.safeParse(missing).success).toBe(false);
    const legacy = { ...document, clips: [{ ...document.clips[0]!, spatial: createSpatialSettings() }] };
    expect(projectSchema.safeParse(legacy).success).toBe(false);
  });

  const malformed: { name: string; change: (spatial: SpatialSettings) => void }[] = [
    { name: 'missing base', change: (value) => Reflect.deleteProperty(value, 'base') },
    { name: 'missing key array', change: (value) => Reflect.deleteProperty(value, 'keyframes') },
    { name: 'missing pose field', change: (value) => Reflect.deleteProperty(value.base, 'scale') },
    { name: 'unknown settings', change: (value) => Object.assign(value, { migration: true }) },
    { name: 'unknown pose', change: (value) => Object.assign(value.base, { opacity: 1 }) },
    {
      name: 'nonfinite base',
      change: (value) => {
        value.base.rotation = Infinity;
      },
    },
    {
      name: 'NaN key pose',
      change: (value) => {
        value.keyframes[1]!.values.scale = NaN;
      },
    },
    { name: 'null base setting', change: (value) => Object.assign(value.base, { scale: null }) },
    {
      name: 'key without an enabled setting',
      change: (value) => {
        for (const channel of Object.keys(value.keyframes[0]!.values))
          Object.assign(value.keyframes[0]!.values, { [channel]: null });
      },
    },
    {
      name: 'key missing a nullable setting',
      change: (value) => Reflect.deleteProperty(value.keyframes[0]!.values, 'cropLeft'),
    },
    { name: 'missing key easing', change: (value) => Reflect.deleteProperty(value.keyframes[0]!, 'easing') },
    { name: 'missing default flag', change: (value) => Reflect.deleteProperty(value.keyframes[0]!, 'reset') },
    {
      name: 'a legacy shared key easing',
      change: (value) => Object.assign(value.keyframes[0]!, { interpolation: 'linear' }),
    },
    {
      name: 'an enabled setting without its easing',
      change: (value) => {
        const point = value.keyframes[0]!;
        point.easing[SPATIAL_CHANNELS.find((channel) => point.values[channel] !== null)!] = null;
      },
    },
    { name: 'missing key pose', change: (value) => Reflect.deleteProperty(value.keyframes[0]!, 'values') },
    { name: 'unknown key metadata', change: (value) => Object.assign(value.keyframes[0]!, { clipId: 'other' }) },
    {
      name: 'fractional timeline frame',
      change: (value) => {
        value.keyframes[0]!.frame = 0.5;
      },
    },
    {
      name: 'negative timeline frame',
      change: (value) => {
        value.keyframes[0]!.frame = -1;
      },
    },
    {
      name: 'duplicate frames',
      change: (value) => {
        value.keyframes[1]!.frame = 0;
      },
    },
    { name: 'unordered frames', change: (value) => value.keyframes.reverse() },
    {
      name: 'too many keyframes',
      change: (value) => {
        value.keyframes = Array.from({ length: 257 }, (_, frame) => key(frame, { ...NEUTRAL_SPATIAL_POSE }, 'linear'));
      },
    },
  ];
  it.each(malformed)('rejects $name without mutating the document or losing redo', ({ change }) => {
    const document = fixture();
    const history = new EditHistory(document);
    const accepted = history.commit({ type: 'transform', layerId: 'video-1', transform: createSpatialSettings() });
    history.undo();
    const transform = settings();
    change(transform);
    expect(projectSchema.safeParse(withTransform(document, transform)).success).toBe(false);
    expect(() => history.commit({ type: 'transform', layerId: 'video-1', transform })).toThrow();
    expect(history.current).toEqual(document);
    expect(document).toEqual(fixture());
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toEqual(accepted);
  });

  it('accepts 256 keyframes and keyframes after the project duration', () => {
    const document = fixture();
    document.layers[0]!.transform.keyframes = Array.from({ length: 256 }, (_, frame) =>
      key(frame * 1000, { ...NEUTRAL_SPATIAL_POSE }, 'hold'),
    );
    expect(projectSchema.safeParse(document).success).toBe(true);
    expect(calculateLayout(document).duration).toBe(120);
  });
});

describe('atomic track Transform replacement', () => {
  it('replaces only the track Transform in one Undo and owns all caller-supplied values', () => {
    const document = fixture();
    const replacement = settings();
    replacement.base.scale = 1.23456789;
    replacement.keyframes[0]!.values.rotation = 15;
    const history = new EditHistory(document);
    const next = history.commit({ type: 'transform', layerId: 'video-1', transform: replacement });
    expect(next).toEqual(withTransform(document, replacement));
    const geometry = (value: ProjectDocument) =>
      calculateLayout(value).clips.map(({ start, end, duration }) => ({ start, end, duration }));
    expect(geometry(next)).toEqual(geometry(document));
    replacement.base.scale = 8;
    replacement.keyframes[0]!.values.rotation = 180;
    expect(history.current.layers[0]!.transform.base.scale).toBe(1.23456789);
    expect(history.current.layers[0]!.transform.keyframes[0]!.values.rotation).toBe(15);
    expect(history.undo()).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(next);
    expect(() => applyCommand(document, { type: 'transform', layerId: 'missing', transform: settings() })).toThrow(
      'Track no longer exists',
    );
    const unchanged = new EditHistory(document);
    unchanged.commit({ type: 'transform', layerId: 'video-1', transform: settings() });
    expect(unchanged.canUndo).toBe(false);
  });

  it('works on an empty track and does not rewrite stored Ripple suffix timing', () => {
    const document = createProject('suffix', 'Suffix');
    document.clips = [createClip('a', 'original', 0, 10), { ...createClip('b', 'original', 10, 20), start: 99 }];
    document.layers[0]!.transitions = [{ leftId: 'a', rightId: 'b', type: 'cut', duration: 0 }];
    document.layers.push(createLayer('empty', 'Empty'));
    const transform = settings();
    const next = applyCommand(document, { type: 'transform', layerId: 'video-1', transform });
    expect(next.clips).toEqual(document.clips);
    expect(next.layers[0]!.transform).toEqual(transform);
    expect(applyCommand(document, { type: 'transform', layerId: 'empty', transform }).layers[1]!.transform).toEqual(
      transform,
    );
  });

  it.each(['trim', 'trim-place', 'split', 'remove-source-range', 'duplicate'] as const)(
    'leaves the track Transform untouched through %s',
    (type) => {
      const document = fixture();
      const commands: Record<typeof type, EditCommand> = {
        trim: { type: 'trim', clipId: 'clip', sourceIn: 30, sourceOut: 70 },
        'trim-place': trimOnTimeline(document, 'clip', 'in', 10, 100, 'source'),
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
      for (const clip of next.clips) expect(clip).not.toHaveProperty('spatial');
      expect(document).toEqual(fixture());
    },
  );

  it('a clip moved to another track adopts that track’s Transform; both tracks keep their own', () => {
    const document = fixture();
    document.layers[1]!.transform.base.scale = 0.5;
    const moved = applyCommand(document, { type: 'place', clipId: 'clip', layerId: 'other', start: 10, index: 0 });
    expect(moved.layers.map((layer) => layer.transform)).toEqual(document.layers.map((layer) => layer.transform));
    expect(sampleTimeline(moved, 20)[0]!.spatial).toEqual({ ...NEUTRAL_SPATIAL_POSE, scale: 0.5 });
  });
});

describe('project-time Transform sampling and export dispatch', () => {
  it.each(['constant', 'curve'] as const)(
    'evaluates the track Transform at project time whatever the %s clip speed',
    (mode) => {
      const document = fixture();
      const clip = document.clips[0]!;
      clip.speed =
        mode === 'constant'
          ? { mode: 'constant', rate: 0.5 }
          : {
              mode: 'curve',
              keyframes: [
                { frame: 0, rate: 0.5, interpolation: 'linear' },
                { frame: 100, rate: 2, interpolation: 'hold' },
              ],
            };
      const layout = calculateLayout(document);
      const placed = layout.clips[0]!;
      const sample = sampleTimeline(document, placed.start + 1, layout)[0]!;
      expect(sample.spatial).toEqual(evaluateSpatial(document.layers[0]!.transform, placed.start + 1));
      expect(sample.colour.exposure).toBe(0.25);
      expect(sample.opacity).toBe(0.5);
    },
  );

  it('gives both dissolve sources the same evaluated track pose', () => {
    const document = createProject('dissolve-spatial', 'Dissolve spatial');
    document.layers[0]!.transform = settings();
    document.clips = [
      { ...createClip('left', 'one', 0, 20), speed: { mode: 'constant', rate: 0.5 } },
      { ...createClip('right', 'two', 40, 60), speed: { mode: 'constant', rate: 0.5 } },
    ];
    document.layers[0]!.transitions = [{ leftId: 'left', rightId: 'right', type: 'cross-dissolve', duration: 10 }];
    const samples = sampleTimeline(document, 31);
    expect(samples.map((sample) => sample.sourcePosition)).toEqual([15.5, 40.5]);
    expect(samples.map((sample) => sample.spatial)).toEqual([
      evaluateSpatial(settings(), 31),
      evaluateSpatial(settings(), 31),
    ]);
    expect(samples.map((sample) => sample.blendWeight)).toEqual([0.9, 0.1]);
  });

  it.each(['base', 'neutral-key', 'off-duration-key'] as const)(
    'requires layered export for %s without changing the document',
    (kind) => {
      const document = createProject('export-spatial', 'Export spatial');
      document.clips = [createClip('clip', 'original', 20, 80)];
      expect(needsLayeredExport(document)).toBe(false);
      if (kind === 'base') document.layers[0]!.transform.base.translateX = Number.EPSILON;
      else
        document.layers[0]!.transform.keyframes = [
          key(kind === 'neutral-key' ? 20 : 1000, { ...NEUTRAL_SPATIAL_POSE }, 'hold'),
        ];
      const before = structuredClone(document);
      expect(needsLayeredExport(document)).toBe(true);
      expect(() => planExport(document)).toThrow('spatial edits');
      expect(planLayeredExport(document).duration).toBe(60);
      expect(document).toEqual(before);
    },
  );
});
