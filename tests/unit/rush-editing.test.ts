import { describe, expect, it } from 'vitest';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import {
  EMPTY_KEY_VALUES,
  type Interpolation,
  type LayerKeyframe,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import {
  BASE_LAYER_ID,
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type ProjectDocument,
  type VideoClip,
  type VideoLayer,
} from '../../src/shared/model.js';
import {
  removeMarkedRange,
  sourceRangeForCut,
  trimAtPlayhead,
  type ClipCutRange,
} from '../../src/shared/rush-editing.js';
import { trimOnTimeline, validateSourceRanges } from '../../src/shared/source-range.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout, layerClips, sampleTimeline } from '../../src/shared/timeline.js';

// Complete durations of these in-memory recordings, independent of any excerpt.
const SOURCE_COUNTS = new Map([
  ['recording', 600],
  ['other', 180],
]);
const MUSIC = {
  id: 'music-instance',
  mediaId: 'music',
  sourceIn: 10,
  sourceOut: 500,
  start: 25,
  duration: 300,
  gainDb: -6,
  fadeIn: 5,
  fadeOut: 10,
  loop: false,
};
const SPEEDS: { name: string; speed: SpeedSettings }[] = [
  { name: 'constant slow', speed: { mode: 'constant', rate: 0.5 } },
  { name: 'constant fast', speed: { mode: 'constant', rate: 2 } },
  {
    name: 'source ramp',
    speed: { mode: 'ramp', startRate: 0.5, endRate: 3, anchorIn: 0, anchorOut: 600, curve: 'smooth' },
  },
];

function point(frame: number, values: Partial<LayerKeyValues>, interpolation: Interpolation = 'linear'): LayerKeyframe {
  return { frame, interpolation, values: { ...EMPTY_KEY_VALUES, ...values } };
}
function row(id: string, keyframes: LayerKeyframe[]): VideoLayer {
  return { ...createLayer(id, id, false), keyframes };
}
function rushClip(id: string, layerId: string, start: number, speed: SpeedSettings): VideoClip {
  return {
    ...createClip(id, 'recording', 100, 220),
    layerId,
    start,
    speed,
  };
}
function primaryProject(
  speed: SpeedSettings = { mode: 'constant', rate: 1 },
  keys: LayerKeyframe[] = [],
): ProjectDocument {
  const document = createProject('rush', 'Rush editing');
  document.layers[0]!.opacity = 0.65;
  document.layers[0]!.colour = {
    exposure: 0.6,
    brightness: 0.08,
    contrast: 1.2,
    hue: 25,
    saturation: 0.75,
    highlights: 0.2,
    shadows: -0.15,
  };
  document.layers[0]!.keyframes = keys;
  document.layers.push(
    row('upper', [point(10, { opacity: 0.6, exposure: 0.25 }), point(500, { opacity: 0.4, hue: 45 }, 'hold')]),
  );
  // Deliberately interleave an overlay with the primary array order.
  document.clips = [
    createClip('before', 'other', 0, 60),
    { ...createClip('upper-other', 'other', 30, 70), layerId: 'upper', start: 275 },
    rushClip('rush', BASE_LAYER_ID, 0, speed),
    createClip('after', 'other', 60, 120),
    createClip('last', 'recording', 300, 340),
  ];
  document.layers[0]!.transitions = [
    { leftId: 'before', rightId: 'rush', type: 'cut', duration: 0 },
    { leftId: 'rush', rightId: 'after', type: 'cut', duration: 0 },
    { leftId: 'after', rightId: 'last', type: 'cut', duration: 0 },
  ];
  document.music = [MUSIC];
  for (const item of calculateLayout(document).clips) item.clip.start = item.start;
  return projectSchema.parse(document);
}
function overlayProject(
  speed: SpeedSettings = { mode: 'constant', rate: 1 },
  keys: LayerKeyframe[] = [],
): ProjectDocument {
  const document = createProject('overlay-rush', 'Positioned rush editing');
  document.layers[0]!.keyframes = [point(15, { exposure: 0.5 }), point(1_000, { saturation: 1.2 })];
  const upper = row('upper', keys);
  upper.opacity = 0.65;
  document.layers.push(upper, row('other-row', [point(50, { opacity: 0.4 })]));
  const selected = rushClip('top', upper.id, 50, speed);
  const end = selected.start + compileLayerRetiming(selected, upper, selected.start).duration;
  document.clips = [
    createClip('base', 'recording', 300, 400),
    { ...createClip('upper-before', 'other', 0, 20), layerId: upper.id, start: 10 },
    selected,
    { ...createClip('upper-after', 'other', 40, 60), layerId: upper.id, start: end + 10 },
    { ...createClip('other-overlay', 'other', 80, 120), layerId: 'other-row', start: 25 },
  ];
  upper.transitions = [
    { leftId: 'upper-before', rightId: 'top', type: 'cut', duration: 0 },
    { leftId: 'top', rightId: 'upper-after', type: 'cut', duration: 0 },
  ];
  document.music = [MUSIC];
  return projectSchema.parse(document);
}
function placed(project: ProjectDocument, id: string) {
  const result = calculateLayout(project).clips.find((item) => item.clip.id === id);
  if (!result) throw new Error(`Missing fixture clip ${id}.`);
  return result;
}
function removal(
  clipId: string,
  sourceIn: number,
  sourceOut: number,
  newClipId = 'right',
): Extract<EditCommand, { type: 'remove-source-range' }> {
  return { type: 'remove-source-range', clipId, sourceIn, sourceOut, newClipId };
}
function singleCommit(document: ProjectDocument, command: EditCommand): ProjectDocument {
  const before = structuredClone(document);
  const history = new EditHistory(document);
  const next = history.commit(command);
  expect(history.canUndo).toBe(true);
  expect(history.canRedo).toBe(false);
  expect(history.undo()).toEqual(before);
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(true);
  expect(history.undo()).toEqual(before);
  expect(history.redo()).toEqual(next);
  expect(history.canUndo).toBe(true);
  expect(history.canRedo).toBe(false);
  expect(history.redo()).toEqual(next);
  expect(document).toEqual(before);
  expect(() => validateSourceRanges(next, SOURCE_COUNTS)).not.toThrow();
  return next;
}
function rejected(document: ProjectDocument, command: EditCommand, message: string | RegExp): void {
  const before = structuredClone(document);
  const history = new EditHistory(document);
  expect(() => history.commit(command)).toThrow(message);
  expect(history.current).toEqual(before);
  expect(document).toEqual(before);
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(false);
}
function expectUnchangedOthers(before: ProjectDocument, next: ProjectDocument, selectedId: string): void {
  const selectedLayerId = before.clips.find((clip) => clip.id === selectedId)!.layerId;
  const ripple = before.layers.find((layer) => layer.id === selectedLayerId)!.ripple;
  const layout = calculateLayout(next);
  expect(next.clips.filter((clip) => clip.id !== selectedId && clip.id !== 'right')).toEqual(
    before.clips
      .filter((clip) => clip.id !== selectedId)
      .map((clip) =>
        ripple && clip.layerId === selectedLayerId
          ? { ...clip, start: layout.clips.find((item) => item.clip.id === clip.id)!.start }
          : clip,
      ),
  );
  for (const [index, layer] of before.layers.entries()) {
    const updated = next.layers[index]!;
    if (layer.id !== selectedLayerId) {
      expect(updated).toEqual(layer);
      continue;
    }
    expect({ ...updated, transitions: layer.transitions }).toEqual(layer);
    const ordered = layerClips(next, layer.id);
    expect(updated.transitions).toEqual(
      ordered.slice(0, -1).map((clip, position) => {
        const rightId = ordered[position + 1]!.id;
        const surviving = layer.transitions.find((item) => item.leftId === clip.id && item.rightId === rightId);
        if (surviving) return surviving;
        const transferred =
          clip.id === 'right'
            ? layer.transitions.find((item) => item.leftId === selectedId && item.rightId === rightId)
            : undefined;
        return transferred
          ? { ...transferred, leftId: 'right' }
          : { leftId: clip.id, rightId, type: 'cut', duration: 0 };
      }),
    );
  }
  expect(next.music).toEqual(before.music);
}
function withDissolves(): ProjectDocument {
  let document = primaryProject();
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'before', rightId: 'rush', type: 'cross-dissolve', duration: 10 },
  });
  return applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'rush', rightId: 'after', type: 'cross-dissolve', duration: 12 },
  });
}

