import { describe, expect, it } from 'vitest';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
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

function transformKeys(project: ProjectDocument, frames: readonly number[]): void {
  project.clips[0]!.spatial.keyframes = frames.map((frame) => ({
    frame,
    interpolation: 'linear',
    values: { ...NEUTRAL_SPATIAL_POSE },
  }));
}

function markersFor(project: ProjectDocument) {
  const placed = calculateLayout(project).clips[0]!;
  return { placed, markers: clipKeyframeMarkers(placed, project.layers[0]!) };
}

describe('clip-owned timeline keyframe markers', () => {
  it('creates no synthetic keys for neutral constant speed, static poses or shared track keys', () => {
    const project = fixture();
    expect(markersFor(project).markers).toEqual([]);
    project.clips[0]!.spatial.base.scale = 2;
    project.layers[0]!.keyframes = [
      { frame: 30, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 2, exposure: 1 } },
    ];
    expect(markersFor(project).markers).toEqual([]);
  });

  it('maps original frames relative to source IN and actual placement at neutral speed without mutating data', () => {
    const project = fixture();
    transformKeys(project, [10, 30, 129, 130]);
    const before = structuredClone(project);
    const { markers } = markersFor(project);
    expect(markers).toEqual([
      { type: 'transform', sourceFrame: 10, outputFrame: 0, timelineFrame: 17, seekFrame: 17, speedOverridden: false },
      { type: 'transform', sourceFrame: 30, outputFrame: 20, timelineFrame: 37, seekFrame: 37, speedOverridden: false },
      {
        type: 'transform',
        sourceFrame: 129,
        outputFrame: 119,
        timelineFrame: 136,
        seekFrame: 136,
        speedOverridden: false,
      },
      {
        type: 'transform',
        sourceFrame: 130,
        outputFrame: 120,
        timelineFrame: 137,
        seekFrame: 136,
        speedOverridden: false,
      },
    ]);
    expect(project).toEqual(before);
  });

  it.each([0.1, 0.3, 0.5, 1.125, 2, 8])('uses the rounded constant %sx clock, not raw source length', (rate) => {
    const project = fixture();
    project.clips[0]!.speed = { mode: 'constant', rate };
    transformKeys(project, [10, 11, 40, 129, 130]);
    const { placed, markers } = markersFor(project);
    const duration = Math.max(1, Math.round(120 / rate));
    expect(placed.duration).toBe(duration);
    for (const marker of markers) {
      const expected =
        marker.sourceFrame === 130
          ? duration
          : Math.min(duration - 1, Math.floor(((marker.sourceFrame - 10) * duration) / 120 + 1e-8));
      expect(marker.outputFrame).toBe(expected);
      expect(marker.timelineFrame).toBe(17 + expected);
      expect(marker.seekFrame).toBe(previewClipSource(project, 'clip', marker.sourceFrame));
    }
  });

  it.each([
    {
      mode: 'ramp',
      startRate: 0.5,
      endRate: 2,
      curve: 'linear',
      anchorIn: 0,
      anchorOut: 120,
    },
    {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.5, interpolation: 'linear' },
        { frame: 30, rate: 0.875, interpolation: 'linear' },
        { frame: 120, rate: 2, interpolation: 'hold' },
      ],
    },
  ] satisfies SpeedSettings[])('maps a source-time $mode through the placed floor inverse', (speed) => {
    const project = fixture(0, 120, 12);
    project.clips[0]!.speed = speed;
    transformKeys(project, [30]);
    const { placed, markers } = markersFor(project);
    // Independently integrate dt = ds / (0.5 + s / 80), normalised to the rounded duration.
    const total = 80 * Math.log(4);
    const continuous = (80 * Math.log(1.75) * Math.round(total)) / total;
    expect(placed.duration).toBe(111);
    expect(continuous).toBeGreaterThan(44);
    expect(continuous).toBeLessThan(45);
    expect(markers[0]).toMatchObject({
      type: 'transform',
      sourceFrame: 30,
      outputFrame: 44,
      timelineFrame: 56,
      seekFrame: 57,
    });
    expect(placed.retiming.outputAt(30)).toBe(44);
    expect(placed.retiming.sourceAt(44)).toBe(29);
    expect(placed.retiming.sourceAt(45)).toBe(30);
    expect(markers.filter((marker) => marker.type === 'speed').map((marker) => marker.sourceFrame)).toEqual(
      speed.mode === 'curve' ? [0, 30, 120] : [],
    );
  });

  it('retains overlapping Transform and Speed keys independently, without copying track diamonds', () => {
    const project = fixture(0, 120);
    transformKeys(project, [30, 120]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 30, rate: 1, interpolation: 'linear' },
        { frame: 120, rate: 1, interpolation: 'hold' },
      ],
    };
    project.layers[0]!.keyframes = [
      { frame: 30, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, opacity: 0.5 } },
    ];
    const { markers } = markersFor(project);
    expect(markers).toHaveLength(4);
    for (const source of [30, 120]) {
      const coincident = markers.filter((marker) => marker.sourceFrame === source);
      expect(coincident.map((marker) => marker.type)).toEqual(['transform', 'speed']);
      expect(coincident[0]!.timelineFrame).toBe(coincident[1]!.timelineFrame);
      expect(coincident[0]!.seekFrame).toBe(coincident[1]!.seekFrame);
    }
    expect(markers.every((marker) => !marker.speedOverridden)).toBe(true);
  });

  it('uses absolute project-time track Speed instead of the stored clip curve and identifies overridden Speed', () => {
    const project = fixture();
    transformKeys(project, [40]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 40, rate: 8, interpolation: 'hold' },
        { frame: 130, rate: 8, interpolation: 'hold' },
      ],
    };
    project.layers[0]!.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 0.5 } },
      { frame: 30, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, exposure: 1 } },
      { frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 2 } },
    ];
    project.clips[0]!.start = 20;
    const before = structuredClone(project);
    const { placed, markers } = markersFor(project);
    // From project frame 20, source consumption is 0.8*t + 0.0075*t².
    const continuous = (-0.8 + Math.sqrt(0.8 ** 2 + 4 * 0.0075 * 30)) / (2 * 0.0075);
    expect(Math.floor(continuous)).toBe(29);
    expect(placed.duration).toBe(84);
    expect(markers[0]).toMatchObject({
      type: 'transform',
      outputFrame: 29,
      timelineFrame: 49,
      seekFrame: 50,
      speedOverridden: false,
    });
    expect(markers[1]).toMatchObject({
      type: 'speed',
      sourceFrame: 40,
      outputFrame: 29,
      timelineFrame: 49,
      seekFrame: 50,
      speedOverridden: true,
    });
    expect(markers).toHaveLength(3);
    expect(project).toEqual(before);
    project.clips[0]!.start = 30;
    const moved = markersFor(project);
    expect(moved.markers[0]!.outputFrame).not.toBe(markers[0]!.outputFrame);
    expect(moved.markers[0]!.outputFrame).toBe(moved.placed.retiming.outputAt(40));
  });

  it('uses each contextual Ripple placement, not a saved suffix start or another clip’s map', () => {
    const project = fixture(0, 60, 20);
    transformKeys(project, [30]);
    const second = structuredClone(project.clips[0]!);
    second.id = 'second';
    second.start = 999;
    project.clips.push(second);
    project.layers[0]!.transitions = [{ leftId: 'clip', rightId: 'second', type: 'cut', duration: 0 }];
    project.layers[0]!.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, speed: 0.5 } },
      { frame: 100, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 2 } },
    ];
    const layout = calculateLayout(project);
    const firstPlaced = layout.clips[0]!;
    const secondPlaced = layout.clips[1]!;
    const firstMarker = clipKeyframeMarkers(firstPlaced, project.layers[0]!)[0]!;
    const secondMarker = clipKeyframeMarkers(secondPlaced, project.layers[0]!)[0]!;
    expect(secondPlaced.start).toBe(firstPlaced.end);
    expect(secondPlaced.start).not.toBe(second.start);
    expect(secondMarker.timelineFrame).toBe(secondPlaced.start + secondPlaced.retiming.outputAt(30));
    expect(secondMarker.outputFrame).toBeLessThan(firstMarker.outputFrame);
    expect(secondMarker.seekFrame).toBe(previewClipSource(project, 'second', 30));
  });

  it('omits retained off-trim keys of both types instead of clamping copies to either clip edge', () => {
    const project = fixture(30, 90);
    transformKeys(project, [0, 29, 30, 60, 90, 91, 120]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [0, 29, 30, 60, 90, 91, 120].map((frame) => ({ frame, rate: 1, interpolation: 'linear' })),
    };
    const before = structuredClone(project);
    const { markers } = markersFor(project);
    for (const type of ['transform', 'speed'])
      expect(markers.filter((marker) => marker.type === type).map((marker) => marker.sourceFrame)).toEqual([
        30, 60, 90,
      ]);
    expect(project).toEqual(before);
  });

  it('places original exclusive OUT at the right edge but seeks the last held output, not the inverse', () => {
    const project = fixture(0, 120, 7);
    transformKeys(project, [120]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 0, rate: 0.25, interpolation: 'hold' },
        { frame: 120, rate: 0.25, interpolation: 'hold' },
      ],
    };
    const { placed, markers } = markersFor(project);
    expect(placed.duration).toBe(480);
    for (const marker of markers.filter((point) => point.sourceFrame === 120)) {
      expect(marker.outputFrame).toBe(480);
      expect(marker.timelineFrame).toBe(placed.end);
      expect(marker.seekFrame).toBe(486);
      expect(marker.seekFrame).toBe(placed.end - 1);
      expect(placed.retiming.sourceAt(marker.seekFrame - placed.start)).toBe(119);
    }
  });

  it.each([
    { source: 1, rate: 0.3, output: 3, seek: 4, displayed: 1 },
    { source: 30, rate: 0.25, output: 120, seek: 120, displayed: 30 },
    { source: 1, rate: 4, output: 0, seek: 0, displayed: 0 },
    { source: 2, rate: 4, output: 0, seek: 0, displayed: 0 },
    { source: 3, rate: 4, output: 0, seek: 1, displayed: 4 },
  ])('previews the closest mapped image for source $source at $rate×, preferring the earlier tie', (test) => {
    const project = fixture(0, 120, 7);
    transformKeys(project, [test.source]);
    project.clips[0]!.speed = { mode: 'constant', rate: test.rate };
    const { placed, markers } = markersFor(project);
    expect(markers[0]!.outputFrame).toBe(test.output);
    expect(markers[0]!.seekFrame).toBe(7 + test.seek);
    expect(placed.retiming.sourceAt(test.seek)).toBe(test.displayed);
  });

  it('keeps distinct skipped keys even when their mapped diamond positions coincide', () => {
    const project = fixture(0, 120);
    project.clips[0]!.speed = { mode: 'constant', rate: 4 };
    transformKeys(project, [1, 2, 3]);
    const { markers } = markersFor(project);
    expect(markers.map((marker) => marker.sourceFrame)).toEqual([1, 2, 3]);
    expect(markers.map((marker) => marker.outputFrame)).toEqual([0, 0, 0]);
    expect(markers.map((marker) => marker.seekFrame)).toEqual([17, 17, 18]);
  });

  it('bounds one-frame preview targets even with a fast track override and an OUT boundary', () => {
    const project = fixture(7, 10, 5);
    transformKeys(project, [7, 8, 9, 10]);
    project.layers[0]!.keyframes = [{ frame: 0, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 8 } }];
    const { placed, markers } = markersFor(project);
    expect(placed.duration).toBe(1);
    expect(markers.map((marker) => marker.outputFrame)).toEqual([0, 0, 0, 1]);
    expect(markers.every((marker) => marker.seekFrame === 5)).toBe(true);
  });

  it('retains both complete 256-key lists without truncating, deduplicating or inventing track keys', () => {
    const project = fixture(0, 255, 0);
    const frames = Array.from({ length: 256 }, (_, index) => index);
    transformKeys(project, frames);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: frames.map((frame) => ({ frame, rate: 1, interpolation: 'hold' })),
    };
    expect(projectSchema.safeParse(project).success).toBe(true);
    const { markers } = markersFor(project);
    expect(markers).toHaveLength(512);
    for (const type of ['transform', 'speed'])
      expect(markers.filter((marker) => marker.type === type).map((marker) => marker.sourceFrame)).toEqual(frames);
    expect(new Set(markers.map((marker) => `${marker.type}-${marker.sourceFrame}`)).size).toBe(512);
    expect(markers.every((marker) => marker.seekFrame >= 0 && marker.seekFrame < 255)).toBe(true);
  });

  it('does not allocate per-output-frame data for the maximum supported duration', () => {
    const project = fixture(0, 2_147_483_647, 0);
    transformKeys(project, [0, 2_147_483_647]);
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
