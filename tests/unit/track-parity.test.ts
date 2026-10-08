import { describe, expect, it } from 'vitest';
import { decoderPoolSize } from '../../src/preview/assignment.js';
import { gradePixel, NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { applyCommand, EditHistory, type EditCommand } from '../../src/shared/commands.js';
import { compositePixel } from '../../src/shared/composition.js';
import {
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  planExport,
  planLayeredExport,
} from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES, type LayerKeyframe } from '../../src/shared/keyframes.js';
import { compileLayerRetiming } from '../../src/shared/layer-retiming.js';
import {
  BASE_LAYER_ID,
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type ProjectDocument,
  type Transition,
} from '../../src/shared/model.js';
import { trimOnTimeline } from '../../src/shared/source-range.js';
import { calculateLayout, layerClips, sampleTimeline } from '../../src/shared/timeline.js';
import { clipStartRestriction, layerActionRestrictions } from '../../src/web/layer-actions.js';
import { planTimelineDrop } from '../../src/web/timeline-placement.js';
import { timelineRows } from '../../src/web/timeline-rows.js';
import { unsupportedProject } from './project-fixtures.js';

const TRACK_IDS = ['ground', 'middle', 'sky'];
const cases = TRACK_IDS.flatMap((layerId) => [false, true].map((ripple) => ({ layerId, ripple })));
const cut = (leftId: string, rightId: string): Transition => ({ leftId, rightId, type: 'cut', duration: 0 });
const point = (frame: number, speed: number): LayerKeyframe => ({
  frame,
  interpolation: 'hold',
  values: { ...EMPTY_KEY_VALUES, speed, exposure: 0.123456789 },
});

function fixture(selectedId = 'middle', ripple = false): ProjectDocument {
  const document = createProject('parity', 'Uniform tracks');
  document.layers = TRACK_IDS.map((id) => createLayer(id, id, id === selectedId ? ripple : !ripple));
  // Interleaved flat storage is not track order or composition priority.
  document.clips = ['a', 'b', 'c'].flatMap((suffix, index) =>
    document.layers.map((layer, track) => ({
      ...createClip(`${layer.id}-${suffix}`, `source-${track}`, 100, 130, layer.id),
      start: 10 + index * (layer.ripple ? 30 : 50),
    })),
  );
  for (const layer of document.layers)
    layer.transitions = [cut(`${layer.id}-a`, `${layer.id}-b`), cut(`${layer.id}-b`, `${layer.id}-c`)];
  document.music = [
    {
      id: 'song-instance',
      mediaId: 'song',
      sourceIn: 7,
      sourceOut: 307,
      start: 19,
      duration: 200,
      gainDb: -6,
      fadeIn: 3,
      fadeOut: 5,
      loop: false,
    },
  ];
  return projectSchema.parse(document);
}
function starts(document: ProjectDocument, layerId: string): number[] {
  return calculateLayout(document)
    .clips.filter((clip) => clip.clip.layerId === layerId)
    .map((clip) => clip.start);
}
function expectOtherTracks(
  before: ProjectDocument,
  next: ProjectDocument,
  layerId: string,
  expectedKeys = before.layers.find((layer) => layer.id === layerId)!.keyframes,
): void {
  expect(next.layers.filter((layer) => layer.id !== layerId)).toEqual(
    before.layers.filter((layer) => layer.id !== layerId),
  );
  expect(next.clips.filter((clip) => clip.layerId !== layerId)).toEqual(
    before.clips.filter((clip) => clip.layerId !== layerId),
  );
  expect(next.music).toEqual(before.music);
  expect(next.media).toEqual(before.media);
  expect(next.layers.find((layer) => layer.id === layerId)!.keyframes).toEqual(expectedKeys);
  for (const placed of calculateLayout(next).clips) expect(placed.clip.start).toBe(placed.start);
}
function oneStep(document: ProjectDocument, command: EditCommand): ProjectDocument {
  const before = structuredClone(document);
  const history = new EditHistory(document);
  const next = history.commit(command);
  expect(history.canUndo).toBe(true);
  expect(history.canRedo).toBe(false);
  expect(history.undo()).toEqual(before);
  expect(history.canUndo).toBe(false);
  expect(history.redo()).toEqual(next);
  expect(history.canRedo).toBe(false);
  expect(document).toEqual(before);
  return next;
}
function rejected(document: ProjectDocument, command: EditCommand, message: string): void {
  const before = structuredClone(document);
  const history = new EditHistory(document);
  expect(() => history.commit(command)).toThrow(message);
  expect(history.current).toEqual(before);
  expect(document).toEqual(before);
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(false);
}