describe('project marks on one selected rush excerpt', () => {
  it('returns the exact coordinated command without persisting or mutating marks', () => {
    const document = primaryProject();
    const before = structuredClone(document);
    const selected = placed(document, 'rush');
    const range: ClipCutRange = { clipId: 'rush', inFrame: selected.start + 40, outFrame: selected.start + 70 };
    expect(sourceRangeForCut(document, range)).toEqual({ sourceIn: 140, sourceOut: 170 });
    expect(removeMarkedRange(document, range, 'right')).toEqual(removal('rush', 140, 170));
    expect(document).toEqual(before);
    expect(document).not.toHaveProperty('cutRange');
  });

  it.each(SPEEDS)('accepts both placed boundaries with the complete exclusive OUT: $name', ({ speed }) => {
    const document = primaryProject(speed);
    const selected = placed(document, 'rush');
    const full = { clipId: 'rush', inFrame: selected.start, outFrame: selected.end };
    expect(sourceRangeForCut(document, full)).toEqual({ sourceIn: 100, sourceOut: 220 });
    expect(sourceRangeForCut(document, { ...full, inFrame: selected.end - 1 })).toEqual({
      sourceIn: selected.retiming.sourceAt(selected.duration - 1),
      sourceOut: 220,
    });
    expect(
      singleCommit(document, removeMarkedRange(document, full, 'unused')).clips.some((clip) => clip.id === 'rush'),
    ).toBe(false);
  });

  it('treats UI head + 1 as exclusive OUT, distinct from quick source-frame trimming', () => {
    const document = primaryProject({ mode: 'constant', rate: 2 });
    const selected = placed(document, 'rush');
    const head = selected.start + 5;
    expect(selected.retiming.sourceAt(5)).toBe(110);
    expect(sourceRangeForCut(document, { clipId: 'rush', inFrame: selected.start + 2, outFrame: head + 1 })).toEqual({
      sourceIn: 104,
      sourceOut: 112,
    });
    expect(trimAtPlayhead(document, 'rush', head, 'out')).toEqual({
      type: 'trim',
      clipId: 'rush',
      sourceIn: 100,
      sourceOut: 111,
    });
  });

  it.each([
    { inFrame: null, outFrame: 100, error: 'both IN and OUT' },
    { inFrame: 100, outFrame: null, error: 'both IN and OUT' },
    { inFrame: null, outFrame: null, error: 'both IN and OUT' },
    { inFrame: 60.5, outFrame: 100, error: 'integer project frames' },
    { inFrame: 60, outFrame: 100.5, error: 'integer project frames' },
    { inFrame: NaN, outFrame: 100, error: 'integer project frames' },
    { inFrame: 60, outFrame: Infinity, error: 'integer project frames' },
    { inFrame: Number.MAX_SAFE_INTEGER + 1, outFrame: 100, error: 'integer project frames' },
    { inFrame: 100, outFrame: 90, error: 'OUT must be after IN' },
    { inFrame: 100, outFrame: 100, error: 'OUT must be after IN' },
    { inFrame: 180, outFrame: 180, error: 'OUT must be after IN' },
    { inFrame: 59, outFrame: 100, error: 'IN mark must be within the selected clip' },
    { inFrame: 181, outFrame: 190, error: 'IN mark must be within the selected clip' },
    { inFrame: 60, outFrame: 181, error: 'OUT mark must be within the selected clip' },
    { inFrame: 60, outFrame: 59, error: 'OUT mark must be within the selected clip' },
  ])('rejects invalid transient marks $inFrame..$outFrame', ({ inFrame, outFrame, error }) => {
    const document = primaryProject();
    const before = structuredClone(document);
    const range = { clipId: 'rush', inFrame, outFrame };
    expect(() => sourceRangeForCut(document, range)).toThrow(error);
    expect(() => removeMarkedRange(document, range, 'right')).toThrow(error);
    expect(document).toEqual(before);
  });

  it('rejects a missing selection rather than selecting another active clip', () => {
    expect(() => sourceRangeForCut(primaryProject(), { clipId: 'missing', inFrame: 60, outFrame: 100 })).toThrow(
      'selected clip no longer exists',
    );
  });

  it('rejects a slow-repeat range with no original-frame interval but allows its widened/end range', () => {
    const document = primaryProject({ mode: 'constant', rate: 0.5 });
    const selected = placed(document, 'rush');
    expect(selected.retiming.sourceAt(0)).toBe(selected.retiming.sourceAt(1));
    expect(() =>
      sourceRangeForCut(document, { clipId: 'rush', inFrame: selected.start, outFrame: selected.start + 1 }),
    ).toThrow('no original source frame');
    expect(
      sourceRangeForCut(document, { clipId: 'rush', inFrame: selected.start, outFrame: selected.start + 2 }),
    ).toEqual({ sourceIn: 100, sourceOut: 101 });
    expect(() =>
      sourceRangeForCut(document, { clipId: 'rush', inFrame: selected.end - 2, outFrame: selected.end - 1 }),
    ).toThrow('no original source frame');
    expect(sourceRangeForCut(document, { clipId: 'rush', inFrame: selected.end - 2, outFrame: selected.end })).toEqual({
      sourceIn: 219,
      sourceOut: 220,
    });
  });

  it('uses the placed map after incoming dissolve and absolute row-speed integration', () => {
    const keys = [
      point(0, { speed: 1, opacity: 0.7, exposure: -0.4 }),
      point(100, { speed: 3, hue: 15 }),
      point(1_000, { saturation: 0.8 }, 'hold'),
    ];
    const document = applyCommand(primaryProject({ mode: 'constant', rate: 8 }, keys), {
      type: 'transition',
      transition: { leftId: 'before', rightId: 'rush', type: 'cross-dissolve', duration: 5 },
    });
    const selected = placed(document, 'rush');
    expect(selected.start).toBe(37);
    const range = { clipId: 'rush', inFrame: selected.start + 10, outFrame: selected.start + 30 };
    expect(sourceRangeForCut(document, range)).toEqual({ sourceIn: 118, sourceOut: 161 });
    expect(compileRetiming(selected.clip).sourceAt(10)).not.toBe(118);
    const next = singleCommit(document, removeMarkedRange(document, range, 'right'));
    expectUnchangedOthers(document, next, 'rush');
    expect(next.layers[0]!.keyframes).toEqual(keys);
    expect(next.clips.find((clip) => clip.id === 'right')!.speed).toEqual({ mode: 'constant', rate: 8 });
    expect(next.layers[0]!.transitions.slice(0, 2)).toEqual([
      { leftId: 'before', rightId: 'rush', type: 'cross-dissolve', duration: 5 },
      { leftId: 'rush', rightId: 'right', type: 'cut', duration: 0 },
    ]);
    expect(placed(next, 'after').duration).toBe(
      compileLayerRetiming(placed(next, 'after').clip, next.layers[0]!, placed(next, 'after').start).duration,
    );
  });
});

