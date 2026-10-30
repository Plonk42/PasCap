import { keyframeLimitReason } from '../shared/auto-color.js';
import type { MediaAsset } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import type { PlacedClip, TimelineLayout } from '../shared/timeline.js';
import { whiteBalanceWindow } from '../shared/white-balance.js';
import { gradeOwnerOf, sourceFrameAt } from './color-owner.js';
import { mediaReady } from './display.js';

export interface WhiteBalanceTarget {
  clip: PlacedClip;
  asset: MediaAsset;
  /** The source frame the clip shows at the playhead, where Temperature and Tint are keyed. */
  frame: number;
  /** Project frames analyzed around the playhead, and the source frame each one shows. */
  projectFrames: number[];
  sourceFrames: number[];
}

export type WhiteBalanceAvailability = { target: WhiteBalanceTarget; reason: null } | { target: null; reason: string };

/** The recording with a verified proxy an analysis can read, or null. */
export function readyAsset(assets: readonly MediaAsset[], mediaId: string): MediaAsset | null {
  const asset = assets.find((item) => item.id === mediaId);
  return asset && mediaReady(asset) && asset.prepared?.verification.frameCount === asset.metadata.frameCount
    ? asset
    : null;
}

/** What Auto white balance would analyze around the playhead in the graded clip, or why it cannot run there. */
export function whiteBalanceTarget(
  project: ProjectDocument,
  clipId: string,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  playhead: number,
): WhiteBalanceAvailability {
  const clip = layout.clips.find((item) => item.clip.id === clipId);
  const owner = gradeOwnerOf(project, clipId);
  if (!clip || !owner) return { target: null, reason: 'This clip is no longer on the timeline.' };
  const frame = sourceFrameAt(clip, playhead);
  if (frame === null) return { target: null, reason: 'Move the playhead over this clip to balance its light.' };
  const asset = readyAsset(assets, clip.clip.mediaId);
  if (!asset) return { target: null, reason: 'Prepare the recording of this clip first.' };
  const full = keyframeLimitReason(owner, frame, { kind: 'clip', clipId });
  if (full !== null) return { target: null, reason: full };
  const projectFrames = whiteBalanceWindow(clip, playhead);
  const sourceFrames = projectFrames.map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start));
  return { target: { clip, asset, frame, projectFrames, sourceFrames }, reason: null };
}
