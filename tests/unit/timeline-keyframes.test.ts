import { describe, expect, it } from 'vitest';
import { NEUTRAL_COLOUR, scalarColourValues } from '../../src/shared/colour.js';
import { EditHistory } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES, type LayerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { slideTravel } from '../../src/web/keyframe-slide.js';
import { planKeyframeDrag, trackKeyframeFrame } from '../../src/web/timeline-keyframes.js';

const keyframeFrameAtPointer = (
  frame: number,
  startX: number,
  clientX: number,
  startScroll: number,
  scrollLeft: number,
  scale: number,
): number => trackKeyframeFrame(frame, slideTravel(startX, clientX, startScroll, scrollLeft, scale));

function fixture() {
  const project = createProject('keyframe-drag', 'Shared points');
  project.clips = [createClip('first', 'video', 10, 110)];
  const point: LayerKeyframe = {
    frame: 20,
    interpolation: 'ease-in',
    values: { ...EMPTY_KEY_VALUES, ...scalarColourValues(NEUTRAL_COLOUR), opacity: 0.7 },
  };
  const other: LayerKeyframe = { frame: 80, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, exposure: 0.5 } };
  project.layers[0]!.keyframes = [point, other];
  return { project, point, other };
}

describe('capture-relative marker geometry', () => {
  it.each([0.4, 1.6, 6])('keeps the grabbed frame at scale %s and includes scroll delta once', (scale) => {
    expect(keyframeFrameAtPointer(20, 200, 200 + 30 * scale, 100, 100, scale)).toBe(50);
    expect(keyframeFrameAtPointer(20, 200, 200 + 30 * scale, 100, 100 + 10 * scale, scale)).toBe(60);
    expect(keyframeFrameAtPointer(20, 200, 200 - 10 * scale, 100, 100 - 5 * scale, scale)).toBe(5);
  });
  it('quantises once and bounds timeline coordinates, never source frames', () => {
    expect(keyframeFrameAtPointer(20, 100, 100.6, 0, 0, 1)).toBe(21);
    expect(keyframeFrameAtPointer(20, 100, -200, 0, 0, 1)).toBe(0);
    expect(keyframeFrameAtPointer(2_147_483_640, 0, 100, 0, 0, 1)).toBe(2_147_483_647);
  });
  it.each([0, -1, NaN, Infinity])('rejects scale %s instead of producing a hidden invalid point', (scale) => {
    expect(() => keyframeFrameAtPointer(20, 100, 110, 0, 0, scale)).toThrow('geometry');
  });
});

describe('shared-point drag planning', () => {
  it('moves all eleven participants/easing across another point atomically and changes no other project data', () => {
    const { project, point, other } = fixture();
    const bytes = JSON.stringify(project);
    const plan = planKeyframeDrag(project, 'video-1', 20, 90, [], 0);
    expect(plan).toMatchObject({
      frame: 90,
      guide: null,
      error: '',
      command: { type: 'layer-key-move', layerId: 'video-1', frame: 20, nextFrame: 90 },
    });
    expect(plan.document.layers[0]!.keyframes).toEqual([other, { ...point, frame: 90 }]);
    expect({ ...plan.document, layers: project.layers }).toEqual(project);
    expect(JSON.stringify(project)).toBe(bytes);
    const history = new EditHistory(project);
    history.commit(plan.command!);
    expect(history.undo()).toEqual(project);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(plan.document);
  });
  it('treats unchanged/click-only movement as navigation, without a command or history step', () => {
    const { project } = fixture();
    const plan = planKeyframeDrag(project, 'video-1', 20, 20, [], 0);
    expect(plan.command).toBeNull();
    expect(plan.error).toBe('');
    expect(plan.document).toEqual(project);
  });
  it('never merges or overwrites an occupied point, even with different participating channels', () => {
    const { project } = fixture();
    const plan = planKeyframeDrag(project, 'video-1', 20, 80, [], 0);
    expect(plan.error).toContain('already exists');
    expect(plan.command).toBeNull();
    expect(plan.document).toBe(project);
  });
  it('snaps to stationary boundaries/playhead and no targets means Alt/no-snap bypass', () => {
    const { project } = fixture();
    expect(planKeyframeDrag(project, 'video-1', 20, 57, [0, 60, 100], 5)).toMatchObject({
      frame: 60,
      guide: 60,
      error: '',
    });
    expect(planKeyframeDrag(project, 'video-1', 20, 57, [], 5)).toMatchObject({ frame: 57, guide: null, error: '' });
  });
  it('retains an off-duration point without extending the project or source', () => {
    const { project, point } = fixture();
    const plan = planKeyframeDrag(project, 'video-1', 20, 200, [], 0);
    expect(plan.document.layers[0]!.keyframes.at(-1)).toEqual({ ...point, frame: 200 });
    expect(calculateLayout(plan.document).duration).toBe(calculateLayout(project).duration);
    expect(plan.document.clips).toEqual(project.clips);
  });
  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])(
    'rejects destination frame %s without altering the snapshot',
    (frame) => {
      const { project } = fixture();
      const plan = planKeyframeDrag(project, 'video-1', 20, frame, [], 0);
      expect(plan.error).not.toBe('');
      expect(plan.command).toBeNull();
      expect(plan.document).toBe(project);
    },
  );
  it('rejects a deleted point or row instead of creating a replacement', () => {
    const { project } = fixture();
    expect(planKeyframeDrag(project, 'missing-row', 20, 30, [], 0).error).toContain('Track no longer exists');
    expect(planKeyframeDrag(project, 'video-1', 21, 30, [], 0).error).toContain('Track keyframe no longer exists');
  });
});
