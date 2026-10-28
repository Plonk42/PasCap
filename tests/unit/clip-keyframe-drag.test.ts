import { describe, expect, it } from 'vitest';
import { GRADE_SETTINGS, type GradeKeyframe } from '../../src/shared/grade.js';
import { uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeTarget, planClipKeyframeMove } from '../../src/web/clip-keyframe-drag.js';
import { clipKeyframeMarkers, gradeKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';
import { planTransformKeyframeMove } from '../../src/web/timeline-keyframes.js';

function fixture(frames: readonly number[], rate = 1): ProjectDocument {
  const project = createProject('drag', 'Drag');
  const clip = createClip('clip', 'synthetic', 10, 130);
  clip.speed = { mode: 'constant', rate };
  project.layers[0]!.transform.keyframes = frames.map((frame, index) => ({
    ...uniformKeyframe(frame, { ...NEUTRAL_SPATIAL_POSE, scale: 1 + index }, index ? 'ease-in' : 'linear'),
    reset: index === 1,
  }));
  project.clips = [clip];
  return project;
}

describe('track Transform keyframe sliding', () => {
  it('moves one key to another timeline frame, keeping its easing, values and default flag, as one command', () => {
    const project = fixture([30, 60]);
    const plan = planTransformKeyframeMove(project, 'video-1', 60, 90);
    expect(plan.error).toBe('');
    expect(plan.command?.type).toBe('transform');
    const transform = plan.command?.type === 'transform' ? plan.command.transform : null;
    expect(transform?.keyframes.map((key) => [key.frame, key.easing.scale, key.values.scale, key.reset])).toEqual([
      [30, 'linear', 1, false],
      [90, 'ease-in', 2, true],
    ]);
    expect(plan.document.layers[0]!.transform).toEqual(transform);
    expect(plan.document.clips).toEqual(project.clips);
    expect(project.layers[0]!.transform.keyframes[1]!.frame).toBe(60);
  });

  it('re-sorts when a key passes its neighbour and may move after the duration', () => {
    const plan = planTransformKeyframeMove(fixture([30, 60]), 'video-1', 60, 20);
    expect(plan.document.layers[0]!.transform.keyframes.map((key) => key.frame)).toEqual([20, 30]);
    const late = planTransformKeyframeMove(fixture([30, 60]), 'video-1', 60, 5000);
    expect(late.error).toBe('');
    expect(calculateLayout(late.document).duration).toBe(120);
  });

  it('adds no command for an unchanged frame and rejects collisions and a missing track', () => {
    const project = fixture([30, 60]);
    expect(planTransformKeyframeMove(project, 'video-1', 60, 60).command).toBeNull();
    const collision = planTransformKeyframeMove(project, 'video-1', 60, 30);
    expect(collision.error).toMatch(/already exists/);
    expect(collision.command).toBeNull();
    expect(collision.document).toBe(project);
    expect(planTransformKeyframeMove(project, 'missing', 60, 61).error).toBe('Track no longer exists.');
  });
});

describe('clip speed keyframe sliding', () => {
  it('moves a clip speed key as one speed command and rejects speed collisions and out-of-original frames', () => {
    const project = fixture([]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 10, rate: 1, interpolation: 'linear' },
        { frame: 70, rate: 2, interpolation: 'smooth' },
      ],
    };
    const plan = planClipKeyframeMove(project, 'clip', 70, 90, 300);
    expect(plan.error).toBe('');
    expect(plan.command).toEqual({
      type: 'speed',
      clipId: 'clip',
      speed: {
        mode: 'curve',
        keyframes: [
          { frame: 10, rate: 1, interpolation: 'linear' },
          { frame: 90, rate: 2, interpolation: 'smooth' },
        ],
      },
    });
    expect(plan.command).toEqual({ type: 'speed', clipId: 'clip', speed: plan.document.clips[0]!.speed });
    expect(project.clips[0]!.speed).toMatchObject({ keyframes: [{ frame: 10 }, { frame: 70 }] });
    expect(planClipKeyframeMove(project, 'clip', 70, 70, 300).command).toBeNull();
    const collision = planClipKeyframeMove(project, 'clip', 70, 10, 300);
    expect(collision.error).toBe('A clip speed keyframe already exists at this source frame. Choose another frame.');
    expect(collision.document).toBe(project);
    expect(planClipKeyframeMove(project, 'clip', 70, 301, 300).error).toBe(
      'A Speed keyframe must stay within source frames 0–300.',
    );
    expect(planClipKeyframeMove(project, 'clip', 70, -1, 300).error).toMatch(/source frames 0–300/);
  });

  it('maps pointer travel in output frames to source frames at the placed speed', () => {
    const project = fixture([]);
    project.clips[0]!.speed = { mode: 'curve', keyframes: [{ frame: 50, rate: 2, interpolation: 'hold' }] };
    const placed = calculateLayout(project).clips[0]!;
    const [marker] = clipKeyframeMarkers(placed);
    expect(clipKeyframeTarget(placed, marker!, 0)).toBe(50);
    expect(clipKeyframeTarget(placed, marker!, 5)).toBe(placed.retiming.sourceAt(marker!.outputFrame + 5));
    expect(clipKeyframeTarget(placed, marker!, 5)).toBeGreaterThan(55);
    expect(clipKeyframeTarget(placed, marker!, -10_000)).toBe(placed.clip.sourceIn);
    expect(clipKeyframeTarget(placed, marker!, 10_000)).toBe(placed.retiming.sourceAt(placed.duration - 1));
  });
});

describe('clip grade keyframe sliding', () => {
  const unkeyed = <T>(): Record<(typeof GRADE_SETTINGS)[number], T | null> =>
    Object.fromEntries(GRADE_SETTINGS.map((setting) => [setting, null])) as Record<
      (typeof GRADE_SETTINGS)[number],
      T | null
    >;
  function graded(): ProjectDocument {
    const project = fixture([]);
    project.clips[0]!.speed = { mode: 'constant', rate: 2 };
    project.clips[0]!.grade.keyframes = [5, 40, 80].map((frame) => ({
      frame,
      values: { ...unkeyed<number>(), exposure: frame / 100 } as GradeKeyframe['values'],
      easing: { ...unkeyed<string>(), exposure: 'linear' } as GradeKeyframe['easing'],
      reset: false,
    }));
    return project;
  }

  it('marks only keys on the footage the clip shows, at the output frame showing them', () => {
    const placed = calculateLayout(graded()).clips[0]!;
    expect(gradeKeyframeMarkers(placed).map((marker) => [marker.sourceFrame, marker.outputFrame])).toEqual([
      [40, 15],
      [80, 35],
    ]);
  });

  it('moves a key as one layer-key-move command and rejects collisions and frames outside the recording', () => {
    const project = graded();
    const plan = planClipKeyframeMove(project, 'clip', 40, 50, 300, 'grade');
    expect(plan.error).toBe('');
    expect(plan.command).toEqual({ type: 'layer-key-move', clipId: 'clip', frame: 40, nextFrame: 50 });
    expect(plan.document.clips[0]!.grade.keyframes.map((key) => key.frame)).toEqual([5, 50, 80]);
    expect(planClipKeyframeMove(project, 'clip', 40, 80, 300, 'grade').error).toBe(
      'A clip grade keyframe already exists at this source frame. Choose another frame.',
    );
    expect(planClipKeyframeMove(project, 'clip', 40, 300, 300, 'grade').error).toBe(
      'A clip grade keyframe must stay within source frames 0–299.',
    );
  });
});
