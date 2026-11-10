import type { MediaAsset } from '../shared/media.js';
import { framesToSeconds, PROJECT_FPS, rateLabel, sameRate, type FrameRate } from '../shared/timing.js';

export function mediaReady(asset: MediaAsset): boolean {
  return asset.status === 'ready' && asset.prepared !== null;
}
export function shortName(name: string): string {
  return name.replace(/\.(mp4|mov|m4v)$/i, '');
}
export function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}
/** Seconds of project frames, or of a recording's own frames at its `rate`. */
export function sourceSeconds(frames: number, rate: Readonly<FrameRate> = PROJECT_FPS): string {
  return `${framesToSeconds(frames, rate).toFixed(2)} s`;
}
/** " · 60 fps" for a recording not made at the project rate; empty otherwise. */
export function otherRateLabel(asset: MediaAsset): string {
  return sameRate(asset.metadata.frameRate, PROJECT_FPS) ? '' : ` · ${rateLabel(asset.metadata.frameRate)} fps`;
}
export function milliseconds(value: number | null | undefined): string {
  return value == null ? '—' : `${Math.round(value)} ms`;
}

export const MEDIA_DRAG_TYPE = 'application/x-pascap-media';
export const MUSIC_DRAG_TYPE = 'application/x-pascap-music';
export const CLIP_DRAG_TYPE = 'application/x-pascap-clip';
