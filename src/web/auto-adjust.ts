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
  windowSourceFrames,
  type AutoOwner,
} from '../shared/auto-colour.js';
import { COLOUR_CONTROLS } from '../shared/colour.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { PlacedClip, TimelineLayout } from '../shared/timeline.js';
import { frameIlluminant, type AnalysisFrame, type IlluminantEstimate } from '../shared/white-balance.js';
import { proxyUrl } from './api.js';
import { readyAsset } from './auto-white-balance.js';
import { gradeOwnerOf, sourceFrameAt } from './colour-owner.js';
import { shortName } from './display.js';

/** What Auto analyses: 1 s around the playhead or the whole graded clip, or each clip of its track on its own. */
export type AutoAdjustSource = 'playhead' | 'clip' | 'track';
/** How Auto applies its correction: each analysed clip's grade values, or a keyframe of the grade at the playhead. */
export type AutoAdjustApply = 'values' | 'keyframe';

/** One clip analysed on its own, whose grade takes its correction. */
export interface AutoAdjustPart {
  clip: PlacedClip;
  /** How errors name it, among the track's clips. */
  name: string;
  asset: MediaAsset;
  sourceFrames: number[];
}

export interface AutoAdjustTarget {
  source: AutoAdjustSource;
  /** What the popover names as analysed: a recording, or the track's clips. */
  label: string;
  /** One analysis: the clips, recordings as prepared and source frames it reads. */
  key: string;
  parts: AutoAdjustPart[];
}

export type AutoAdjustAvailability = { target: AutoAdjustTarget; reason: null } | { target: null; reason: string };

/** Where Auto runs: the graded clip, at the playhead. */
export interface AutoAdjustContext {
  project: ProjectDocument;
  clipId: string;
  layout: TimelineLayout;
  assets: readonly MediaAsset[];
  playhead: number;
}

const preparedAt = (asset: MediaAsset): string => asset.prepared?.verification.verifiedAt ?? '';
const clipOwner = (clipId: string): AutoOwner => ({ kind: 'clip', clipId });
const unavailable = (reason: string): AutoAdjustAvailability => ({ target: null, reason });

/** What Auto would analyse from `source` for the graded clip, or why it cannot. */
export function autoAdjustTarget(
  context: AutoAdjustContext,
  source: AutoAdjustSource = 'clip',
): AutoAdjustAvailability {
  const placed = context.layout.clips.find((item) => item.clip.id === context.clipId);
  if (!placed) return unavailable('This clip is no longer on the timeline.');
  if (source === 'track') return trackTarget(context, placed);
  const asset = readyAsset(context.assets, placed.clip.mediaId);
  if (!asset) return unavailable('Prepare the recording of this clip first.');
  const { sourceIn, sourceOut } = placed.clip;
  const prefix = [placed.clip.id, asset.id, preparedAt(asset), sourceIn, sourceOut];
  const target = (key: (string | number)[], sourceFrames: number[]): AutoAdjustAvailability => ({
    target: { source, label: asset.name, key: key.join(':'), parts: [{ clip: placed, name: '', asset, sourceFrames }] },
    reason: null,
  });
  if (source === 'clip') return target(['clip', ...prefix], autoAdjustFrames(sourceIn, sourceOut));
  if (sourceFrameAt(placed, context.playhead) === null)
    return unavailable('Move the playhead over this clip to analyse 1 s around it.');
  const sourceFrames = windowSourceFrames(placed, context.playhead);
  return target(['playhead', ...prefix, context.playhead, sourceFrames.join(',')], sourceFrames);
}

/** The name of the graded clip's track. */
export function trackNameOf(context: AutoAdjustContext): string {
  const clip = context.project.clips.find((item) => item.id === context.clipId);
  return context.project.layers.find((layer) => layer.id === clip?.layerId)?.name ?? 'this track';
}

function trackTarget(context: AutoAdjustContext, graded: PlacedClip): AutoAdjustAvailability {
  const track = context.project.layers.find((layer) => layer.id === graded.clip.layerId);
  const clips = context.layout.clips
    .filter((item) => item.clip.layerId === graded.clip.layerId)
    .sort((left, right) => left.start - right.start);
  const parts: AutoAdjustPart[] = [];
  for (const [index, clip] of clips.entries()) {
    const asset = readyAsset(context.assets, clip.clip.mediaId);
    if (!asset) return unavailable(`Prepare the recordings of every clip on ${track?.name ?? 'this track'} first.`);
    const { sourceIn, sourceOut } = clip.clip;
    const name = `Clip ${index + 1} (${shortName(asset.name)})`;
    parts.push({ clip, name, asset, sourceFrames: autoAdjustFrames(sourceIn, sourceOut) });
  }
  const key = [
    'track',
    graded.clip.layerId,
    ...parts.map(
      ({ clip, asset }) =>
        `${clip.clip.id}/${asset.id}/${preparedAt(asset)}/${clip.clip.sourceIn}-${clip.clip.sourceOut}`,
    ),
  ].join(':');
  const label = `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'} on ${track?.name ?? 'this track'}, each on its own`;
  return { target: { source: 'track', label, key, parts }, reason: null };
}

