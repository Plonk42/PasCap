import {
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustWindow,
  scaleCorrection,
  type AutoAdjustSetting,
  type AutoCorrection,
} from './auto-adjust.js';
import type { EditCommand } from './commands.js';
import type { ColourSettings } from './colour.js';
import { MAX_GRADE_KEYFRAMES } from './grade.js';
import { activeLayerSetting, hasLayerKeys, type KeyframeSetting, type LayerKeyframe } from './keyframes.js';
import type { PlacedClip } from './timeline.js';
import type { WhiteBalance } from './white-balance.js';

/** The edits of Auto adjust and Auto white balance, shared by the editor and the `estimate` operation. */

/** What an edit changes: a clip's grade (keyframes at source frames) or an adjustment (frames from its start). */
export type AutoOwner = { kind: 'clip'; clipId: string } | { kind: 'adjustment'; adjustmentId: string };

/** A grade's Colour and keyframes, in the track keyframe shape the keyframe tools read. */
export interface GradeValues {
  colour: ColourSettings;
  keyframes: readonly LayerKeyframe[];
}

const keyTarget = (owner: AutoOwner) =>
  owner.kind === 'clip' ? { clipId: owner.clipId } : { adjustmentId: owner.adjustmentId };

/** Why no keyframe can be captured at `frame`: the grade is full and none is there to join. */
export function keyframeLimitReason(grade: GradeValues, frame: number, owner: AutoOwner): string | null {
  if (grade.keyframes.length < MAX_GRADE_KEYFRAMES || grade.keyframes.some((key) => key.frame === frame)) return null;
  const what = owner.kind === 'clip' ? "This clip's grade" : 'This adjustment';
  return `${what} already has ${MAX_GRADE_KEYFRAMES} keyframes. Move the playhead to one of them, or remove one.`;
}

/** Captures each value at `frame` exactly like its diamond (joining or overwriting), in one transaction. */
export function captureCommands(
  grade: GradeValues,
  frame: number,
  values: Readonly<Partial<Record<KeyframeSetting, number>>>,
  owner: AutoOwner,
): EditCommand[] {
  return (Object.entries(values) as [Exclude<KeyframeSetting, 'opacity'>, number][]).map(
    ([setting, value]): EditCommand => {
      const capture = { ...keyTarget(owner), frame, setting, value };
      return activeLayerSetting(grade, setting, frame)
        ? { type: 'layer-key-value', ...capture }
        : { type: 'layer-key-toggle', ...capture };
    },
  );
}

/** Captures both settings at the playhead exactly like their diamonds, in one transaction. */
export function whiteBalanceCommands(
  grade: GradeValues,
  frame: number,
  balance: WhiteBalance,
  owner: AutoOwner,
): EditCommand[] {
  return captureCommands(grade, frame, { temperature: balance.temperature, tint: balance.tint }, owner);
}

/** The settings Auto sets that this grade animates: Auto leaves them unchanged. */
export function animatedSettings(grade: GradeValues): AutoAdjustSetting[] {
  return AUTO_ADJUST_SETTINGS.filter((setting) => hasLayerKeys(grade, setting));
}

/**
 * The one Colour edit Auto applies: the correction at `intensity` (0–1) replaces the owner's values of the eleven
 * settings, except animated ones. Null when every one of them is animated.
 */
export function autoAdjustCommand(
  grade: GradeValues,
  correction: Readonly<AutoCorrection>,
  intensity: number,
  owner: AutoOwner,
): EditCommand | null {
  const animated = new Set(animatedSettings(grade));
  const settings = AUTO_ADJUST_SETTINGS.filter((setting) => !animated.has(setting));
  if (!settings.length) return null;
  const scaled = scaleCorrection(correction, intensity);
  const colour = { ...grade.colour };
  for (const setting of settings) colour[setting] = scaled[setting];
  return owner.kind === 'clip'
    ? { type: 'colour', clipIds: [owner.clipId], colour }
    : { type: 'colour', adjustmentId: owner.adjustmentId, colour };
}

/** Source frames shown at the project frames within 1 s of `frame` in `clip`, each once. */
export function windowSourceFrames(clip: PlacedClip, frame: number): number[] {
  return [
    ...new Set(autoAdjustWindow(clip, frame).map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start))),
  ];
}

/**
 * Every clip of the track laid end to end in timeline order, with up to AUTO_ADJUST.frames output frames at the
 * centres of equal slices: each clip is analysed in proportion to its duration on screen.
 */
export function trackSamples(clips: readonly PlacedClip[]): { clip: PlacedClip; sourceFrame: number }[] {
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  const total = ordered.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  const count = Math.min(AUTO_ADJUST.frames, total);
  const samples: { clip: PlacedClip; sourceFrame: number }[] = [];
  let index = 0;
  let before = 0;
  for (let sample = 0; sample < count; sample++) {
    const position = Math.floor(((sample + 0.5) * total) / count);
    while (position >= before + ordered[index]!.end - ordered[index]!.start) {
      before += ordered[index]!.end - ordered[index]!.start;
      index++;
    }
    const clip = ordered[index]!;
    samples.push({ clip, sourceFrame: clip.retiming.sourceAt(position - before) });
  }
  return samples;
}
