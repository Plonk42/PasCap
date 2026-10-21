import { keyframeLimitReason } from '../shared/auto-colour.js';
import type { MediaAsset } from '../shared/media.js';
import type { VideoLayer } from '../shared/model.js';
import type { PlacedClip, TimelineLayout } from '../shared/timeline.js';
import { whiteBalanceWindow } from '../shared/white-balance.js';
import { mediaReady } from './display.js';

/**
 * The track's clip shown at `frame`. In a dissolve, the selected clip when it is one of the two,
 * otherwise the outgoing clip until the midpoint and the incoming one from it.
 */
export function clipAtPlayhead(
  layout: TimelineLayout,
  layerId: string,
  frame: number,
  preferredClipId: string | null,
): PlacedClip | null {
  const active = layout.clips.filter(
    (item) => item.clip.layerId === layerId && frame >= item.start && frame < item.end,
  );
  if (active.length < 2) return active[0] ?? null;
  const preferred = active.find((item) => item.clip.id === preferredClipId);
  if (preferred) return preferred;
  const [outgoing, incoming] = [...active].sort((left, right) => left.start - right.start) as [PlacedClip, PlacedClip];
  return 2 * (frame - incoming.start) >= outgoing.end - incoming.start ? incoming : outgoing;
}

export interface WhiteBalanceTarget {
  clip: PlacedClip;
  asset: MediaAsset;
  /** Project frames analysed around the playhead, and the source frame each one shows. */
  projectFrames: number[];
  sourceFrames: number[];
}

export type WhiteBalanceAvailability = { target: WhiteBalanceTarget; reason: null } | { target: null; reason: string };

/** The track's clip at the playhead with its prepared recording, or why an analysis cannot read it. */
export function readyClipAtPlayhead(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
  preferredClipId: string | null,
  purpose: string,
): { clip: PlacedClip; asset: MediaAsset; reason: null } | { clip: null; asset: null; reason: string } {
  const clip = clipAtPlayhead(layout, layer.id, frame, preferredClipId);
  if (!clip)
    return { clip: null, asset: null, reason: `Move the playhead over a clip on ${layer.name} to ${purpose}.` };
  const asset = readyAsset(assets, clip.clip.mediaId);
  if (!asset) return { clip: null, asset: null, reason: 'Prepare the recording of the clip at the playhead first.' };
  return { clip, asset, reason: null };
}

/** The recording with a verified proxy an analysis can read, or null. */
export function readyAsset(assets: readonly MediaAsset[], mediaId: string): MediaAsset | null {
  const asset = assets.find((item) => item.id === mediaId);
  return asset && mediaReady(asset) && asset.prepared?.verification.frameCount === asset.metadata.frameCount
    ? asset
    : null;
}

/** What Auto white balance would analyse at the playhead, or why it cannot run there. */
export function whiteBalanceTarget(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
  preferredClipId: string | null,
): WhiteBalanceAvailability {
  const { clip, asset, reason } = readyClipAtPlayhead(
    layer,
    layout,
    assets,
    frame,
    preferredClipId,
    'balance its light',
  );
  if (reason !== null) return { target: null, reason };
  const full = keyframeLimitReason(layer, frame);
  if (full !== null) return { target: null, reason: full };
  const projectFrames = whiteBalanceWindow(clip, frame);
  const sourceFrames = projectFrames.map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start));
  return { target: { clip, asset, projectFrames, sourceFrames }, reason: null };
}