describe('strict uniform schema-11 tracks', () => {
  it('uses Ripple ON for the initial track and every newly created track', () => {
    const initial = createProject('new', 'New');
    expect(initial.schemaVersion).toBe(11);
    expect(initial.layers).toEqual([createLayer(BASE_LAYER_ID, 'Video 1')]);
    for (const id of [BASE_LAYER_ID, ...Array.from({ length: 8 }, (_, index) => `arbitrary-${index}`)]) {
      expect(createLayer(id, 'Track')).toEqual({
        id,
        name: 'Track',
        enabled: true,
        opacity: 1,
        colour: { ...NEUTRAL_COLOUR },
        keyframes: [],
        ripple: true,
        transitions: [],
        openingFade: 0,
        closingFade: 0,
      });
    }
    const added = oneStep(initial, { type: 'layer-add', layer: createLayer('second', 'Second') });
    expect(added.layers.map((layer) => layer.ripple)).toEqual([true, true]);
    expect(createLayer('positioned', 'Positioned', false).ripple).toBe(false);
  });

  it('requires every new track field, rejects old global fields and never injects fallbacks', () => {
    const document = fixture();
    expect(projectSchema.parse(document)).toEqual(document);
    for (const field of ['colour', 'opacity', 'ripple', 'transitions', 'openingFade', 'closingFade'] as const) {
      const { [field]: _missing, ...incomplete } = document.layers[0]!;
      expect(projectSchema.safeParse({ ...document, layers: [incomplete, ...document.layers.slice(1)] }).success).toBe(
        false,
      );
    }
    for (const extra of [{ transitions: [] }, { openingFade: 0 }, { closingFade: 0 }])
      expect(projectSchema.safeParse({ ...document, ...extra }).success).toBe(false);
    for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(projectSchema.safeParse({ ...document, schemaVersion }).success).toBe(false);
    expect(projectSchema.safeParse(unsupportedProject(5, 'old', 'Unsupported topology')).success).toBe(false);
    expect(document).not.toHaveProperty('transitions');
    expect(document).not.toHaveProperty('openingFade');
    expect(document).not.toHaveProperty('closingFade');
    for (const start of [-1, 0.5, NaN, Infinity, 2_147_483_648]) {
      for (const selected of document.clips)
        expect(
          projectSchema.safeParse({
            ...document,
            clips: document.clips.map((clip) => (clip.id === selected.id ? { ...clip, start } : clip)),
          }).success,
        ).toBe(false);
    }
    const { start: _start, ...incompleteClip } = document.clips[0]!;
    expect(projectSchema.safeParse({ ...document, clips: [incompleteClip, ...document.clips.slice(1)] }).success).toBe(
      false,
    );
  });

  it('retains all explicit clip starts and track identities through strict JSON round-trip', () => {
    const document = fixture('ground', false);
    const before = structuredClone(document);
    const reopened = projectSchema.parse(JSON.parse(JSON.stringify(document)));
    expect(reopened).toEqual(before);
    expect(reopened.layers[0]!.id).not.toBe(BASE_LAYER_ID);
    expect(reopened.clips.map((clip) => clip.start)).toEqual(document.clips.map((clip) => clip.start));
    expect(starts(reopened, 'ground')).toEqual([10, 60, 110]);
    expect(starts(reopened, 'sky')).toEqual([10, 40, 70]);
  });

  it('reorders/removes the arbitrary first track with only stack-end and last-track guards', () => {
    const document = fixture();
    const reordered = oneStep(document, { type: 'layer-order', layerIds: ['sky', 'middle', 'ground'] });
    expect(reordered.clips).toEqual(document.clips);
    expect(reordered.music).toEqual(document.music);
    expect(timelineRows(reordered.layers).map((row) => row.layer.id)).toEqual(['sky', 'middle', 'ground']);
    const source = (sample: ReturnType<typeof sampleTimeline>[number]): [number, number, number] =>
      sample.layerId === 'ground' ? [1, 0, 0] : sample.layerId === 'middle' ? [0, 1, 0] : [0, 0, 1];
    expect(compositePixel(sampleTimeline(document, 20), source)).toEqual(gradePixel([0, 0, 1], NEUTRAL_COLOUR));
    expect(compositePixel(sampleTimeline(reordered, 20), source)).toEqual(gradePixel([1, 0, 0], NEUTRAL_COLOUR));
    expect(calculateLayout(reordered).duration).toBe(calculateLayout(document).duration);
    for (const layer of reordered.layers) expect(layer).toEqual(document.layers.find((item) => item.id === layer.id));
    const removed = oneStep(document, { type: 'layer-remove', layerId: 'ground' });
    expect(removed.clips).toEqual(document.clips.filter((clip) => clip.layerId !== 'ground'));
    expect(removed.layers).toEqual(document.layers.slice(1));
    const last = applyCommand(removed, { type: 'layer-remove', layerId: 'middle' });
    rejected(last, { type: 'layer-remove', layerId: 'sky' }, 'last video track');
    expect(layerActionRestrictions(0, 3, false)).toEqual({
      raise: null,
      lower: 'This track is already the bottom composition layer.',
      remove: null,
    });
    expect(layerActionRestrictions(2, 3, false)).toEqual({
      raise: 'This track is already the top composition layer.',
      lower: null,
      remove: null,
    });
  });
});

