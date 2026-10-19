import type { EditCommand } from '../shared/commands.js';
import { activeLayerSetting } from '../shared/keyframes.js';
import type { MediaAsset } from '../shared/media.js';
import { MAX_TRACK_KEYFRAMES, type VideoLayer } from '../shared/model.js';
import type { PlacedClip, TimelineLayout } from '../shared/timeline.js';
import { whiteBalanceWindow, type WhiteBalance } from '../shared/white-balance.js';
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

/** What Auto white balance would analyse at the playhead, or why it cannot run there. */
export function whiteBalanceTarget(
  layer: VideoLayer,
  layout: TimelineLayout,
  assets: readonly MediaAsset[],
  frame: number,
  preferredClipId: string | null,
): WhiteBalanceAvailability {
  const clip = clipAtPlayhead(layout, layer.id, frame, preferredClipId);
  if (!clip) return { target: null, reason: `Move the playhead over a clip on ${layer.name} to balance its light.` };
  const asset = assets.find((item) => item.id === clip.clip.mediaId);
  if (!asset || !mediaReady(asset) || asset.prepared?.verification.frameCount !== asset.metadata.frameCount)
    return { target: null, reason: 'Prepare the recording of the clip at the playhead first.' };
  if (layer.keyframes.length >= MAX_TRACK_KEYFRAMES && !layer.keyframes.some((key) => key.frame === frame))
    return {
      target: null,
      reason: `This track already has ${MAX_TRACK_KEYFRAMES} keyframes. Move the playhead to one of them, or remove one.`,
    };
  const projectFrames = whiteBalanceWindow(clip, frame);
  const sourceFrames = projectFrames.map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start));
  return { target: { clip, asset, projectFrames, sourceFrames }, reason: null };
}

/** Captures both settings at the playhead exactly like their diamonds, in one transaction. */
export function whiteBalanceCommands(layer: VideoLayer, frame: number, balance: WhiteBalance): EditCommand[] {
  return (['temperature', 'tint'] as const).map((setting) => ({
    type: activeLayerSetting(layer, setting, frame) ? 'layer-key-value' : 'layer-key-toggle',
    layerId: layer.id,
    frame,
    setting,
    value: balance[setting],
  }));
}

export function proxyUrl(mediaId: string): string {
  return `/api/media/${encodeURIComponent(mediaId)}/proxy`;
}
