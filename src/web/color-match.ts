import { AUTO_ADJUST, AUTO_ADJUST_SETTINGS, type AutoAdjustSetting } from '../shared/auto-adjust.js';
import { animatedSettings, autoAdjustCommand, captureCommands, keyframeLimitReason } from '../shared/auto-color.js';
import { compilePixelGrade, createColorSettings, type ColorSettings } from '../shared/color.js';
import type { EditCommand } from '../shared/commands.js';
import { gradeColorAt } from '../shared/grade.js';
import { matchFrame, matchStyle, towardsMatch, type FrameMatch, type GradedFrame } from '../shared/look-match.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { StyleSummary } from '../shared/styles.js';
import { gradePosition, sampleTimeline, type PlacedClip, type TimelineLayout } from '../shared/timeline.js';
import type { AnalysisFrame } from '../shared/white-balance.js';
import { proxyUrl } from './api.js';
import { readyAsset } from './auto-white-balance.js';
import { gradeOwnerOf, sourceFrameAt } from './color-owner.js';
import type { ColorReference } from './color-reference.js';
import { shortName } from './display.js';

/** Where Color → Match runs: the selected clips, at the playhead. */
export interface MatchContext {
  project: ProjectDocument;
  layout: TimelineLayout;
  assets: readonly MediaAsset[];
  playhead: number;
  /** The selected clips, which take the match; the first is the one the Color tab shows. */
  clipIds: readonly string[];
}

/** One clip matched at one of its source frames. */
export interface MatchPart {
  clip: PlacedClip;
  asset: MediaAsset;
  sourceFrame: number;
  /** The output frame of the clip showing it. */
  offset: number;
  /** Whether that frame is the one at the playhead, rather than the clip's middle. */
  atPlayhead: boolean;
  /** How errors name it among the selected clips. */
  name: string;
}

/** What a reference resolves to: a frame and how its grade shows it, or a registered style. */
export type ResolvedReference =
  | {
      kind: 'clip' | 'recording';
      key: string;
      /** The reference clip, which is never matched at the reference frame itself. */
      clipId: string | null;
      asset: MediaAsset;
      sourceFrame: number;
      color: ColorSettings;
      /** "DJI_0277 · timeline frame, as graded". */
      label: string;
      detail: string;
    }
  | { kind: 'style'; key: string; style: StyleSummary; label: string; detail: string };

type Resolved<T> = { value: T; reason: null } | { value: null; reason: string };
const unavailable = <T>(reason: string): Resolved<T> => ({ value: null, reason });
const preparedAt = (asset: MediaAsset): string => asset.prepared?.verification.verifiedAt ?? '';

/** The reference as the project shows it now, or why it cannot be matched to. */
export function resolveReference(
  reference: ColorReference | null,
  context: Pick<MatchContext, 'project' | 'assets'>,
  styles: readonly StyleSummary[],
): Resolved<ResolvedReference> {
  if (!reference) return unavailable('Choose a reference first: a timeline frame, a recording frame or a style.');
  if (reference.kind === 'style') {
    const style = styles.find((item) => item.id === reference.styleId);
    if (!style) return unavailable('The reference style is no longer registered: choose another reference.');
    return {
      value: {
        kind: 'style',
        key: `style:${style.id}:${style.createdAt}`,
        style,
        label: style.name,
        detail: 'Registered style',
      },
      reason: null,
    };
  }
  if (reference.kind === 'clip') {
    const clip = context.project.clips.find((item) => item.id === reference.clipId);
    if (!clip) return unavailable('The reference clip was deleted: choose another reference.');
    const asset = readyAsset(context.assets, clip.mediaId);
    if (!asset) return unavailable('Prepare the recording of the reference clip first.');
    const color = gradeColorAt(clip.grade, reference.sourceFrame);
    return {
      value: {
        kind: 'clip',
        key: `clip:${clip.id}:${asset.id}:${preparedAt(asset)}:${reference.sourceFrame}:${JSON.stringify(color)}`,
        clipId: clip.id,
        asset,
        sourceFrame: reference.sourceFrame,
        color,
        label: shortName(asset.name),
        detail: 'Timeline frame, as graded',
      },
      reason: null,
    };
  }
  const asset = readyAsset(context.assets, reference.mediaId);
  if (!asset) return unavailable('The reference recording is no longer prepared: choose another reference.');
  return {
    value: {
      kind: 'recording',
      key: `recording:${asset.id}:${preparedAt(asset)}:${reference.sourceFrame}`,
      clipId: null,
      asset,
      sourceFrame: reference.sourceFrame,
      color: createColorSettings(),
      label: shortName(asset.name),
      detail: 'Recording frame, as shot',
    },
    reason: null,
  };
}

