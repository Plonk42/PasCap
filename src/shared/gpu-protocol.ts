import type { ColourSettings } from './colour.js';
import type { DetailSettings } from './detail.js';
import type { SpatialPose } from './spatial.js';

/**
 * Loopback protocol between the export service and its headless-browser GPU compositor page.
 * GET /next returns a frame bundle: uint32 LE header length, UTF-8 JSON header, then each
 * source's fitted RGB8 content rows, bottom row first. POST /result returns row bands of the
 * premultiplied RGBA16 group as little-endian rows in WebGL readback order (bottom row first),
 * each with its byte offset in that order.
 */
export const GPU_PROTOCOL_VERSION = 3;
export const GPU_TOKEN_HEADER = 'x-pascap-gpu-token';
export const GPU_SEQUENCE_HEADER = 'x-pascap-gpu-sequence';
export const GPU_OFFSET_HEADER = 'x-pascap-gpu-offset';
/** Concurrent result uploads stay within Chrome's six connections per host. */
export const GPU_RESULT_BANDS = 4;

export interface GpuWorkerConfig {
  protocol: number;
  width: number;
  height: number;
}
export interface GpuHello {
  protocol: number;
  renderer: string;
  /** EXT_texture_norm16 RGBA16 target; otherwise an RGBA32F target converted by the page. */
  norm16: boolean;
  error: string | null;
}
export interface GpuHelloReply {
  accept: boolean;
}
export interface GpuFrameSource {
  /** Fitted content rectangle, the uploaded texture. */
  width: number;
  height: number;
  /** The clip's own grade, applied before the adjustment's Colour. */
  grade: ColourSettings;
  colour: ColourSettings;
  spatial: SpatialPose;
  detail: DetailSettings;
  originalWidth: number;
  originalHeight: number;
  opacity: number;
  blendWeight: number;
  brightness: number;
}
export interface GpuFrameHeader {
  sequence: number;
  sources: GpuFrameSource[];
}
export interface GpuFailure {
  sequence: number | null;
  error: string;
}
