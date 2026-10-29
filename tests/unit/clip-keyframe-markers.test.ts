import { describe, expect, it } from 'vitest';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, layerKeyframe, uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import type { SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';
import { previewClipSource } from '../../src/web/clip-speed-geometry.js';

function fixture(sourceIn = 10, sourceOut = 130, start = 17): ProjectDocument {
  const project = createProject('clip-markers', 'Clip markers');
  const clip = createClip('clip', 'synthetic', sourceIn, sourceOut);
  clip.start = start;
  project.clips = [clip];
  return project;
}

/** A flat custom curve: the same retiming as constant `rate`, with stored keys at `frames`. */
function speedKeys(project: ProjectDocument, frames: readonly number[], rate = 1): void {
  project.clips[0]!.speed = {
    mode: 'curve',
    keyframes: frames.map((frame) => ({ frame, rate, interpolation: 'hold' })),
  };
}

function markersFor(project: ProjectDocument) {
  const placed = calculateLayout(project).clips[0]!;
  return { placed, markers: clipKeyframeMarkers(placed) };
}

describe('clip-owned timeline speed keyframe markers', () => {
  it('creates no synthetic speed keys for constant speed, track Transform, clip grade or adjustment keys', () => {
    const project = fixture();
    expect(markersFor(project).markers).toEqual([]);
    project.layers[0]!.transform.base.scale = 2;
    project.layers[0]!.transform.keyframes = [
      { ...uniformKeyframe(30, { ...NEUTRAL_SPATIAL_POSE }, 'linear'), reset: false },
    ];
    const exposure = layerKeyAsGradeKey(layerKeyframe(30, { ...EMPTY_KEY_VALUES, exposure: 1 }, 'linear'));
    project.clips[0]!.grade.keyframes = [exposure];
    project.adjustments = [{ ...createAdjustment('look', 0, 200), keyframes: [exposure] }];
    expect(markersFor(project).markers).toEqual([]);
  });

  it('maps original frames relative to source IN and actual placement at neutral speed without mutating data', () => {
    const project = fixture();
    speedKeys(project, [10, 30, 129, 130]);
    const before = structuredClone(project);
    const { markers } = markersFor(project);
    expect(markers).toEqual([
      { type: 'speed', sourceFrame: 10, outputFrame: 0, timelineFrame: 17, seekFrame: 17 },
      { type: 'speed', sourceFrame: 30, outputFrame: 20, timelineFrame: 37, seekFrame: 37 },
      { type: 'speed', sourceFrame: 129, outputFrame: 119, timelineFrame: 136, seekFrame: 136 },
      { type: 'speed', sourceFrame: 130, outputFrame: 120, timelineFrame: 137, seekFrame: 136 },
    ]);
    expect(project).toEqual(before);
  });

  it.each([0.1, 0.3, 0.5, 1.125, 2, 8])('uses the rounded flat %sx clock, not raw source length', (rate) => {
    const project = fixture();
    speedKeys(project, [10, 11, 40, 129, 130], rate);
    const { placed, markers } = markersFor(project);
    const duration = Math.max(1, Math.round(120 / rate));
    expect(placed.duration).toBe(duration);
    for (const marker of markers) {
      const seek = previewClipSource(project, 'clip', marker.sourceFrame);
      const expected = marker.sourceFrame === 130 ? duration : seek - 17;
      expect(marker.outputFrame).toBe(expected);
      expect(marker.timelineFrame).toBe(17 + expected);
      expect(marker.seekFrame).toBe(seek);
    }
  });

  it.each([
    {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'linear' },
        { frame: 30, rate: 0.875, interpolation: 'linear' },
        { frame: 120, rate: 2, interpolation: 'hold' },
      ],
    },
  ] satisfies SpeedSettings[])('places a source-time $mode key on the output frame showing its image', (speed) => {
    const project = fixture(0, 120, 12);
    project.clips[0]!.speed = speed;
    const { placed, markers } = markersFor(project);
    // Independently integrate dt = ds / (0.5 + s / 80), normalised to the rounded duration.
    const total = 80 * Math.log(4);
    const continuous = (80 * Math.log(1.75) * Math.round(total)) / total;
    expect(placed.duration).toBe(111);
    expect(continuous).toBeGreaterThan(44);
    expect(continuous).toBeLessThan(45);
    expect(markers.map((marker) => marker.sourceFrame)).toEqual([0, 30, 120]);
    expect(markers[1]).toMatchObject({
      type: 'speed',
      sourceFrame: 30,
      outputFrame: 45,
      timelineFrame: 57,
      seekFrame: 57,
    });
    // The floor inverse lands one frame earlier, still showing source 29.
    expect(placed.retiming.outputAt(30)).toBe(44);
    expect(placed.retiming.sourceAt(44)).toBe(29);
    expect(placed.retiming.sourceAt(45)).toBe(30);
  });

  it('uses each contextual Ripple placement, not a saved suffix start or another clip’s map', () => {
    const project = fixture(0, 60, 20);
    speedKeys(project, [30]);
    const second = structuredClone(project.clips[0]!);
    second.id = 'second';
    second.start = 999;
    project.clips.push(second);
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'second', type: 'cut', duration: 0 }];
    const layout = calculateLayout(project);
    const firstPlaced = layout.clips[0]!;
    const secondPlaced = layout.clips[1]!;
    const firstMarker = clipKeyframeMarkers(firstPlaced)[0]!;
    const secondMarker = clipKeyframeMarkers(secondPlaced)[0]!;
    expect(secondPlaced.start).toBe(firstPlaced.end);
    expect(secondPlaced.start).not.toBe(second.start);
    expect(secondMarker.timelineFrame).toBe(secondPlaced.start + secondPlaced.retiming.outputAt(30));
    expect(secondMarker.outputFrame).toBe(firstMarker.outputFrame);
    expect(secondMarker.seekFrame).toBe(previewClipSource(project, 'second', 30));
  });

  it('omits retained off-trim keys instead of clamping copies to either clip edge', () => {
    const project = fixture(30, 90);
    speedKeys(project, [0, 29, 30, 60, 90, 91, 120]);
    const before = structuredClone(project);
    const { markers } = markersFor(project);
    expect(markers.map((marker) => marker.sourceFrame)).toEqual([30, 60, 90]);
    expect(project).toEqual(before);
  });

  it('places original exclusive OUT at the right edge but seeks the last held output, not the inverse', () => {
    const project = fixture(0, 120, 7);
    speedKeys(project, [0, 120], 0.25);
    const { placed, markers } = markersFor(project);
    expect(placed.duration).toBe(480);
    const marker = markers.find((point) => point.sourceFrame === 120)!;
    expect(marker.outputFrame).toBe(480);
    expect(marker.timelineFrame).toBe(placed.end);
    expect(marker.seekFrame).toBe(486);
    expect(marker.seekFrame).toBe(placed.end - 1);
    expect(placed.retiming.sourceAt(marker.seekFrame - placed.start)).toBe(119);
  });

  it.each([
    { source: 1, rate: 0.3, output: 4, seek: 4, displayed: 1 },
    { source: 30, rate: 0.25, output: 120, seek: 120, displayed: 30 },
    { source: 1, rate: 4, output: 0, seek: 0, displayed: 0 },
    { source: 2, rate: 4, output: 0, seek: 0, displayed: 0 },
    { source: 3, rate: 4, output: 1, seek: 1, displayed: 4 },
  ])('previews the closest mapped image for source $source at $rate×, preferring the earlier tie', (test) => {
    const project = fixture(0, 120, 7);
    speedKeys(project, [test.source], test.rate);
    const { placed, markers } = markersFor(project);
    expect(markers[0]!.outputFrame).toBe(test.output);
    expect(markers[0]!.seekFrame).toBe(7 + test.seek);
    expect(placed.retiming.sourceAt(test.seek)).toBe(test.displayed);
  });

  it('keeps distinct skipped keys even when their mapped marker positions coincide', () => {
    const project = fixture(0, 120);
    speedKeys(project, [1, 2, 3], 4);
    const { markers } = markersFor(project);
    expect(markers.map((marker) => marker.sourceFrame)).toEqual([1, 2, 3]);
    expect(markers.map((marker) => marker.outputFrame)).toEqual([0, 0, 1]);
    expect(markers.map((marker) => marker.seekFrame)).toEqual([17, 17, 18]);
  });

  it('bounds one-frame preview targets even with a fast clip rate and an OUT boundary', () => {
    const project = fixture(7, 10, 5);
    speedKeys(project, [7, 8, 9, 10], 8);
    const { placed, markers } = markersFor(project);
    expect(placed.duration).toBe(1);
    expect(markers.map((marker) => marker.outputFrame)).toEqual([0, 0, 0, 1]);
    expect(markers.every((marker) => marker.seekFrame === 5)).toBe(true);
  });

  it('retains a complete 256-key list without truncating, deduplicating or inventing track keys', () => {
    const project = fixture(0, 255, 0);
    const frames = Array.from({ length: 256 }, (_, index) => index);
    speedKeys(project, frames);
    expect(projectSchema.safeParse(project).success).toBe(true);
    const { markers } = markersFor(project);
    expect(markers.map((marker) => marker.sourceFrame)).toEqual(frames);
    expect(markers.every((marker) => marker.seekFrame >= 0 && marker.seekFrame < 255)).toBe(true);
  });

  it('does not allocate per-output-frame data for the maximum supported duration', () => {
    const project = fixture(0, 2_147_483_647, 0);
    speedKeys(project, [0, 2_147_483_647]);
    const { placed, markers } = markersFor(project);
    expect(placed.duration).toBe(2_147_483_647);
    expect(markers).toHaveLength(2);
    expect(markers[1]).toMatchObject({
      outputFrame: 2_147_483_647,
      timelineFrame: 2_147_483_647,
      seekFrame: 2_147_483_646,
    });
  });
});
