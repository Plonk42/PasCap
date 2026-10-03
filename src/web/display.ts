import type { MediaAsset } from '../shared/media.js';
import { framesToSeconds } from '../shared/timing.js';

export function mediaReady(asset: MediaAsset): boolean { return asset.status === 'ready' && asset.prepared !== null; }
export function shortName(name: string): string { return name.replace(/\.(mp4|mov|m4v)$/i, ''); }
export function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}
export function sourceSeconds(frames: number): string { return `${framesToSeconds(frames).toFixed(2)} s`; }
export function milliseconds(value: number | null | undefined): string { return value == null ? '—' : `${Math.round(value)} ms`; }

export const MEDIA_DRAG_TYPE = 'application/x-pascap-media';
export const CLIP_DRAG_TYPE = 'application/x-pascap-clip';