import {
  analyseAutoAdjust,
  autoAdjustFrames,
  scaleCorrection,
  type AutoAdjustSetting,
  type AutoCorrection,
} from '../shared/auto-adjust.js';
import {
  animatedSettings,
  autoAdjustCommand,
  captureCommands,
  keyframeLimitReason,
  trackSamples,
  windowSourceFrames,
} from '../shared/auto-colour.js';
import { COLOUR_CONTROLS } from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { TimelineLayout } from '../shared/timeline.js';
import { frameIlluminant, type AnalysisFrame, type IlluminantEstimate } from '../shared/white-balance.js';
import { proxyUrl } from './api.js';
import { readyAsset, readyClipAtPlayhead } from './auto-white-balance.js';

/** What Auto analyses: 1 s around the playhead, the whole clip at the playhead, or every clip of the track. */
export type AutoAdjustSource = 'playhead' | 'clip' | 'track';
/** How Auto applies its correction: the track's values, or a keyframe at the playhead. */
export type AutoAdjustApply = 'values' | 'keyframe';

/** Source frames read from one recording's proxy. */
export interface AutoAdjustRead {
  asset: MediaAsset;
  sourceFrames: number[];
}

export interface AutoAdjustTarget {
  source: AutoAdjustSource;
  /** What the popover names as analysed: a recording, or the track's clips. */
  label: string;
  /** One analysis: the recordings as prepared and the source frames it reads. */
  key: string;
  /** The playhead, where a keyframe goes. */
  frame: number;
  reads: AutoAdjustRead[];
}

export type AutoAdjustAvailability = { target: AutoAdjustTarget; reason: null } | { target: null; reason: string };

const preparedAt = (asset: MediaAsset): string => asset.prepared?.verification.verifiedAt ?? '';

/** What Auto would analyse from `source`, around the clip of this track at the playhead, or why it cannot. */
export function autoAdjustTarget(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
  preferredClipId: string | null,
  source: AutoAdjustSource = 'clip',
): AutoAdjustAvailability {
  const { clip, asset, reason } = readyClipAtPlayhead(layer, layout, assets, frame, preferredClipId, 'analyse it');
  if (reason !== null) return { target: null, reason };
  if (source === 'track') return trackTarget(layer, layout, assets, frame);
  const { sourceIn, sourceOut } = clip.clip;
  const prefix = [clip.clip.id, asset.id, preparedAt(asset), sourceIn, sourceOut];
  const target = (key: unknown[], sourceFrames: number[]): AutoAdjustAvailability => ({
    target: { source, label: asset.name, key: key.join(':'), frame, reads: [{ asset, sourceFrames }] },
    reason: null,
  });
  if (source === 'clip') return target(['clip', ...prefix], autoAdjustFrames(sourceIn, sourceOut));
  const sourceFrames = windowSourceFrames(clip, frame);
  return target(['playhead', ...prefix, frame, sourceFrames.join(',')], sourceFrames);
}

function trackTarget(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
): AutoAdjustAvailability {
  const clips = layout.clips.filter((item) => item.clip.layerId === layer.id);
  const reads = new Map<string, AutoAdjustRead>();
  for (const { clip, sourceFrame } of trackSamples(clips)) {
    const asset = readyAsset(assets, clip.clip.mediaId);
    if (!asset) return { target: null, reason: `Prepare the recordings of every clip on ${layer.name} first.` };
    const read = reads.get(asset.id) ?? { asset, sourceFrames: [] };
    if (!read.sourceFrames.includes(sourceFrame)) read.sourceFrames.push(sourceFrame);
    reads.set(asset.id, read);
  }
  const list = [...reads.values()];
  const key = [
    'track',
    layer.id,
    ...list.map(({ asset, sourceFrames }) => `${asset.id}/${preparedAt(asset)}/${sourceFrames.join(',')}`),
  ].join(':');
  const label = `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'} on ${layer.name}`;
  return { target: { source: 'track', label, key, frame, reads: list }, reason: null };
}

/** Why a keyframe cannot take the correction from `source` at the playhead, or null. */
export function keyframeReason(layer: VideoLayer, source: AutoAdjustSource, frame: number): string | null {
  if (source !== 'playhead') return 'A keyframe takes the light at the playhead: analyse the playhead.';
  return keyframeLimitReason(layer, frame);
}

/** Once the track animates any setting Auto sets, a keyframe is the edit that can change them all. */
export function initialChoice(layer: VideoLayer): { source: AutoAdjustSource; apply: AutoAdjustApply } {
  return animatedSettings(layer).length
    ? { source: 'playhead', apply: 'keyframe' }
    : { source: 'clip', apply: 'values' };
}

export function settingLabel(setting: AutoAdjustSetting): string {
  return COLOUR_CONTROLS.find((control) => control.key === setting)!.label;
}

/** The edit Auto applies: the track's values, or a keyframe of all eleven at the playhead `frame`. */
export function autoAdjustCommands(
  layer: VideoLayer,
  apply: AutoAdjustApply,
  frame: number,
  correction: Readonly<AutoCorrection>,
  intensity: number,
): EditCommand[] {
  if (apply === 'keyframe') return captureCommands(layer, frame, scaleCorrection(correction, intensity));
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

/** Decodes the analysed frames from each recording's proxy, one temporary reader at a time, then fits the correction. */
export async function analyseTarget(
  target: AutoAdjustTarget,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<AutoCorrection> {
  const { sampleProxyFrames } = await import('../preview/frame-sampler.js');
  const total = target.reads.reduce((sum, read) => sum + read.sourceFrames.length, 0);
  const frames: AnalysisFrame[] = [];
  await forEachSerial(target.reads, async ({ asset, sourceFrames }) => {
    const before = frames.length;
    const sampled = await sampleProxyFrames(proxyUrl(asset.id), sourceFrames, signal, (done) =>
      onProgress(before + done, total),
    ).catch((cause: unknown) => {
      if (signal.aborted || !(cause instanceof Error)) throw cause;
      throw new Error(`Could not read the frames of ${asset.name}: ${cause.message}`);
    });
    for (const source of sourceFrames) {
      const frame = sampled.get(source);
      if (frame) frames.push(frame);
    }
  });
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
