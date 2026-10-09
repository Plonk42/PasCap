import { describe, expect, it } from 'vitest';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { clipKeyframeTarget, planClipKeyframeMove } from '../../src/web/clip-keyframe-drag.js';
import { clipKeyframeMarkers } from '../../src/web/clip-keyframe-markers.js';

function fixture(frames: readonly number[], rate = 1): ProjectDocument {
  const project = createProject('drag', 'Drag');
  const clip = createClip('clip', 'synthetic', 10, 130);
  clip.speed = { mode: 'constant', rate };
  clip.spatial.keyframes = frames.map((frame, index) => ({
    frame,
    interpolation: index ? 'ease-in' : 'linear',
    values: { ...NEUTRAL_SPATIAL_POSE, scale: 1 + index },
  }));
  project.clips = [clip];
  return project;
}

describe('Transform keyframe sliding', () => {
  it('moves one key to another source frame, keeping its easing and values, as one spatial command', () => {
    const project = fixture([30, 60]);
    const plan = planClipKeyframeMove(project, 'clip', 60, 90, 300);
    expect(plan.error).toBe('');
    expect(plan.command?.type).toBe('spatial');
    const spatial = plan.command?.type === 'spatial' ? plan.command.spatial : null;
    expect(spatial?.keyframes.map((key) => [key.frame, key.interpolation, key.values.scale])).toEqual([
      [30, 'linear', 1],
      [90, 'ease-in', 2],
    ]);
    expect(plan.document.clips[0]!.spatial).toEqual(spatial);
    expect(project.clips[0]!.spatial.keyframes[1]!.frame).toBe(60);
  });

  it('re-sorts when a key passes its neighbour', () => {
    const plan = planClipKeyframeMove(fixture([30, 60]), 'clip', 60, 20, 300);
    expect(plan.document.clips[0]!.spatial.keyframes.map((key) => key.frame)).toEqual([20, 30]);
    expect(plan.command?.type).toBe('spatial');
  });

  it('adds no command for an unchanged frame and rejects collisions and out-of-original frames', () => {
    const project = fixture([30, 60]);
    expect(planClipKeyframeMove(project, 'clip', 60, 60, 300).command).toBeNull();
    const collision = planClipKeyframeMove(project, 'clip', 60, 30, 300);
    expect(collision.error).toMatch(/already exists/);
    expect(collision.command).toBeNull();
    expect(collision.document).toBe(project);
    expect(planClipKeyframeMove(project, 'clip', 60, 301, 300).error).toMatch(/source frames 0–300/);
    expect(planClipKeyframeMove(project, 'clip', 60, -1, 300).error).toMatch(/source frames 0–300/);
  });

  it('moves a clip speed key as one speed command and rejects speed collisions and out-of-original frames', () => {
    const project = fixture([]);
    project.clips[0]!.speed = {
      mode: 'curve',
      keyframes: [
        { frame: 10, rate: 1, interpolation: 'linear' },
        { frame: 70, rate: 2, interpolation: 'smooth' },
      ],
    };
    const plan = planClipKeyframeMove(project, 'clip', 70, 90, 300, 'speed');
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
    expect(plan.document.clips[0]!.speed).toEqual(plan.command?.type === 'speed' ? plan.command.speed : null);
    expect(project.clips[0]!.speed).toMatchObject({ keyframes: [{ frame: 10 }, { frame: 70 }] });
    expect(planClipKeyframeMove(project, 'clip', 70, 70, 300, 'speed').command).toBeNull();
    const collision = planClipKeyframeMove(project, 'clip', 70, 10, 300, 'speed');
    expect(collision.error).toBe('A clip speed keyframe already exists at this source frame. Choose another frame.');
    expect(collision.document).toBe(project);
    expect(planClipKeyframeMove(project, 'clip', 70, 301, 300, 'speed').error).toBe(
      'A Speed keyframe must stay within source frames 0–300.',
    );
  });

  it('maps pointer travel in output frames to source frames at the placed speed', () => {
    const project = fixture([50], 2);
    const placed = calculateLayout(project).clips[0]!;
    const [marker] = clipKeyframeMarkers(placed);
    expect(clipKeyframeTarget(placed, marker!, 0)).toBe(50);
    expect(clipKeyframeTarget(placed, marker!, 5)).toBe(placed.retiming.sourceAt(marker!.outputFrame + 5));
    expect(clipKeyframeTarget(placed, marker!, 5)).toBeGreaterThan(55);
    expect(clipKeyframeTarget(placed, marker!, -10_000)).toBe(placed.clip.sourceIn);
    expect(clipKeyframeTarget(placed, marker!, 10_000)).toBe(placed.retiming.sourceAt(placed.duration - 1));
  });
});
