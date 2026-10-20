import {
  analyseAutoAdjust,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
  autoAdjustWindow,
  scaleCorrection,
  type AutoAdjustSetting,
  type AutoCorrection,
} from '../shared/auto-adjust.js';
import { COLOUR_CONTROLS } from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import { hasLayerKeys } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { PlacedClip, TimelineLayout } from '../shared/timeline.js';
import { frameIlluminant, type AnalysisFrame, type IlluminantEstimate } from '../shared/white-balance.js';
import { captureCommands, keyframeLimitReason, proxyUrl, readyClipAtPlayhead } from './auto-white-balance.js';

/** Track values from the whole clip, or a keyframe at the playhead from the frames around it. */
export type AutoAdjustMode = 'track' | 'keyframe';

export interface AutoAdjustTarget {
  mode: AutoAdjustMode;
  clip: PlacedClip;
  asset: MediaAsset;
  /** One analysis: the clip, its recording as prepared and the source frames it reads. */
  key: string;
  /** The playhead, where a keyframe goes. */
  frame: number;
  sourceFrames: number[];
}

export type AutoAdjustAvailability = { target: AutoAdjustTarget; reason: null } | { target: null; reason: string };

/** The clip Auto would analyse, the one of this track at the playhead, or why it cannot. */
export function autoAdjustTarget(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
  preferredClipId: string | null,
  mode: AutoAdjustMode = 'track',
): AutoAdjustAvailability {
  const { clip, asset, reason } = readyClipAtPlayhead(layer, layout, assets, frame, preferredClipId, 'analyse it');
  if (reason !== null) return { target: null, reason };
  const { sourceIn, sourceOut } = clip.clip;
  const prefix = [mode, clip.clip.id, asset.id, asset.prepared?.verification.verifiedAt, sourceIn, sourceOut];
  if (mode === 'track') {
    const sourceFrames = autoAdjustFrames(sourceIn, sourceOut);
    return { target: { mode, clip, asset, key: prefix.join(':'), frame, sourceFrames }, reason: null };
  }
  const full = keyframeLimitReason(layer, frame);
  if (full !== null) return { target: null, reason: full };
  const sourceFrames = [
    ...new Set(autoAdjustWindow(clip, frame).map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start))),
  ];
  const key = [...prefix, frame, sourceFrames.join(',')].join(':');
  return { target: { mode, clip, asset, key, frame, sourceFrames }, reason: null };
}

/** Once the track animates any setting Auto sets, a keyframe is the edit that can change them all. */
export function initialMode(layer: VideoLayer): AutoAdjustMode {
  return animatedSettings(layer).length ? 'keyframe' : 'track';
}

/** The settings Auto sets that this track animates: Auto leaves them unchanged. */
export function animatedSettings(layer: VideoLayer): AutoAdjustSetting[] {
  return AUTO_ADJUST_SETTINGS.filter((setting) => hasLayerKeys(layer, setting));
}

export function settingLabel(setting: AutoAdjustSetting): string {
  return COLOUR_CONTROLS.find((control) => control.key === setting)!.label;
}

/**
 * The one Colour edit Auto applies: the correction at `intensity` (0–1) replaces the track's values of the ten
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

/** The edit Auto applies in `target`'s mode: the track's values, or a keyframe of all ten at the playhead. */
export function autoAdjustCommands(
  layer: VideoLayer,
  target: Pick<AutoAdjustTarget, 'mode' | 'frame'>,
  correction: Readonly<AutoCorrection>,
  intensity: number,
): EditCommand[] {
  if (target.mode === 'keyframe') return captureCommands(layer, target.frame, scaleCorrection(correction, intensity));
  const edit = autoAdjustCommand(layer, correction, intensity);
  return edit ? [edit] : [];
}

export interface AutoAdjustAnalysis {
  correction: AutoCorrection;
  /** The intensity last applied, 0–100%. */
  percent: number;
}

// Session memory only: the last analyses of the open project, never saved or in history.
let analysesProject: string | null = null;
const analyses = new Map<string, AutoAdjustAnalysis>();

/** The last analysis of the same frames, unless the clip was trimmed or its recording prepared again since. */
export function cachedAnalysis(projectId: string, target: AutoAdjustTarget): AutoAdjustAnalysis | null {
  return analysesProject === projectId ? (analyses.get(target.key) ?? null) : null;
}

export function rememberAnalysis(projectId: string, target: AutoAdjustTarget, analysis: AutoAdjustAnalysis): void {
  if (analysesProject !== projectId) {
    analyses.clear();
    analysesProject = projectId;
  }
  analyses.set(target.key, analysis);
}

/** Lets input events through between frames, so Cancel stays responsive during the analysis. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Decodes the clip's analysed frames from its proxy on a temporary reader, then fits the correction. */
export async function analyseClip(
  target: AutoAdjustTarget,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<AutoCorrection> {
  const { sampleProxyFrames } = await import('../preview/frame-sampler.js');
  const sampled = await sampleProxyFrames(proxyUrl(target.asset.id), target.sourceFrames, signal, onProgress).catch(
    (cause: unknown) => {
      if (signal.aborted || !(cause instanceof Error)) throw cause;
      throw new Error(`Could not read the clip’s frames: ${cause.message}`);
    },
  );
  const frames = target.sourceFrames
    .map((source) => sampled.get(source))
    .filter((frame): frame is AnalysisFrame => frame !== undefined);
  const illuminants: (IlluminantEstimate | null)[] = [];
  await forEachSerial(frames, async (frame) => {
    illuminants.push(frameIlluminant(frame));
    await nextTask();
    signal.throwIfAborted();
  });
  const correction = analyseAutoAdjust(frames, illuminants);
  if (!correction) throw new Error('These frames are too dark or too uniform to analyse.');
  return correction;
}