/** Why a keyframe cannot take the correction from `source` at the playhead, or null. */
export function keyframeReason(context: AutoAdjustContext, source: AutoAdjustSource): string | null {
  if (source === 'track') return 'Keyframes go to this clip only, at the playhead.';
  if (source !== 'playhead') return 'A keyframe takes the light at the playhead: analyse the playhead.';
  const owner = gradeOwnerOf(context.project, context.clipId);
  const placed = context.layout.clips.find((item) => item.clip.id === context.clipId);
  const frame = placed ? sourceFrameAt(placed, context.playhead) : null;
  if (!owner || frame === null) return 'Move the playhead over this clip to key it.';
  return keyframeLimitReason(owner, frame, clipOwner(context.clipId));
}

/** Once the grade animates any setting Auto sets, a keyframe at the playhead is the edit that can change them all. */
export function initialChoice(context: AutoAdjustContext): { source: AutoAdjustSource; apply: AutoAdjustApply } {
  const owner = gradeOwnerOf(context.project, context.clipId);
  const animated = owner !== null && animatedSettings(owner).length > 0;
  return animated && keyframeReason(context, 'playhead') === null
    ? { source: 'playhead', apply: 'keyframe' }
    : { source: 'clip', apply: 'values' };
}

export function settingLabel(setting: AutoAdjustSetting): string {
  return COLOUR_CONTROLS.find((control) => control.key === setting)!.label;
}

/** The settings each analysed clip's grade animates, which applying values leaves unchanged, with how many clips. */
export function animatedParts(
  project: ProjectDocument,
  target: AutoAdjustTarget,
): { setting: AutoAdjustSetting; clips: number }[] {
  const counts = new Map<AutoAdjustSetting, number>();
  for (const part of target.parts) {
    const owner = gradeOwnerOf(project, part.clip.clip.id);
    for (const setting of owner ? animatedSettings(owner) : []) counts.set(setting, (counts.get(setting) ?? 0) + 1);
  }
  return [...counts].map(([setting, clips]) => ({ setting, clips }));
}

/** How many analysed clips' grades animate a setting Auto sets, which applying values leaves unchanged there. */
export function clipsKeepingAnimated(project: ProjectDocument, target: AutoAdjustTarget): number {
  return target.parts.filter((part) => {
    const owner = gradeOwnerOf(project, part.clip.clip.id);
    return owner !== null && animatedSettings(owner).length > 0;
  }).length;
}

/**
 * The edit Auto applies in one Undo step: each analysed clip's grade values, or a keyframe of all eleven settings at
 * the source frame the graded clip shows at the playhead.
 */
export function autoAdjustCommands(
  context: AutoAdjustContext,
  target: AutoAdjustTarget,
  apply: AutoAdjustApply,
  corrections: ReadonlyMap<string, AutoCorrection>,
  intensity: number,
): EditCommand[] {
  return target.parts.flatMap((part): EditCommand[] => {
    const clipId = part.clip.clip.id;
    const owner = gradeOwnerOf(context.project, clipId);
    const correction = corrections.get(clipId);
    if (!owner || !correction) return [];
    if (apply === 'keyframe') {
      const frame = sourceFrameAt(part.clip, context.playhead);
      if (frame === null) return [];
      return captureCommands(owner, frame, scaleCorrection(correction, intensity), clipOwner(clipId));
    }
    const edit = autoAdjustCommand(owner, correction, intensity, clipOwner(clipId));
    return edit ? [edit] : [];
  });
}

export interface AutoAdjustAnalysis {
  /** Each analysed clip's correction, by clip. */
  corrections: ReadonlyMap<string, AutoCorrection>;
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

export const analysedFrames = (target: AutoAdjustTarget): number =>
  target.parts.reduce((sum, part) => sum + part.sourceFrames.length, 0);

/**
 * Decodes each clip's frames from its proxy, one temporary reader at a time, and fits each clip's correction on its
 * own; a clip that cannot be analysed fails the whole analysis, naming it.
 */
export async function analyseTarget(
  target: AutoAdjustTarget,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, AutoCorrection>> {
  const { sampleProxyFrames } = await import('../preview/frame-sampler.js');
  const total = analysedFrames(target);
  const corrections = new Map<string, AutoCorrection>();
  let before = 0;
  await forEachSerial(target.parts, async ({ clip, name, asset, sourceFrames }) => {
    const named = (message: string): string => (name ? `${name}: ${message}` : message);
    const sampled = await sampleProxyFrames(proxyUrl(asset.id), sourceFrames, signal, (done) =>
      onProgress(before + done, total),
    ).catch((cause: unknown) => {
      if (signal.aborted || !(cause instanceof Error)) throw cause;
      throw new Error(named(`Could not read the frames of ${asset.name}: ${cause.message}`));
    });
    before += sourceFrames.length;
    const frames = sourceFrames.flatMap((source): AnalysisFrame[] => {
      const frame = sampled.get(source);
      return frame ? [frame] : [];
    });
    const illuminants: (IlluminantEstimate | null)[] = [];
    await forEachSerial(frames, async (frame) => {
      illuminants.push(frameIlluminant(frame));
      await nextTask();
      signal.throwIfAborted();
    });
    const correction = analyseAutoAdjust(frames, illuminants);
    if (!correction) throw new Error(named('These frames are too dark or too uniform to analyse.'));
    corrections.set(clip.clip.id, correction);
  });
  return corrections;
}