describe('independent Ripple toggles and packed placements', () => {
  it.each(cases)(
    'visibility and opacity on $layerId are independent of Ripple=$ripple and never alter timing',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const layer = document.layers.find((item) => item.id === layerId)!;
      const hidden = oneStep(document, { type: 'layer-update', layer: { ...layer, enabled: false } });
      expect(hidden.clips).toEqual(document.clips);
      expect(starts(hidden, layerId)).toEqual(starts(document, layerId));
      expect(calculateLayout(hidden).duration).toBe(calculateLayout(document).duration);
      expect(sampleTimeline(hidden, 20).map((sample) => sample.layerId)).toEqual(
        TRACK_IDS.filter((id) => id !== layerId),
      );
      expectOtherTracks(document, hidden, layerId);
      const translucent = oneStep(document, { type: 'opacity', layerId, opacity: 0.23456789 });
      expect(translucent.layers.find((item) => item.id === layerId)).toEqual({ ...layer, opacity: 0.23456789 });
      expect(translucent.clips).toEqual(document.clips);
      expect(starts(translucent, layerId)).toEqual(starts(document, layerId));
      expect(calculateLayout(translucent).duration).toBe(calculateLayout(document).duration);
      expect(sampleTimeline(translucent, 20).map((sample) => [sample.layerId, sample.opacity])).toEqual(
        TRACK_IDS.map((id) => [id, id === layerId ? 0.23456789 : 1]),
      );
      expectOtherTracks(document, translucent, layerId);
    },
  );

  it.each(TRACK_IDS)('enabling %s closes gaps from its existing anchor in exactly one Undo', (layerId) => {
    const document = fixture(layerId, false);
    const layer = document.layers.find((item) => item.id === layerId)!;
    layer.keyframes = [point(0, 1), point(600, 1)];
    layer.openingFade = 2;
    layer.closingFade = 3;
    // Chronological order must be captured rather than the interleaved flat order.
    const reversed = document.clips.filter((clip) => clip.layerId === layerId).reverse();
    let cursor = 0;
    document.clips = document.clips.map((clip) => (clip.layerId === layerId ? reversed[cursor++]! : clip));
    const next = oneStep(document, { type: 'layer-update', layer: { ...layer, ripple: true } });
    expect(starts(next, layerId)).toEqual([10, 40, 70]);
    expect(layerClips(next, layerId).map((clip) => clip.id)).toEqual(
      ['a', 'b', 'c'].map((suffix) => `${layerId}-${suffix}`),
    );
    expect(next.layers.find((item) => item.id === layerId)).toEqual({ ...layer, ripple: true });
    expectOtherTracks(document, next, layerId);
  });

  it.each(TRACK_IDS)('disabling %s captures actual starts and then preserves independent placement', (layerId) => {
    const document = fixture(layerId, true);
    const layer = document.layers.find((item) => item.id === layerId)!;
    const next = oneStep(document, { type: 'layer-update', layer: { ...layer, ripple: false } });
    expect(starts(next, layerId)).toEqual([10, 40, 70]);
    expect(next.clips).toEqual(document.clips);
    const moved = oneStep(next, {
      type: 'place',
      clipId: `${layerId}-c`,
      layerId,
      start: 120,
      index: next.clips.findIndex((clip) => clip.id === `${layerId}-c`),
    });
    expect(starts(moved, layerId)).toEqual([10, 40, 120]);
    expectOtherTracks(document, moved, layerId);
  });

  it.each(TRACK_IDS)(
    'packing %s rejects a contextual Speed/fade conflict instead of shortening its retained fade',
    (layerId) => {
      const document = fixture(layerId, false);
      const layer = document.layers.find((item) => item.id === layerId)!;
      layer.keyframes = [point(0, 8), point(100, 1)];
      layer.closingFade = 10;
      expect(
        calculateLayout(document)
          .clips.filter((clip) => clip.clip.layerId === layerId)
          .map((clip) => [clip.start, clip.duration]),
      ).toEqual([
        [10, 4],
        [60, 4],
        [110, 30],
      ]);
      rejected(document, { type: 'layer-update', layer: { ...layer, ripple: true } }, 'regions overlap or exceed');
      expect(layer.closingFade).toBe(10);
      expect(starts(document, layerId)).toEqual([10, 60, 110]);
    },
  );

  it.each(TRACK_IDS)('disabling %s retains a dissolve and all of its actual saved integer starts', (layerId) => {
    const original = fixture(layerId, true);
    const document = applyCommand(original, {
      type: 'transition',
      transition: { leftId: `${layerId}-a`, rightId: `${layerId}-b`, type: 'cross-dissolve', duration: 5 },
    });
    const layer = document.layers.find((item) => item.id === layerId)!;
    const next = oneStep(document, { type: 'layer-update', layer: { ...layer, ripple: false } });
    expect(starts(next, layerId)).toEqual([10, 35, 65]);
    expect(next.clips).toEqual(document.clips);
    expect(next.layers.find((item) => item.id === layerId)).toEqual({ ...layer, ripple: false });
    expect(sampleTimeline(next, 37)).toEqual(sampleTimeline(document, 37));
    expectOtherTracks(document, next, layerId);
  });

  it.each(cases)('trim/delete/duplicate on $layerId obey only its Ripple=$ripple setting', ({ layerId, ripple }) => {
    const document = fixture(layerId, ripple);
    const trimmed = oneStep(document, { type: 'trim', clipId: `${layerId}-a`, sourceIn: 100, sourceOut: 120 });
    expect(starts(trimmed, layerId)).toEqual(ripple ? [10, 30, 60] : [10, 60, 110]);
    expectOtherTracks(document, trimmed, layerId);
    const deleted = oneStep(document, { type: 'delete', clipId: `${layerId}-a` });
    expect(starts(deleted, layerId)).toEqual(ripple ? [10, 40] : [60, 110]);
    expectOtherTracks(document, deleted, layerId);
    const duplicate = oneStep(document, { type: 'duplicate', clipId: `${layerId}-c`, newClipId: 'copy' });
    expect(starts(duplicate, layerId)).toEqual(ripple ? [10, 40, 70, 100] : [10, 60, 110, 140]);
    expect(duplicate.clips.find((clip) => clip.id === 'copy')).toEqual({
      ...document.clips.find((clip) => clip.id === `${layerId}-c`)!,
      id: 'copy',
      start: ripple ? 100 : 140,
    });
    expectOtherTracks(document, duplicate, layerId);
  });

  it.each(cases)(
    'split, range cut and insertion retain every stored start on $layerId with Ripple=$ripple',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const selected = document.clips.find((clip) => clip.id === `${layerId}-b`)!;
      const start = ripple ? 40 : 60;
      const split = oneStep(document, { type: 'split', clipId: selected.id, sourceFrame: 110, newClipId: 'piece' });
      expect(starts(split, layerId)).toEqual(ripple ? [10, 40, 50, 70] : [10, 60, 70, 110]);
      expect(split.clips.find((clip) => clip.id === 'piece')).toEqual({
        ...selected,
        id: 'piece',
        sourceIn: 110,
        start: start + 10,
      });
      expectOtherTracks(document, split, layerId);
      const cutRange = oneStep(document, {
        type: 'remove-source-range',
        clipId: selected.id,
        sourceIn: 110,
        sourceOut: 120,
        newClipId: 'piece',
      });
      expect(starts(cutRange, layerId)).toEqual(ripple ? [10, 40, 50, 60] : [10, 60, 80, 110]);
      expect(cutRange.clips.find((clip) => clip.id === selected.id)).toEqual({ ...selected, sourceOut: 110 });
      expect(cutRange.clips.find((clip) => clip.id === 'piece')).toEqual({
        ...selected,
        id: 'piece',
        sourceIn: 120,
        start: start + (ripple ? 10 : 20),
      });
      expectOtherTracks(document, cutRange, layerId);
      const inserted = oneStep(document, {
        type: 'insert',
        clip: { ...createClip('inserted', 'source-new', 300, 310, layerId), start: ripple ? 0 : 45 },
        index: document.clips.findIndex((clip) => clip.id === selected.id),
      });
      expect(starts(inserted, layerId)).toEqual(ripple ? [10, 40, 50, 80] : [10, 45, 60, 110]);
      expect(inserted.clips.find((clip) => clip.id === 'inserted')!.start).toBe(ripple ? 40 : 45);
      expectOtherTracks(document, inserted, layerId);
    },
  );

  it.each(TRACK_IDS)(
    'reordering %s preserves its first placement anchor; explicitly moving the retained first clip changes it',
    (layerId) => {
      const document = fixture(layerId, true);
      const order = [`${layerId}-c`, `${layerId}-a`, `${layerId}-b`];
      let cursor = 0;
      const clipIds = document.clips.map((clip) => (clip.layerId === layerId ? order[cursor++]! : clip.id));
      const reordered = oneStep(document, { type: 'reorder', clipIds });
      expect(layerClips(reordered, layerId).map((clip) => [clip.id, clip.start])).toEqual(
        order.map((id, index) => [id, 10 + index * 30]),
      );
      expectOtherTracks(document, reordered, layerId);
      const first = document.clips.find((clip) => clip.id === `${layerId}-a`)!;
      const moved = oneStep(document, {
        type: 'place',
        clipId: first.id,
        layerId,
        start: 25,
        index: document.clips.indexOf(first),
      });
      expect(starts(moved, layerId)).toEqual([25, 55, 85]);
      expectOtherTracks(document, moved, layerId);
    },
  );

  it.each(cases)(
    'a move from $layerId keeps source bases/row points while each affected track follows its own Ripple setting',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const targetId = TRACK_IDS[(TRACK_IDS.indexOf(layerId) + 1) % TRACK_IDS.length]!;
      const selected = document.clips.find((clip) => clip.id === `${layerId}-a`)!;
      document.layers.forEach((layer) => {
        layer.keyframes = [point(0, 1), point(600, 1)];
      });
      document.layers.find((layer) => layer.id === layerId)!.colour.exposure = 0.123456789;
      document.layers.find((layer) => layer.id === layerId)!.opacity = 0.654321;
      document.layers.find((layer) => layer.id === targetId)!.opacity = 0.345678;
      const plan = planTimelineDrop(
        document,
        { kind: 'clip', clipId: selected.id, grabFrame: 0 },
        targetId,
        200,
        false,
        0,
        0,
      );
      expect(plan).toMatchObject({
        start: ripple ? 200 : 100,
        duration: 30,
        mode: ripple ? 'position' : 'ripple',
        error: '',
      });
      const next = oneStep(document, plan.command!);
      expect(starts(next, layerId)).toEqual(ripple ? [10, 40] : [60, 110]);
      expect(starts(next, targetId)).toEqual(ripple ? [10, 60, 110, 200] : [10, 40, 70, 100]);
      expect(next.clips.find((clip) => clip.id === selected.id)).toEqual({
        ...selected,
        layerId: targetId,
        start: plan.start,
      });
      expect(next.clips.find((clip) => clip.id === selected.id)).not.toHaveProperty('opacity');
      expect(sampleTimeline(next, plan.start).find((sample) => sample.clipId === selected.id)!.opacity).toBe(0.345678);
      for (const layer of next.layers) {
        const original = document.layers.find((item) => item.id === layer.id)!;
        expect({ ...layer, transitions: original.transitions }).toEqual(original);
      }
      expect(next.music).toEqual(document.music);
      const unaffectedId = TRACK_IDS.find((id) => id !== layerId && id !== targetId)!;
      expect(next.clips.filter((clip) => clip.layerId === unaffectedId)).toEqual(
        document.clips.filter((clip) => clip.layerId === unaffectedId),
      );
      for (const placed of calculateLayout(next).clips) expect(placed.clip.start).toBe(placed.start);
    },
  );

  it.each(cases)(
    'timeline IN on $layerId follows Ripple=$ripple without moving source anchors or other tracks',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const next = oneStep(document, trimOnTimeline(document, `${layerId}-a`, 'in', 5, 200, 'source'));
      expect(next.clips.find((clip) => clip.id === `${layerId}-a`)!).toMatchObject({
        sourceIn: 105,
        sourceOut: 130,
        start: ripple ? 10 : 15,
      });
      expect(starts(next, layerId)).toEqual(ripple ? [10, 35, 65] : [15, 60, 110]);
      expectOtherTracks(document, next, layerId);
    },
  );

  it.each(cases)(
    'drop and numeric-start guards on $layerId use Ripple=$ripple, not its index or identity',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const clip = document.clips.find((item) => item.id === `${layerId}-b`)!;
      expect(clipStartRestriction(document, clip) === null).toBe(!ripple);
      expect(
        clipStartRestriction(
          document,
          document.clips.find((item) => item.id === `${layerId}-a`)!,
        ),
      ).toBeNull();
      const payload = { kind: 'media' as const, clips: [createClip('new', 'new-source', 5, 15, layerId)] };
      const plan = planTimelineDrop(document, payload, layerId, 200, false, 5, 0);
      expect(plan).toMatchObject({
        layerId,
        mode: ripple ? 'ripple' : 'position',
        start: ripple ? 100 : 200,
        duration: 10,
        error: '',
      });
      const inserted = oneStep(document, {
        type: 'insert',
        clip: { ...payload.clips[0]!, start: plan.start },
        index: plan.index,
      });
      expect(inserted.clips.find((item) => item.id === 'new')!.start).toBe(plan.start);
      expectOtherTracks(document, inserted, layerId);
      if (ripple)
        rejected(
          document,
          {
            type: 'place',
            clipId: clip.id,
            layerId,
            start: 200,
            index: document.clips.findIndex((item) => item.id === clip.id),
          },
          'Ripple is on',
        );
    },
  );

  it.each(cases)(
    'absolute row Speed on $layerId retimes atomically with Ripple=$ripple and preserves full decimal precision',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const layer = document.layers.find((item) => item.id === layerId)!;
      layer.keyframes = [point(0, 1), { ...point(60, 2), interpolation: 'linear' }];
      // Hold rates make contextual suffix durations independently calculable.
      for (const placed of calculateLayout(document).clips) placed.clip.start = placed.start;
      const history = new EditHistory(document);
      const changed = history.commit({
        type: 'layer-key-value',
        layerId,
        frame: 0,
        setting: 'speed',
        value: 1.23456789,
      });
      expect(changed.layers.find((item) => item.id === layerId)!.keyframes[0]!.values.speed).toBe(1.23456789);
      const track = calculateLayout(changed).clips.filter((item) => item.clip.layerId === layerId);
      expect(track.map((clip) => [clip.start, clip.duration])).toEqual(
        ripple
          ? [
              [10, 24],
              [34, 24],
              [58, 16],
            ]
          : [
              [10, 24],
              [60, 15],
              [110, 15],
            ],
      );
      expect(track.map((clip) => [clip.retiming.sourceAt(0), clip.retiming.sourceAt(5)])).toEqual(
        ripple
          ? [
              [100, 106],
              [100, 106],
              [100, 108],
            ]
          : [
              [100, 106],
              [100, 110],
              [100, 110],
            ],
      );
      for (const clip of changed.clips) {
        const original = document.clips.find((item) => item.id === clip.id)!;
        expect({ ...clip, start: original.start }).toEqual(original);
      }
      for (const placed of calculateLayout(changed).clips.filter((item) => item.clip.layerId === layerId)) {
        expect(placed.retiming.duration).toBe(
          compileLayerRetiming(
            placed.clip,
            changed.layers.find((item) => item.id === layerId)!,
            placed.start,
          ).duration,
        );
        expect(placed.clip.start).toBe(placed.start);
      }
      if (!ripple) expect(starts(changed, layerId)).toEqual(starts(document, layerId));
      expect(changed.clips.filter((clip) => clip.layerId !== layerId)).toEqual(
        document.clips.filter((clip) => clip.layerId !== layerId),
      );
      expect(changed.music).toEqual(document.music);
      expect(history.undo()).toEqual(document);
      expect(history.canUndo).toBe(false);
      expect(history.redo()).toEqual(changed);
      const conflict = fixture(layerId, ripple);
      const conflictLayer = conflict.layers.find((item) => item.id === layerId)!;
      conflictLayer.openingFade = 20;
      rejected(
        conflict,
        { type: 'layer-key-toggle', layerId, frame: 0, setting: 'speed', value: 8 },
        'regions overlap or exceed',
      );
      if (!ripple)
        rejected(
          fixture(layerId, false),
          { type: 'speed', clipId: `${layerId}-a`, speed: { mode: 'constant', rate: 0.1 } },
          'cannot overlap',
        );
    },
  );

  it.each(cases)(
    'a whole Speed point move on $layerId uses absolute time with Ripple=$ripple and retains the redo branch on rejection',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const layer = document.layers.find((item) => item.id === layerId)!;
      layer.keyframes = [point(0, 1), { ...point(200, 2), interpolation: 'smooth' }];
      const history = new EditHistory(document);
      const next = history.commit({ type: 'layer-key-move', layerId, frame: 200, nextFrame: 60 });
      expect(next.layers.find((item) => item.id === layerId)!.keyframes).toEqual([
        layer.keyframes[0],
        { ...layer.keyframes[1]!, frame: 60 },
      ]);
      expect(starts(next, layerId)).toEqual(ripple ? [10, 40, 65] : [10, 60, 110]);
      expect(
        calculateLayout(next)
          .clips.filter((clip) => clip.clip.layerId === layerId)
          .map((clip) => clip.duration),
      ).toEqual(ripple ? [30, 25, 15] : [30, 15, 15]);
      expectOtherTracks(document, next, layerId, [layer.keyframes[0]!, { ...layer.keyframes[1]!, frame: 60 }]);
      expect(history.undo()).toEqual(document);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(true);
      expect(() => history.commit({ type: 'layer-key-move', layerId, frame: 200, nextFrame: 0 })).toThrow(
        'destination frame',
      );
      expect(history.current).toEqual(document);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(true);
      expect(history.redo()).toEqual(next);
      const constrained = structuredClone(document);
      constrained.layers.find((item) => item.id === layerId)!.openingFade = 20;
      constrained.layers.find((item) => item.id === layerId)!.keyframes[1]!.values.speed = 8;
      rejected(constrained, { type: 'layer-key-move', layerId, frame: 0, nextFrame: 210 }, 'regions overlap or exceed');
    },
  );
});

