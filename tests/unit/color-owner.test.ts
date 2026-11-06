import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { createAdjustment, gradeColorAt, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import {
  KEYFRAME_SETTINGS,
  uniformKeyframe,
  type Interpolation,
  type LayerKeyValues,
} from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema } from '../../src/shared/model.js';
import { adjustmentColorOwner, clipColorOwner, withoutColorSetting } from '../../src/web/color-owner.js';

const NONE = Object.fromEntries(KEYFRAME_SETTINGS.map(({ key }) => [key, null])) as LayerKeyValues;
const point = (frame: number, values: Partial<LayerKeyValues>, curve: Interpolation = 'linear', reset = false) =>
  layerKeyAsGradeKey({ ...uniformKeyframe(frame, { ...NONE, ...values }, curve), reset });

function project() {
  const document = createProject('bypass', 'Bypass');
  document.media.videoIds = ['recording'];
  const clip = createClip('clip', 'recording', 10, 90);
  clip.grade.color.exposure = 0.4;
  clip.grade.color.saturation = 1.4;
  // A default keyframe at 80 holds neutral values from its frame on.
  clip.grade.keyframes = [
    point(20, { exposure: 1 }),
    point(60, { exposure: -0.5, saturation: 0.8 }),
    point(80, { exposure: 0, saturation: 1 }, 'hold', true),
  ];
  document.clips = [clip];
  const adjustment = createAdjustment('adjustment', 0, 80);
  adjustment.color.hue = 12;
  document.adjustments = [adjustment];
  return projectSchema.parse(document);
}

describe('hold-to-compare Color previews', () => {
  it('show a clip grade with one setting neutral at every source frame, keeping the others', () => {
    const document = project();
    const clip = document.clips[0]!;
    const commands = withoutColorSetting(clipColorOwner(clip, ''), 'exposure')!;
    const without = commands.reduce(applyCommand, document);
    expect(document).toEqual(project());
    for (const frame of [10, 20, 40, 60, 70, 85]) {
      expect(gradeColorAt(without.clips[0]!.grade, frame)).toEqual({
        ...gradeColorAt(clip.grade, frame),
        exposure: 0,
      });
    }
    expect(without.clips[0]!.grade.keyframes.map((key) => key.frame)).toEqual([60, 80]);
    expect(without.adjustments).toEqual(document.adjustments);
  });

  it('show an adjustment without one setting, and nothing for a neutral setting', () => {
    const document = project();
    const owner = adjustmentColorOwner(document.adjustments[0]!, '');
    expect(withoutColorSetting(owner, 'exposure')).toBeNull();
    const without = withoutColorSetting(owner, 'hue')!.reduce(applyCommand, document);
    expect(without.adjustments[0]!.color.hue).toBe(0);
    expect(without.clips).toEqual(document.clips);
  });
});