/** The clip and source frame the timeline shows on top at a project frame, for "Use frame at playhead". */
export function referenceAtPlayhead(
  context: Pick<MatchContext, 'project' | 'layout' | 'playhead'>,
): Resolved<ColorReference & { kind: 'clip' }> {
  const shown = sampleTimeline(context.project, context.playhead, context.layout).at(-1);
  if (!shown) return unavailable('No clip is visible at the playhead.');
  return { value: { kind: 'clip', clipId: shown.clipId, sourceFrame: shown.sourceFrame }, reason: null };
}

/** The frame a selected clip is matched at: the one at the playhead when it is over the clip, else its middle. */
export function matchFrameOf(
  clip: PlacedClip,
  playhead: number,
): { sourceFrame: number; offset: number; atPlayhead: boolean } {
  const atPlayhead = sourceFrameAt(clip, playhead) !== null;
  const offset = atPlayhead ? playhead - clip.start : (clip.end - clip.start) >> 1;
  return { sourceFrame: clip.retiming.sourceAt(offset), offset, atPlayhead };
}

/** The selected clips with the frames they are matched at, or why they cannot be. */
export function matchParts(context: MatchContext, reference: ResolvedReference | null): Resolved<MatchPart[]> {
  const parts: MatchPart[] = [];
  const clips = context.clipIds.flatMap((id) => context.layout.clips.find((item) => item.clip.id === id) ?? []);
  if (!clips.length) return unavailable('Select the clips to match on the timeline.');
  for (const clip of [...clips].sort((left, right) => left.start - right.start)) {
    const asset = readyAsset(context.assets, clip.clip.mediaId);
    const name = clips.length > 1 ? `${shortName(asset?.name ?? clip.clip.mediaId)} at ${clip.start}` : '';
    if (!asset) return unavailable(`Prepare the recording of ${name || 'this clip'} first.`);
    const frame = matchFrameOf(clip, context.playhead);
    if (
      reference?.kind === 'clip' &&
      reference.clipId === clip.clip.id &&
      reference.sourceFrame === frame.sourceFrame
    ) {
      if (clips.length === 1)
        return unavailable('The playhead shows the reference frame itself: move it to the frame to match.');
      continue;
    }
    parts.push({ clip, asset, ...frame, name });
  }
  if (!parts.length) return unavailable('The selected clips show the reference frame itself.');
  return { value: parts, reason: null };
}

/** One analysis: the reference and each part's clip, recording, frame and the grade settings a match keeps. */
export function analysisKey(reference: ResolvedReference, parts: readonly MatchPart[]): string {
  return [
    reference.key,
    ...parts.map(
      (part) =>
        `${part.clip.clip.id}/${part.asset.id}/${preparedAt(part.asset)}/${part.sourceFrame}/${JSON.stringify(keptSettings(partColor(part)))}`,
    ),
  ].join('|');
}

/** The grade's settings at the matched frame, as the image shows them there. */
function partColor({ clip, offset }: MatchPart): ColorSettings {
  return gradeColorAt(clip.clip.grade, gradePosition(clip, offset));
}

function keptSettings(color: ColorSettings): Partial<ColorSettings> {
  const kept: Partial<ColorSettings> = { ...color };
  for (const setting of AUTO_ADJUST_SETTINGS) delete kept[setting];
  return kept;
}