describe('track-owned transitions, fades, gaps and group composition', () => {
  it.each(cases)(
    'fades on $layerId use its actual start/end with Ripple=$ripple and never change coverage',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const end = ripple ? 100 : 140;
      const next = oneStep(document, { type: 'fades', layerId, opening: 3, closing: 3 });
      const weights = [10, 11, 12, end - 3, end - 2, end - 1].map(
        (frame) => sampleTimeline(next, frame).find((sample) => sample.layerId === layerId)!.brightness,
      );
      expect(weights).toEqual([0, 0.5, 1, 1, 0.5, 0]);
      for (const frame of [10, end - 1]) {
        const sample = sampleTimeline(next, frame).find((item) => item.layerId === layerId)!;
        expect(sample).toMatchObject({ opacity: 1, blendWeight: 1 });
        expect(compositePixel([sample], () => [1, 1, 1])).toEqual([0, 0, 0]);
      }
      expectOtherTracks(document, next, layerId);
    },
  );

  it.each(cases)(
    'empty $layerId retains dormant fades/row points with Ripple=$ripple; invalid repopulation is atomic',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      const layer = document.layers.find((item) => item.id === layerId)!;
      layer.keyframes = [point(600, 1)];
      layer.openingFade = 3;
      layer.closingFade = 4;
      let empty = document;
      for (const suffix of ['a', 'b', 'c']) empty = oneStep(empty, { type: 'delete', clipId: `${layerId}-${suffix}` });
      expect(empty.layers.find((item) => item.id === layerId)).toEqual({ ...layer, transitions: [] });
      expect(starts(empty, layerId)).toEqual([]);
      expectOtherTracks(document, empty, layerId);
      rejected(
        empty,
        {
          type: 'insert',
          clip: { ...createClip('too-short', 'source', 100, 106, layerId), start: 30 },
          index: empty.clips.length,
        },
        'regions overlap or exceed',
      );
      const restored = oneStep(empty, {
        type: 'insert',
        clip: { ...createClip('new', 'source', 100, 130, layerId), start: 30 },
        index: empty.clips.length,
      });
      expect(starts(restored, layerId)).toEqual([30]);
      expect(restored.layers.find((item) => item.id === layerId)).toEqual({ ...layer, transitions: [] });
      expect(sampleTimeline(restored, 30).find((sample) => sample.layerId === layerId)).toMatchObject({
        sourceFrame: 100,
        brightness: 0,
      });
    },
  );

  it.each(cases)(
    'dissolve edits on $layerId retain exact overlap and reject incompatible regions for Ripple=$ripple',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      if (!ripple) {
        rejected(
          document,
          {
            type: 'transition',
            transition: { leftId: `${layerId}-a`, rightId: `${layerId}-b`, type: 'cross-dissolve', duration: 5 },
          },
          'close the gap explicitly',
        );
        document.clips.find((clip) => clip.id === `${layerId}-b`)!.start = 40;
      }
      const next = oneStep(document, {
        type: 'transition',
        transition: { leftId: `${layerId}-a`, rightId: `${layerId}-b`, type: 'cross-dissolve', duration: 5 },
      });
      expect(starts(next, layerId)).toEqual(ripple ? [10, 35, 65] : [10, 35, 110]);
      expect(
        sampleTimeline(next, 37)
          .filter((sample) => sample.layerId === layerId)
          .map((sample) => [sample.sourceFrame, sample.blendWeight]),
      ).toEqual([
        [127, 0.6],
        [102, 0.4],
      ]);
      expectOtherTracks(document, next, layerId);
      rejected(
        next,
        { type: 'speed', clipId: `${layerId}-a`, speed: { mode: 'constant', rate: 8 } },
        'regions overlap or exceed',
      );
      if (!ripple)
        rejected(
          next,
          { type: 'speed', clipId: `${layerId}-a`, speed: { mode: 'constant', rate: 2 } },
          'exact stored overlap',
        );
      const restored = oneStep(next, { type: 'transition', transition: cut(`${layerId}-a`, `${layerId}-b`) });
      expect(starts(restored, layerId)).toEqual(ripple ? [10, 40, 70] : [10, 40, 110]);
    },
  );

  it('packs gaps without deleting a surviving positioned dissolve or moving its first anchor', () => {
    const document = fixture('middle', false);
    const layer = document.layers[1]!;
    document.clips.find((clip) => clip.id === 'middle-b')!.start = 35;
    layer.transitions[0] = { leftId: 'middle-a', rightId: 'middle-b', type: 'cross-dissolve', duration: 5 };
    const next = oneStep(document, { type: 'layer-update', layer: { ...layer, ripple: true } });
    expect(starts(next, 'middle')).toEqual([10, 35, 65]);
    expect(next.layers[1]!.transitions).toEqual(layer.transitions);
    expectOtherTracks(document, next, 'middle');
  });

  it('rejects cross-track boundaries, missing cuts, mismatched order, wrong dissolve overlap and triple overlap', () => {
    const document = fixture();
    rejected(
      document,
      { type: 'transition', transition: { leftId: 'ground-a', rightId: 'sky-a', type: 'cross-dissolve', duration: 5 } },
      'same track',
    );
    const missing = structuredClone(document);
    missing.layers[1]!.transitions.pop();
    expect(() => projectSchema.parse(missing)).toThrow('Exactly one transition');
    const wrong = structuredClone(document);
    wrong.layers[1]!.transitions.reverse();
    expect(() => projectSchema.parse(wrong)).toThrow('ordered adjacent clip pairs');
    const overlap = structuredClone(document);
    overlap.layers[1]!.transitions[0] = {
      leftId: 'middle-a',
      rightId: 'middle-b',
      type: 'cross-dissolve',
      duration: 5,
    };
    expect(() => projectSchema.parse(overlap)).toThrow('exact stored overlap');
    const triple = fixture('middle', true);
    triple.layers[1]!.transitions = [
      { leftId: 'middle-a', rightId: 'middle-b', type: 'cross-dissolve', duration: 20 },
      { leftId: 'middle-b', rightId: 'middle-c', type: 'cross-dissolve', duration: 20 },
    ];
    expect(() => projectSchema.parse(triple)).toThrow('regions overlap or exceed');
    const gapped = fixture('ground', false);
    rejected(
      gapped,
      {
        type: 'transition',
        transition: { leftId: 'ground-a', rightId: 'ground-b', type: 'fade-through-black', duration: 5 },
      },
      'close the gap explicitly',
    );
  });

  it.each(cases)(
    'black transitions on $layerId preserve odd endpoint math with Ripple=$ripple',
    ({ layerId, ripple }) => {
      const document = fixture(layerId, ripple);
      if (!ripple) document.clips.find((clip) => clip.id === `${layerId}-b`)!.start = 40;
      const next = oneStep(document, {
        type: 'transition',
        transition: { leftId: `${layerId}-a`, rightId: `${layerId}-b`, type: 'fade-through-black', duration: 5 },
      });
      expect(
        [37, 38, 39, 40, 41].map(
          (frame) => sampleTimeline(next, frame).find((sample) => sample.layerId === layerId)!.brightness,
        ),
      ).toEqual([1, 0.5, 0, 0, 1]);
      expect(starts(next, layerId)).toEqual(ripple ? [10, 40, 70] : [10, 40, 110]);
      expectOtherTracks(document, next, layerId);
    },
  );
});

