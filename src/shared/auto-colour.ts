import {
  AUTO_ADJUST,
  AUTO_ADJUST_SETTINGS,
  autoAdjustWindow,
  scaleCorrection,
  type AutoAdjustSetting,
  type AutoCorrection,
} from './auto-adjust.js';
import type { EditCommand } from './commands.js';
import { activeLayerSetting, hasLayerKeys, type KeyframeSetting } from './keyframes.js';
import { MAX_TRACK_KEYFRAMES, type VideoLayer } from './model.js';
import type { PlacedClip } from './timeline.js';
import type { WhiteBalance } from './white-balance.js';

/** The edits of Auto adjust and Auto white balance, shared by the editor and the `estimate` operation. */

/** Why no keyframe can be captured at `frame`: the track is full and none is there to join. */
export function keyframeLimitReason(layer: VideoLayer, frame: number): string | null {
  return layer.keyframes.length >= MAX_TRACK_KEYFRAMES && !layer.keyframes.some((key) => key.frame === frame)
    ? `This track already has ${MAX_TRACK_KEYFRAMES} keyframes. Move the playhead to one of them, or remove one.`
    : null;
}

/** Captures each value at `frame` exactly like its diamond (joining or overwriting), in one transaction. */
export function captureCommands(
  layer: VideoLayer,
  frame: number,
  values: Readonly<Partial<Record<KeyframeSetting, number>>>,
): EditCommand[] {
  return (Object.entries(values) as [KeyframeSetting, number][]).map(([setting, value]): EditCommand => {
    const capture = { layerId: layer.id, frame, setting, value };
    return activeLayerSetting(layer, setting, frame)
      ? { type: 'layer-key-value', ...capture }
      : { type: 'layer-key-toggle', ...capture };
  });
}

/** Captures both settings at the playhead exactly like their diamonds, in one transaction. */
export function whiteBalanceCommands(layer: VideoLayer, frame: number, balance: WhiteBalance): EditCommand[] {
  return captureCommands(layer, frame, { temperature: balance.temperature, tint: balance.tint });
}

/** The settings Auto sets that this track animates: Auto leaves them unchanged. */
export function animatedSettings(layer: VideoLayer): AutoAdjustSetting[] {
  return AUTO_ADJUST_SETTINGS.filter((setting) => hasLayerKeys(layer, setting));
}

/**
 * The one Colour edit Auto applies: the correction at `intensity` (0–1) replaces the track's values of the eleven
 * settings, except animated ones. Null when every one of them is animated.
 */
export function autoAdjustCommand(
  layer: VideoLayer,
  correction: Readonly<AutoCorrection>,
  intensity: number,
): EditCommand | null {
  const animated = new Set(animatedSettings(layer));
  const settings = AUTO_ADJUST_SETTINGS.filter((setting) => !animated.has(setting));
  if (!settings.length) return null;
  const scaled = scaleCorrection(correction, intensity);
  const colour = { ...layer.colour };
  for (const setting of settings) colour[setting] = scaled[setting];
  return { type: 'colour', layerId: layer.id, colour };
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
