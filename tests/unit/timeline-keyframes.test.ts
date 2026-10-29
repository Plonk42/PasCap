import { describe, expect, it } from 'vitest';
import { EditHistory } from '../../src/shared/commands.js';
import { uniformKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject } from '../../src/shared/model.js';
import {
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
  type SpatialChannel,
  type SpatialKeyframe,
} from '../../src/shared/spatial.js';
import { slideTravel } from '../../src/web/keyframe-slide.js';
import {
  planTransformKeyframeMove,
  trackKeyframeFrame,
  transformKeyframeKind,
} from '../../src/web/timeline-keyframes.js';

const keyframeFrameAtPointer = (
  frame: number,
  startX: number,
  clientX: number,
  startScroll: number,
  scrollLeft: number,
  scale: number,
): number => trackKeyframeFrame(frame, slideTravel(startX, clientX, startScroll, scrollLeft, scale));

const NO_SETTINGS = Object.fromEntries(SPATIAL_CHANNELS.map((channel) => [channel, null])) as Record<
  SpatialChannel,
  null
>;

function fixture() {
  const project = createProject('keyframe-drag', 'Transform keyframes');
  project.clips = [createClip('first', 'video', 10, 110)];
  const point: SpatialKeyframe = {
    ...uniformKeyframe(20, { ...NEUTRAL_SPATIAL_POSE, opacity: 0.7 }, 'ease-in'),
    reset: false,
  };
  const other: SpatialKeyframe = { ...uniformKeyframe(80, { ...NO_SETTINGS, scale: 2 }, 'hold'), reset: false };
  project.layers[0]!.transform.keyframes = [point, other];
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

describe('Transform keyframe drag planning', () => {
  it('moves all nine settings and their Easing across another keyframe atomically, changing no other data', () => {
    const { project, point, other } = fixture();
    const bytes = JSON.stringify(project);
    const plan = planTransformKeyframeMove(project, 'video-1', 20, 90);
    expect(plan).toMatchObject({ frame: 90, error: '', command: { type: 'transform', layerId: 'video-1' } });
    expect(plan.document.layers[0]!.transform).toEqual({
      base: project.layers[0]!.transform.base,
      keyframes: [other, { ...point, frame: 90 }],
    });
    expect({ ...plan.document, layers: project.layers }).toEqual(project);
    expect({ ...plan.document.layers[0]!, transform: project.layers[0]!.transform }).toEqual(project.layers[0]);
    expect(JSON.stringify(project)).toBe(bytes);
    const history = new EditHistory(project);
    history.commit(plan.command!);
    expect(history.undo()).toEqual(project);
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toEqual(plan.document);
  });
  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])(
    'rejects destination frame %s without altering the snapshot',
    (frame) => {
      const { project } = fixture();
      const plan = planTransformKeyframeMove(project, 'video-1', 20, frame);
      expect(plan.error).not.toBe('');
      expect(plan.command).toBeNull();
      expect(plan.document).toBe(project);
    },
  );
  it('rejects a deleted keyframe or track instead of creating a replacement', () => {
    const { project } = fixture();
    expect(planTransformKeyframeMove(project, 'missing-row', 20, 30).error).toContain('Track no longer exists');
    expect(planTransformKeyframeMove(project, 'video-1', 21, 30).error).toContain(
      'Transform keyframe no longer exists',
    );
  });
  it('removes a focused Transform marker’s keyframe on a track without clips, in one Undo step', () => {
    const { project } = fixture();
    project.clips = [];
    const transform = transformKeyframeKind({ onSelectLayer: () => {}, onOpenSection: () => {}, onSeek: () => {} });
    const history = new EditHistory(project);
    history.commit(transform.remove!(history.current, { scope: 'video-1', origin: 80 }));
    expect(history.current.layers[0]!.transform.keyframes.map((key) => key.frame)).toEqual([20]);
    history.undo();
    expect(history.current).toEqual(project);
    expect(history.canUndo).toBe(false);
  });
});