describe('uniform export planning and explicitly revised resource bounds', () => {
  it.each([true, false])('dispatches leading starts and internal gaps regardless of Ripple=$ripple', (ripple) => {
    const document = createProject('dispatch', 'Dispatch');
    document.layers = [createLayer('any-id', 'Any', ripple)];
    document.clips = [{ ...createClip('a', 'source', 0, 10, 'any-id'), start: 5 }];
    expect(needsLayeredExport(document)).toBe(true);
    expect(() => planExport(document)).toThrow('layered exporter');
    expect(planLayeredExport(document).layers[0]!.plan.chunks).toEqual([
      { kind: 'body', clipIndex: 0, sourceIn: 0, sourceOut: 10, duration: 10, start: 5 },
    ]);
    document.clips[0]!.start = 0;
    expect(needsLayeredExport(document)).toBe(false);
    expect(planExport(document).duration).toBe(10);
    document.layers[0]!.ripple = false;
    document.clips.push({ ...createClip('b', 'source', 20, 25, 'any-id'), start: 20 });
    document.layers[0]!.transitions = [cut('a', 'b')];
    expect(needsLayeredExport(document)).toBe(true);
    expect(() => planExport(document)).toThrow('layered exporter');
    const plan = planLayeredExport(document);
    expect(plan.duration).toBe(25);
    expect(plan.layers[0]!.plan.duration).toBe(25);
    expect(plan.layers[0]!.plan.chunks).toEqual([
      { kind: 'body', clipIndex: 0, sourceIn: 0, sourceOut: 10, duration: 10, start: 0 },
      { kind: 'body', clipIndex: 1, sourceIn: 0, sourceOut: 5, duration: 5, start: 20 },
    ]);
  });

  it('plans concurrent dissolves on every track in composition order with exact flat indices, hidden tails and music OUT', () => {
    const document = fixture('middle', true);
    document.layers.forEach((layer) => {
      layer.ripple = true;
      layer.transitions[0] = { ...cut(`${layer.id}-a`, `${layer.id}-b`), type: 'cross-dissolve', duration: 5 };
    });
    for (const placed of calculateLayout(document).clips) placed.clip.start = placed.start;
    document.layers[2]!.enabled = false;
    document.clips.find((clip) => clip.id === 'sky-c')!.sourceOut = 160;
    const plan = planLayeredExport(document);
    const layout = calculateLayout(document);
    expect(plan.layers.map((layer) => layer.id)).toEqual(TRACK_IDS);
    expect(plan.duration).toBe(219);
    expect(plan.chunks).toEqual([]);
    expect(plan).not.toHaveProperty('primary');
    expect(plan).not.toHaveProperty('baseDuration');
    for (const [trackIndex, layer] of plan.layers.entries()) {
      const indices = [trackIndex, trackIndex + 3, trackIndex + 6];
      expect(layer.plan.chunks.slice(0, 3)).toEqual([
        { kind: 'body', clipIndex: indices[0], sourceIn: 0, sourceOut: 25, duration: 25, start: 10 },
        { kind: 'dissolve', leftIndex: indices[0], rightIndex: indices[1], leftIn: 25, duration: 5, start: 35 },
        { kind: 'body', clipIndex: indices[1], sourceIn: 5, sourceOut: 30, duration: 25, start: 40 },
      ]);
      expect(layer.clips.map((clip) => [clip.clipId, clip.start, clip.end])).toEqual(
        layout.clips
          .filter((clip) => clip.clip.layerId === layer.id)
          .map((clip) => [clip.clip.id, clip.start, clip.end]),
      );
    }
    expect(sampleTimeline(document, 37)).toHaveLength(4);
    expect(plan.layers[2]!.enabled).toBe(false);
    expect(plan.layers[2]!.plan.duration).toBe(125);
    expect(sampleTimeline(document, 124)).toEqual([]);
    expect(sampleTimeline(document, 218)).toEqual([]);
  });

  it('retains serial native ownership while explicitly budgeting four buffers, 22 bytes/pixel and three timelines', () => {
    expect(LAYERED_EXPORT_RESOURCES).toMatchObject({
      maxVideoLayers: 8,
      maxOriginalVideoDecoders: 1,
      maxIntermediateVideoDecoders: 2,
      maxVideoEncoders: 1,
      maxNativeVideoChildrenPerPass: 3,
      maxLosslessClipsOnDisk: 2,
      maxLosslessTimelineRepresentations: 3,
      rawFrameBuffers: 4,
      rawBytesPerPixel: 22,
      maxInMemoryLuts: 2,
      intermediateBitsPerChannel: 16,
    });
    expect(3840 * 2160 * LAYERED_EXPORT_RESOURCES.rawBytesPerPixel).toBe(182_476_800);
    expect(2 * LAYERED_EXPORT_RESOURCES.lutBytes).toBe(6_591_000);
    expect(decoderPoolSize(8)).toBe(16);
  });
});