describe('atomic source removal on the primary ripple row', () => {
  it('keeps two independent excerpts of the same original and ripples ordered neighbours', () => {
    const document = primaryProject();
    const original = placed(document, 'rush').clip;
    const next = singleCommit(
      document,
      removeMarkedRange(document, { clipId: 'rush', inFrame: 100, outFrame: 130 }, 'right'),
    );
    expect(next.clips.map((clip) => clip.id)).toEqual(['before', 'upper-other', 'rush', 'right', 'after', 'last']);
    expect(layerClips(next, BASE_LAYER_ID).map((clip) => [clip.id, clip.sourceIn, clip.sourceOut, clip.start])).toEqual(
      [
        ['before', 0, 60, 0],
        ['rush', 100, 140, 60],
        ['right', 170, 220, 100],
        ['after', 60, 120, 150],
        ['last', 300, 340, 210],
      ],
    );
    const layout = calculateLayout(next);
    expect(
      layout.clips
        .filter((item) => item.clip.layerId === BASE_LAYER_ID)
        .map((item) => [item.clip.id, item.start, item.duration, item.end]),
    ).toEqual([
      ['before', 0, 60, 60],
      ['rush', 60, 40, 100],
      ['right', 100, 50, 150],
      ['after', 150, 60, 210],
      ['last', 210, 40, 250],
    ]);
    expect(layout.clips.filter((item) => item.clip.layerId === BASE_LAYER_ID).at(-1)!.end).toBe(250);
    expect(placed(next, 'upper-other')).toMatchObject({ start: 275, duration: 40, end: 315 });
    expectUnchangedOthers(document, next, 'rush');
    expect(new Set(next.clips.map((clip) => clip.mediaId))).toEqual(
      new Set(document.clips.map((clip) => clip.mediaId)),
    );
    const left = next.clips.find((clip) => clip.id === 'rush')!;
    const right = next.clips.find((clip) => clip.id === 'right')!;
    for (const excerpt of [left, right]) {
      expect(excerpt).toMatchObject({
        mediaId: original.mediaId,
        speed: original.speed,
      });
      expect(excerpt).not.toHaveProperty('opacity');
      expect(next.layers[0]!.opacity).toBe(document.layers[0]!.opacity);
      expect(Object.keys(excerpt)).toEqual(Object.keys(original));
    }
    expect(next.layers[0]!.colour).toEqual(document.layers[0]!.colour);
    expect(left.speed).not.toBe(right.speed);
    if (left.speed.mode === 'constant') left.speed.rate = 1.5;
    expect(right).not.toHaveProperty('correction');
    expect(right.speed).toEqual({ mode: 'constant', rate: 1 });
    expect(original).not.toHaveProperty('colour');
    expect(original.speed).toEqual({ mode: 'constant', rate: 1 });
  });

  it.each([
    { name: 'prefix', sourceIn: 100, sourceOut: 130, remaining: [['rush', 130, 220]], afterStart: 150 },
    { name: 'suffix', sourceIn: 190, sourceOut: 220, remaining: [['rush', 100, 190]], afterStart: 150 },
    { name: 'whole excerpt', sourceIn: 100, sourceOut: 220, remaining: [], afterStart: 60 },
  ])(
    'removes a $name with one history step and no unnecessary new instance',
    ({ sourceIn, sourceOut, remaining, afterStart }) => {
      const document = applyCommand(primaryProject(), {
        type: 'fades',
        layerId: BASE_LAYER_ID,
        opening: 8,
        closing: 10,
      });
      const next = singleCommit(document, removal('rush', sourceIn, sourceOut));
      expect(
        next.clips
          .filter((clip) => clip.id === 'rush' || clip.id === 'right')
          .map((clip) => [clip.id, clip.sourceIn, clip.sourceOut]),
      ).toEqual(remaining);
      expect(placed(next, 'after').start).toBe(afterStart);
      expect(placed(next, 'last').start).toBe(afterStart + 60);
      expect(next.layers[0]!.openingFade).toBe(8);
      expect(next.layers[0]!.closingFade).toBe(10);
      expectUnchangedOthers(document, next, 'rush');
    },
  );

  it.each([
    { sourceIn: 100, sourceOut: 219, remaining: [[219, 220]] },
    { sourceIn: 101, sourceOut: 220, remaining: [[100, 101]] },
    {
      sourceIn: 101,
      sourceOut: 219,
      remaining: [
        [100, 101],
        [219, 220],
      ],
    },
    {
      sourceIn: 160,
      sourceOut: 161,
      remaining: [
        [100, 160],
        [161, 220],
      ],
    },
  ])('retains positive excerpts when removing source $sourceIn..$sourceOut', ({ sourceIn, sourceOut, remaining }) => {
    const next = singleCommit(primaryProject(), removal('rush', sourceIn, sourceOut));
    const excerpts = next.clips.filter((clip) => clip.id === 'rush' || clip.id === 'right');
    expect(excerpts.map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual(remaining);
    expect(excerpts.every((clip) => clip.sourceOut > clip.sourceIn && placed(next, clip.id).duration >= 1)).toBe(true);
  });

  it('deletes a one-original-frame excerpt instead of leaving an invalid empty clip', () => {
    const document = projectSchema.parse({
      ...createProject('tiny', 'Tiny'),
      clips: [createClip('tiny', 'recording', 219, 220)],
      layers: [row(BASE_LAYER_ID, [point(500, { exposure: 0.5 })])],
    });
    const next = singleCommit(document, removal('tiny', 219, 220));
    expect(next.clips).toEqual([]);
    expect(next.layers[0]!.transitions).toEqual([]);
    expect(next.layers).toEqual(document.layers);
  });

  it.each([
    { sourceIn: 140.5, sourceOut: 170, error: 'integer source frames' },
    { sourceIn: 140, sourceOut: 170.5, error: 'integer source frames' },
    { sourceIn: NaN, sourceOut: 170, error: 'integer source frames' },
    { sourceIn: 140, sourceOut: Infinity, error: 'integer source frames' },
    { sourceIn: Number.MAX_SAFE_INTEGER + 1, sourceOut: 170, error: 'integer source frames' },
    { sourceIn: 170, sourceOut: 140, error: 'OUT must be after IN' },
    { sourceIn: 140, sourceOut: 140, error: 'at least one source frame' },
    { sourceIn: 99, sourceOut: 140, error: 'within the selected clip' },
    { sourceIn: 140, sourceOut: 221, error: 'within the selected clip' },
    { sourceIn: -1, sourceOut: 140, error: 'within the selected clip' },
  ])('rejects invalid original interval $sourceIn..$sourceOut atomically', ({ sourceIn, sourceOut, error }) => {
    rejected(primaryProject(), removal('rush', sourceIn, sourceOut), error);
  });

  it.each(['before', 'rush', 'upper-other'])('rejects a colliding new instance ID %s across all rows', (newClipId) => {
    rejected(primaryProject(), removal('rush', 140, 170, newClipId), 'must be unused');
  });
  it.each(['', 'bad id', 'x'.repeat(101)])('rejects an invalid new instance ID %s', (newClipId) => {
    rejected(primaryProject(), removal('rush', 140, 170, newClipId), 'valid clip-instance ID');
  });
  it('rejects a missing clip atomically', () => {
    rejected(primaryProject(), removal('missing', 140, 170), 'Clip no longer exists');
  });

  it('preserves incoming and outgoing dissolves while making the new internal boundary a cut', () => {
    const document = withDissolves();
    const next = singleCommit(document, removal('rush', 140, 170));
    expect(next.layers[0]!.transitions).toEqual([
      { leftId: 'before', rightId: 'rush', type: 'cross-dissolve', duration: 10 },
      { leftId: 'rush', rightId: 'right', type: 'cut', duration: 0 },
      { leftId: 'right', rightId: 'after', type: 'cross-dissolve', duration: 12 },
      { leftId: 'after', rightId: 'last', type: 'cut', duration: 0 },
    ]);
    expect(placed(next, 'rush').start).toBe(50);
    expect(placed(next, 'right').start).toBe(placed(next, 'rush').end);
    expect(placed(next, 'after').start).toBe(placed(next, 'right').end - 12);
  });
  it.each([
    { sourceIn: 100, sourceOut: 140 },
    { sourceIn: 180, sourceOut: 220 },
  ])(
    'retains both original-ID transition pairs for an edge removal $sourceIn..$sourceOut',
    ({ sourceIn, sourceOut }) => {
      const document = withDissolves();
      const next = singleCommit(document, removal('rush', sourceIn, sourceOut));
      expect(next.layers[0]!.transitions).toEqual(document.layers[0]!.transitions);
      expect(next.clips.some((clip) => clip.id === 'right')).toBe(false);
    },
  );
  it('repairs the new neighbour boundary when the whole dissolved excerpt is deleted', () => {
    const next = singleCommit(withDissolves(), removal('rush', 100, 220));
    expect(next.layers[0]!.transitions).toEqual([
      { leftId: 'before', rightId: 'after', type: 'cut', duration: 0 },
      { leftId: 'after', rightId: 'last', type: 'cut', duration: 0 },
    ]);
    expect(placed(next, 'after').start).toBe(placed(next, 'before').end);
  });
  it.each([
    { sourceIn: 101, sourceOut: 170 },
    { sourceIn: 140, sourceOut: 219 },
    { sourceIn: 100, sourceOut: 210 },
    { sourceIn: 110, sourceOut: 220 },
  ])('rejects transition-invalid removal $sourceIn..$sourceOut without hidden clamping', ({ sourceIn, sourceOut }) => {
    const document = withDissolves();
    rejected(document, removal('rush', sourceIn, sourceOut), 'regions overlap or exceed');
    expect(document.layers[0]!.transitions.map((transition) => transition.duration)).toEqual([10, 12, 0]);
  });

  it.each([
    { clipId: 'before', sourceIn: 0, sourceOut: 59 },
    { clipId: 'last', sourceIn: 301, sourceOut: 340 },
  ])(
    'rejects a too-short opening/closing region on $clipId without reducing the fade',
    ({ clipId, sourceIn, sourceOut }) => {
      const document = applyCommand(primaryProject(), {
        type: 'fades',
        layerId: BASE_LAYER_ID,
        opening: 20,
        closing: 25,
      });
      rejected(document, removal(clipId, sourceIn, sourceOut), 'regions overlap or exceed');
      expect([document.layers[0]!.openingFade, document.layers[0]!.closingFade]).toEqual([20, 25]);
    },
  );
  it('validates the retained opening fade on the next clip after a whole deletion', () => {
    const document = projectSchema.parse({
      ...createProject('opening', 'Opening'),
      clips: [createClip('first', 'recording', 0, 100), createClip('short', 'other', 0, 5)],
      layers: [
        {
          ...createLayer(BASE_LAYER_ID, 'Opening'),
          transitions: [{ leftId: 'first', rightId: 'short', type: 'cut', duration: 0 }],
          openingFade: 20,
        },
      ],
    });
    rejected(document, removal('first', 0, 100), 'regions overlap or exceed');
  });
  it('retains dormant track opening/closing when its last excerpt disappears, leaving other tracks/music/keys', () => {
    const document = applyCommand(overlayProject(), {
      type: 'fades',
      layerId: BASE_LAYER_ID,
      opening: 10,
      closing: 15,
    });
    const next = singleCommit(document, removal('base', 300, 400));
    expect(layerClips(next, BASE_LAYER_ID)).toEqual([]);
    expect([next.layers[0]!.openingFade, next.layers[0]!.closingFade]).toEqual([10, 15]);
    expect(next.layers[0]!.transitions).toEqual([]);
    expectUnchangedOthers(document, next, 'base');
  });
  it('leaves an existing redo branch intact after a failed removal', () => {
    const document = withDissolves();
    const history = new EditHistory(document);
    const next = history.commit(removal('rush', 140, 170));
    history.undo();
    expect(() => history.commit(removal('rush', 101, 170))).toThrow('regions overlap or exceed');
    expect(history.current).toEqual(document);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toEqual(next);
  });

  it.each(SPEEDS)(
    'preserves static settings/source ramp anchors and rephases valid excerpt durations: $name',
    ({ speed }) => {
      const document = primaryProject(speed, [
        point(15, { exposure: 0.25, opacity: 0.4 }),
        point(900, { hue: 100 }, 'smooth'),
      ]);
      const next = singleCommit(document, removal('rush', 140, 170));
      expectUnchangedOthers(document, next, 'rush');
      const left = placed(next, 'rush');
      const right = placed(next, 'right');
      expect(right.start).toBe(left.end);
      expect(placed(next, 'after').start).toBe(right.end);
      expect(placed(next, 'after').duration).toBe(placed(document, 'after').duration);
      for (const excerpt of [left, right]) {
        expect(excerpt.clip.speed).toEqual(speed);
        expect(next.layers.map((layer) => layer.colour)).toEqual(document.layers.map((layer) => layer.colour));
        expect(excerpt.clip).not.toHaveProperty('opacity');
        expect(next.layers[0]!.opacity).toBe(0.65);
        expect(excerpt.duration).toBe(compileLayerRetiming(excerpt.clip, next.layers[0]!, excerpt.start).duration);
        const samples = Array.from({ length: excerpt.duration }, (_, frame) => excerpt.retiming.sourceAt(frame));
        expect(
          samples.every(
            (source) =>
              source >= excerpt.clip.sourceIn && source < excerpt.clip.sourceOut && (source < 140 || source >= 170),
          ),
        ).toBe(true);
      }
      expect(left.clip.speed).not.toBe(right.clip.speed);
      if (left.clip.speed.mode === 'ramp') {
        left.clip.speed.anchorIn = 50;
        expect(right.clip.speed).toEqual(speed);
        expect(placed(document, 'rush').clip.speed).toEqual(speed);
      }
    },
  );
});

describe('positioned overlay removal without neighbour ripple', () => {
  it.each([
    {
      name: 'middle',
      sourceIn: 140,
      sourceOut: 170,
      positions: [
        ['top', 50, 90],
        ['right', 120, 170],
      ],
    },
    { name: 'prefix', sourceIn: 100, sourceOut: 130, positions: [['top', 80, 170]] },
    { name: 'suffix', sourceIn: 160, sourceOut: 220, positions: [['top', 50, 110]] },
    { name: 'whole excerpt', sourceIn: 100, sourceOut: 220, positions: [] },
  ])('keeps absolute neighbours and the cut gap for a $name removal', ({ sourceIn, sourceOut, positions }) => {
    const document = overlayProject();
    const next = singleCommit(document, removal('top', sourceIn, sourceOut));
    expect(
      calculateLayout(next)
        .clips.filter((item) => item.clip.id === 'top' || item.clip.id === 'right')
        .map((item) => [item.clip.id, item.start, item.end]),
    ).toEqual(positions);
    expectUnchangedOthers(document, next, 'top');
    expect(placed(next, 'upper-before')).toMatchObject({ start: 10, end: 30 });
    expect(placed(next, 'upper-after')).toMatchObject({ start: 180, end: 200 });
    const upperOrder = layerClips(next, 'upper');
    expect(next.layers[1]!.transitions).toEqual(
      upperOrder
        .slice(0, -1)
        .map((clip, index) => ({ leftId: clip.id, rightId: upperOrder[index + 1]!.id, type: 'cut', duration: 0 })),
    );
    expect(next.layers[0]!.transitions).toEqual(document.layers[0]!.transitions);
    if (sourceIn === 140) {
      expect(sampleTimeline(next, 100).some((sample) => sample.layerId === 'upper')).toBe(false);
      expect(sampleTimeline(next, 120).find((sample) => sample.clipId === 'right')?.sourceFrame).toBe(170);
    }
  });

  it.each(SPEEDS)('anchors the right overlay at the original contextual output boundary: $name', ({ speed }) => {
    const document = overlayProject(speed, [point(0, { exposure: -0.5 }), point(1_000, { hue: 90 })]);
    const original = placed(document, 'top');
    const next = singleCommit(document, removal('top', 140, 170));
    expect(placed(next, 'top').start).toBe(original.start);
    expect(placed(next, 'right').start).toBe(original.start + original.retiming.outputAt(170));
    expect(placed(next, 'right').clip).toEqual({
      ...original.clip,
      id: 'right',
      sourceIn: 170,
      start: original.start + original.retiming.outputAt(170),
    });
    expect(placed(next, 'top').clip).toEqual({ ...original.clip, sourceOut: 140 });
    expectUnchangedOthers(document, next, 'top');
    expect(placed(next, 'upper-after').start).toBe(placed(document, 'upper-after').start);
  });

  it('maps overlay marks/cut placement with absolute row speed, retaining fixed nine-channel points', () => {
    const keys = [
      point(0, { speed: 1, opacity: 0.6, exposure: 0.3 }),
      point(100, {
        speed: 3,
        brightness: 0.1,
        contrast: 1.1,
        hue: 30,
        saturation: 0.8,
        highlights: 0.2,
        shadows: -0.1,
      }),
      point(1_000, { exposure: 0.7 }, 'hold'),
    ];
    const document = overlayProject({ mode: 'constant', rate: 8 }, keys);
    const original = placed(document, 'top');
    expect(sourceRangeForCut(document, { clipId: 'top', inFrame: 60, outFrame: 75 })).toEqual({
      sourceIn: 121,
      sourceOut: 156,
    });
    expect(original).toMatchObject({ start: 50, duration: 48, end: 98 });
    const next = singleCommit(document, removal('top', 140, 170));
    expect(placed(next, 'top')).toMatchObject({ start: 50, duration: 18, end: 68 });
    expect(placed(next, 'right')).toMatchObject({ start: 80, duration: 18, end: 98 });
    expect(placed(next, 'right').start).toBe(original.start + original.retiming.outputAt(170));
    expect(next.layers[1]!.keyframes).toEqual(keys);
    expectUnchangedOthers(document, next, 'top');
    expect(placed(next, 'upper-after')).toMatchObject({ start: 108, duration: 7, end: 115 });
  });

  it('documents duration rephasing rather than silently converting a cut to an OUT-preserving trim', () => {
    const document = overlayProject({ mode: 'constant', rate: 1.5 });
    const original = placed(document, 'top');
    expect(original.end).toBe(130);
    const cut = singleCommit(document, removal('top', 100, 101));
    expect(placed(cut, 'top')).toMatchObject({ start: 50, duration: 79, end: 129 });
    const trim = singleCommit(document, trimAtPlayhead(document, 'top', 51, 'in'));
    expect(placed(trim, 'top')).toMatchObject({ start: 51, duration: 79, end: 130 });
    expectUnchangedOthers(document, cut, 'top');
    expectUnchangedOthers(document, trim, 'top');
  });

  it('rejects a quantised internal overlap atomically rather than relocating the right excerpt', () => {
    const document = overlayProject({ mode: 'constant', rate: 3 });
    document.clips.find((clip) => clip.id === 'top')!.sourceOut = 103;
    const parsed = projectSchema.parse(document);
    expect(placed(parsed, 'top')).toMatchObject({ start: 50, duration: 1, end: 51 });
    expect(placed(parsed, 'top').retiming.outputAt(102)).toBe(0);
    rejected(parsed, removal('top', 101, 102), 'cannot overlap');
  });

  it('does not clear primary opening/closing fades when an overlay is wholly removed', () => {
    const document = applyCommand(overlayProject(), {
      type: 'fades',
      layerId: BASE_LAYER_ID,
      opening: 10,
      closing: 15,
    });
    const next = singleCommit(document, removal('top', 100, 220));
    expect([next.layers[0]!.openingFade, next.layers[0]!.closingFade]).toEqual([10, 15]);
    expectUnchangedOthers(document, next, 'top');
  });
});

describe('quick trims retain the displayed original frame', () => {
  it.each(['in', 'out'] as const)(
    'trims the primary %s endpoint and ripples without cropping the recording',
    (edge) => {
      const document = primaryProject();
      const selected = placed(document, 'rush');
      const frame = selected.start + 20;
      const command = trimAtPlayhead(document, 'rush', frame, edge);
      expect(command).toEqual({
        type: 'trim',
        clipId: 'rush',
        sourceIn: edge === 'in' ? 120 : 100,
        sourceOut: edge === 'out' ? 121 : 220,
      });
      const next = singleCommit(document, command);
      const retained = placed(next, 'rush');
      expect(retained.retiming.sourceAt(edge === 'in' ? 0 : retained.duration - 1)).toBe(120);
      expect(placed(next, 'after').start).toBe(retained.end);
      expectUnchangedOthers(document, next, 'rush');
      expect(SOURCE_COUNTS.get('recording')).toBe(600);
    },
  );

  it.each(SPEEDS)('uses observed source + 1, never the next dropped/repeated output sample: $name', ({ speed }) => {
    const document = primaryProject(speed);
    const selected = placed(document, 'rush');
    const frame = selected.start + Math.floor(selected.duration / 2);
    const source = selected.retiming.sourceAt(frame - selected.start);
    for (const edge of ['in', 'out'] as const) {
      const command = trimAtPlayhead(document, 'rush', frame, edge);
      const delta = edge === 'in' ? source - selected.clip.sourceIn : source + 1 - selected.clip.sourceOut;
      expect(command).toEqual(trimOnTimeline(document, 'rush', edge, delta, selected.clip.sourceOut, 'source'));
      const next = singleCommit(document, command);
      const retained = placed(next, 'rush').clip;
      expect(retained.sourceIn).toBe(edge === 'in' ? source : 100);
      expect(retained.sourceOut).toBe(edge === 'out' ? source + 1 : 220);
      expect(retained.speed).toEqual(speed);
      expectUnchangedOthers(document, next, 'rush');
    }
  });

  it('quick-trims through row-speed override using the selected placed context', () => {
    const keys = [point(0, { speed: 1, exposure: 0.5 }), point(100, { speed: 3 }), point(1_000, { opacity: 0.4 })];
    const document = primaryProject({ mode: 'constant', rate: 8 }, keys);
    const selected = placed(document, 'rush');
    expect(selected.start).toBe(42);
    expect(selected.retiming.sourceAt(10)).toBe(119);
    for (const edge of ['in', 'out'] as const) {
      const next = singleCommit(document, trimAtPlayhead(document, 'rush', selected.start + 10, edge));
      expect(placed(next, 'rush').clip).toMatchObject({
        sourceIn: edge === 'in' ? 119 : 100,
        sourceOut: edge === 'out' ? 120 : 220,
      });
      expect(next.layers[0]!.keyframes).toEqual(keys);
      expectUnchangedOthers(document, next, 'rush');
    }
  });

  it.each(['in', 'out'] as const)(
    'keeps overlay neighbours fixed for quick %s trim and preserves OUT on IN trim',
    (edge) => {
      const keys = [point(0, { speed: 1 }), point(100, { speed: 3 }), point(1_000, { hue: 60 })];
      const document = overlayProject({ mode: 'constant', rate: 8 }, keys);
      const selected = placed(document, 'top');
      const next = singleCommit(document, trimAtPlayhead(document, 'top', 70, edge));
      const retained = placed(next, 'top');
      expect(retained.clip).toMatchObject({
        sourceIn: edge === 'in' ? 144 : 100,
        sourceOut: edge === 'out' ? 145 : 220,
      });
      if (edge === 'in') expect(retained.end).toBe(selected.end);
      else expect(retained.start).toBe(selected.start);
      expectUnchangedOthers(document, next, 'top');
    },
  );

  it('rejects an unrepresentable overlay IN trim but permits its positioned source-prefix cut', () => {
    const document = overlayProject({ mode: 'constant', rate: 1 }, [
      point(0, { speed: 7.5 }, 'hold'),
      point(40, { speed: 0.1 }),
    ]);
    const clip = document.clips.find((item) => item.id === 'top')!;
    clip.start = 30;
    clip.sourceOut = 185;
    const parsed = projectSchema.parse(document);
    const selected = placed(parsed, 'top');
    expect(selected.end).toBe(140);
    expect(selected.retiming.sourceAt(1)).toBe(107);
    const before = structuredClone(parsed);
    const history = new EditHistory(parsed);
    expect(() => history.commit(trimAtPlayhead(history.current, 'top', 31, 'in'))).toThrow(
      'cannot keep the positioned clip OUT',
    );
    expect(history.current).toEqual(before);
    expect(history.canUndo).toBe(false);
    const cut = singleCommit(parsed, removal('top', 100, 107));
    expect(placed(cut, 'top')).toMatchObject({ start: 30, duration: 40, end: 70 });
    expectUnchangedOthers(parsed, cut, 'top');
  });

  it.each(SPEEDS)('retains at least one original frame when trimming at either extreme: $name', ({ speed }) => {
    const document = primaryProject(speed);
    const selected = placed(document, 'rush');
    const firstOnly = singleCommit(document, trimAtPlayhead(document, 'rush', selected.start, 'out'));
    expect(placed(firstOnly, 'rush').clip).toMatchObject({ sourceIn: 100, sourceOut: 101 });
    const tail = singleCommit(document, trimAtPlayhead(document, 'rush', selected.end - 1, 'in'));
    expect(placed(tail, 'rush').clip.sourceIn).toBe(selected.retiming.sourceAt(selected.duration - 1));
    expect(placed(tail, 'rush').clip.sourceOut).toBe(220);
    expect(placed(tail, 'rush').duration).toBeGreaterThanOrEqual(1);
  });

  it.each(['primary', 'overlay'] as const)(
    'leaves repeated endpoint quick trims out of history on the %s row',
    (mode) => {
      const document =
        mode === 'primary'
          ? primaryProject({ mode: 'constant', rate: 0.5 })
          : overlayProject({ mode: 'constant', rate: 0.5 });
      const clipId = mode === 'primary' ? 'rush' : 'top';
      const selected = placed(document, clipId);
      for (const [edge, frame] of [
        ['in', selected.start + 1],
        ['out', selected.end - 2],
      ] as const) {
        const history = new EditHistory(document);
        expect(history.commit(trimAtPlayhead(history.current, clipId, frame, edge))).toEqual(document);
        expect(history.canUndo).toBe(false);
        expect(history.canRedo).toBe(false);
      }
    },
  );
  it('returns harmless unchanged trims for a whole one-frame repeated excerpt', () => {
    const document = projectSchema.parse({
      ...createProject('single', 'Single'),
      clips: [{ ...createClip('single', 'recording', 219, 220), speed: { mode: 'constant', rate: 0.1 } }],
    });
    for (const edge of ['in', 'out'] as const) {
      const history = new EditHistory(document);
      expect(history.commit(trimAtPlayhead(history.current, 'single', 5, edge))).toEqual(document);
      expect(history.canUndo).toBe(false);
    }
  });
  it('does not discard a redo branch for an endpoint quick-trim no-op', () => {
    const document = primaryProject();
    const history = new EditHistory(document);
    const changed = history.commit({ type: 'opacity', layerId: BASE_LAYER_ID, opacity: 0.8 });
    history.undo();
    expect(history.commit(trimAtPlayhead(history.current, 'rush', placed(document, 'rush').start, 'in'))).toEqual(
      document,
    );
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo()).toEqual(changed);
  });

  it.each([0, 59, 180, 181])(
    'rejects playhead %s outside the selected half-open clip instead of ignoring/clamping it',
    (frame) => {
      const document = primaryProject();
      for (const edge of ['in', 'out'] as const)
        expect(() => trimAtPlayhead(document, 'rush', frame, edge)).toThrow('inside the selected clip');
      expect(sourceRangeForCut(document, { clipId: 'rush', inFrame: 60, outFrame: 180 })).toEqual({
        sourceIn: 100,
        sourceOut: 220,
      });
    },
  );
  it.each([60.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects noninteger/nonfinite quick-trim frame %s',
    (frame) => {
      expect(() => trimAtPlayhead(primaryProject(), 'rush', frame, 'in')).toThrow('integer project frame');
    },
  );
  it('rejects missing selections and unknown quick-trim edges', () => {
    const document = primaryProject();
    expect(() => trimAtPlayhead(document, 'missing', 60, 'in')).toThrow('selected clip no longer exists');
    expect(() => trimAtPlayhead(document, 'rush', 60, 'left' as 'in')).toThrow('edge must be IN or OUT');
  });
});
