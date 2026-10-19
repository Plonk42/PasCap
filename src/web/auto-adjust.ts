import {
  analyseAutoAdjust,
  AUTO_ADJUST_SETTINGS,
  autoAdjustFrames,
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
import { proxyUrl, readyClipAtPlayhead } from './auto-white-balance.js';

export interface AutoAdjustTarget {
  clip: PlacedClip;
  asset: MediaAsset;
  /** One analysis: the clip, its recording as prepared and its source range. */
  key: string;
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
): AutoAdjustAvailability {
  const { clip, asset, reason } = readyClipAtPlayhead(layer, layout, assets, frame, preferredClipId, 'analyse it');
  if (reason !== null) return { target: null, reason };
  const { sourceIn, sourceOut } = clip.clip;
  const key = [clip.clip.id, asset.id, asset.prepared?.verification.verifiedAt, sourceIn, sourceOut].join(':');
  return { target: { clip, asset, key, sourceFrames: autoAdjustFrames(sourceIn, sourceOut) }, reason: null };
}

/** The settings Auto sets that this track animates: Auto leaves them unchanged. */
export function animatedSettings(layer: VideoLayer): AutoAdjustSetting[] {
  return AUTO_ADJUST_SETTINGS.filter((setting) => hasLayerKeys(layer, setting));
}

export function settingLabel(setting: AutoAdjustSetting): string {
  return COLOUR_CONTROLS.find((control) => control.key === setting)!.label;
}

/**
 * The one Colour edit Auto applies: the correction at `amount` replaces the track's values of the ten
 * settings, except animated ones. Null when every one of them is animated.
 */
export function autoAdjustCommand(
  layer: VideoLayer,
  correction: Readonly<AutoCorrection>,
  amount: number,
): EditCommand | null {
  const animated = new Set(animatedSettings(layer));
  const settings = AUTO_ADJUST_SETTINGS.filter((setting) => !animated.has(setting));
  if (!settings.length) return null;
  const scaled = scaleCorrection(correction, amount);
  const colour = { ...layer.colour };
  for (const setting of settings) colour[setting] = scaled[setting];
  return { type: 'colour', layerId: layer.id, colour };
}

export interface AutoAdjustAnalysis {
  key: string;
  correction: AutoCorrection;
  /** The intensity last applied, 0–100%. */
  percent: number;
}

// Session memory only: the last analysis of each clip of the open project, never saved or in history.
let analysesProject: string | null = null;
const analyses = new Map<string, AutoAdjustAnalysis>();

/** The clip's last analysis, unless it was trimmed or its recording prepared again since. */
export function cachedAnalysis(projectId: string, target: AutoAdjustTarget): AutoAdjustAnalysis | null {
  if (analysesProject !== projectId) return null;
  const analysis = analyses.get(target.clip.clip.id);
  return analysis?.key === target.key ? analysis : null;
}

export function rememberAnalysis(projectId: string, target: AutoAdjustTarget, analysis: AutoAdjustAnalysis): void {
  if (analysesProject !== projectId) {
    analyses.clear();
    analysesProject = projectId;
  }
  analyses.set(target.clip.clip.id, analysis);
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