/** Each part's match: its eleven settings, and how far they follow the picture rather than light and look. */
export type MatchResults = ReadonlyMap<string, FrameMatch>;

// Session memory only: the last analyses of the open project, never saved or in history.
let resultsProject: string | null = null;
const results = new Map<string, MatchResults>();

export function cachedMatch(projectId: string, key: string): MatchResults | null {
  return resultsProject === projectId ? (results.get(key) ?? null) : null;
}

export function rememberMatch(projectId: string, key: string, matched: MatchResults): void {
  if (resultsProject !== projectId) {
    results.clear();
    resultsProject = projectId;
  }
  results.set(key, matched);
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function decode(
  asset: MediaAsset,
  sourceFrame: number,
  signal: AbortSignal,
  name: string,
): Promise<AnalysisFrame> {
  const { sampleProxyFrames } = await import('../preview/frame-sampler.js');
  const frames = await sampleProxyFrames(proxyUrl(asset.id), [sourceFrame], signal).catch((cause: unknown) => {
    if (signal.aborted || !(cause instanceof Error)) throw cause;
    const prefix = name ? `${name}: ` : '';
    throw new Error(`${prefix}Could not read the frame of ${asset.name}: ${cause.message}`);
  });
  return frames.get(sourceFrame)!;
}

/** The last reference frames decoded, for the analysis and the thumbnail alike. */
const referenceFrames = new Map<string, AnalysisFrame>();
const KEPT_REFERENCE_FRAMES = 8;

/** A reference's frame, decoded from its proxy unless it was recently. */
export async function referenceFrame(
  reference: ResolvedReference & { kind: 'clip' | 'recording' },
  signal: AbortSignal,
): Promise<AnalysisFrame> {
  const key = `${reference.asset.id}:${preparedAt(reference.asset)}:${reference.sourceFrame}`;
  const known = referenceFrames.get(key);
  if (known) return known;
  const frame = await decode(reference.asset, reference.sourceFrame, signal, 'Reference');
  referenceFrames.set(key, frame);
  if (referenceFrames.size > KEPT_REFERENCE_FRAMES) referenceFrames.delete(referenceFrames.keys().next().value!);
  return frame;
}

const TOO_UNIFORM = 'This frame is too dark or too uniform to match.';

const thumbnails = new Map<string, string>();
/**
 * The reference frame as its grade shows it (Shadows, Highlights, HDR and Detail aside, which need the whole image), as
 * an image URL for the Match section.
 */
export async function referenceThumbnail(
  reference: ResolvedReference & { kind: 'clip' | 'recording' },
  signal: AbortSignal,
): Promise<string> {
  const known = thumbnails.get(reference.key);
  if (known) return known;
  const frame = await referenceFrame(reference, signal);
  const grade = compilePixelGrade(reference.color);
  const pixels = new ImageData(frame.width, frame.height);
  for (let index = 0; index < frame.data.length; index += 4) {
    const graded = grade([frame.data[index]! / 255, frame.data[index + 1]! / 255, frame.data[index + 2]! / 255]);
    for (let channel = 0; channel < 3; channel++) pixels.data[index + channel] = Math.round(graded[channel]! * 255);
    pixels.data[index + 3] = 255;
  }
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext('2d')?.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  thumbnails.set(reference.key, url);
  if (thumbnails.size > KEPT_REFERENCE_FRAMES) thumbnails.delete(thumbnails.keys().next().value!);
  return url;
}

/** Decodes the reference frame and each part's frame from their proxies, one at a time, and matches each part. */
export async function analyzeMatch(
  reference: ResolvedReference,
  parts: readonly MatchPart[],
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, FrameMatch>> {
  const total = parts.length + (reference.kind === 'style' ? 0 : 1);
  let done = 0;
  let fit: (target: GradedFrame) => FrameMatch | null;
  if (reference.kind === 'style') {
    const { look } = reference.style;
    fit = (target) => {
      const correction = matchStyle(look, target);
      return correction && { correction, likeness: 0 };
    };
  } else {
    const graded = { frame: await referenceFrame(reference, signal), color: reference.color };
    fit = (target) => matchFrame(graded, target);
    onProgress(++done, total);
  }
  const matched = new Map<string, FrameMatch>();
  await forEachSerial(parts, async (part) => {
    const frame = await decode(part.asset, part.sourceFrame, signal, part.name);
    await nextTask();
    signal.throwIfAborted();
    const match = fit({ frame, color: partColor(part) });
    if (!match) throw new Error(part.name ? `${part.name}: ${TOO_UNIFORM}` : TOO_UNIFORM);
    matched.set(part.clip.clip.id, match);
    onProgress(++done, total);
  });
  return matched;
}

export type MatchApply = 'values' | 'keyframe';

/** Why a keyframe cannot take the match: it goes to one clip, at the playhead frame. */
export function keyframeReason(project: ProjectDocument, parts: readonly MatchPart[]): string | null {
  if (parts.length !== 1) return 'Keyframes go to one clip at a time: select one clip.';
  const [part] = parts;
  if (!part!.atPlayhead) return 'Move the playhead over the clip to key the match there.';
  const owner = gradeOwnerOf(project, part!.clip.clip.id);
  if (!owner) return 'This clip is no longer on the timeline.';
  return keyframeLimitReason(owner, part!.sourceFrame, { kind: 'clip', clipId: part!.clip.clip.id });
}

/**
 * The edit Match applies in one Undo step, each part moved `intensity` (0–1) of the way from its grade to its match:
 * each clip grade's values (animated settings left unchanged), or a keyframe of the eleven at the matched frame.
 */
export function matchCommands(
  project: ProjectDocument,
  parts: readonly MatchPart[],
  matched: MatchResults,
  apply: MatchApply,
  intensity: number,
): EditCommand[] {
  return parts.flatMap((part): EditCommand[] => {
    const clipId = part.clip.clip.id;
    const owner = gradeOwnerOf(project, clipId);
    const match = matched.get(clipId);
    if (!owner || !match) return [];
    const values = towardsMatch(partColor(part), match.correction, intensity);
    if (apply === 'keyframe') return captureCommands(part.sourceFrame, values, { kind: 'clip', clipId });
    const edit = autoAdjustCommand(owner, values, AUTO_ADJUST.balancedIntensity, { kind: 'clip', clipId });
    return edit ? [edit] : [];
  });
}

/** The settings a Grade values match leaves unchanged on some part, because its grade animates them. */
export function animatedInParts(project: ProjectDocument, parts: readonly MatchPart[]): AutoAdjustSetting[] {
  const animated = new Set<AutoAdjustSetting>();
  for (const part of parts) {
    const owner = gradeOwnerOf(project, part.clip.clip.id);
    for (const setting of owner ? animatedSettings(owner) : []) animated.add(setting);
  }
  return [...animated];
}

/** Grade values while no part animates a matched setting; a keyframe at the playhead once one does and it can. */
export function initialApply(project: ProjectDocument, parts: readonly MatchPart[]): MatchApply {
  return animatedInParts(project, parts).length > 0 && keyframeReason(project, parts) === null ? 'keyframe' : 'values';
}

/** How a match followed the reference: by the picture of a like scene, or by light and look across scenes. */
export function likenessNote(matched: MatchResults, reference: ResolvedReference): string {
  if (reference.kind === 'style') return 'Matched to the style’s look, from Auto’s balance.';
  const values = [...matched.values()].map((match) => match.likeness);
  const least = Math.min(...values);
  const most = Math.max(...values);
  if (least >= 0.99) return 'Same scene: matched to the reference picture.';
  if (most <= 0.01)
    return values.length > 1
      ? 'Different scenes: each clip takes the reference’s light and look.'
      : 'Different scene: takes the reference’s light and look.';
  return 'Similar scene: partly matched to the reference picture, partly to its light and look.';
}
