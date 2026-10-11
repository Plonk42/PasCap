/** Decoded frames one timeline decoder may hold ahead of presentation, queued or inside the decoder. */
export const DECODER_FRAME_BUDGET = 6;

/**
 * `frames` are the ascending original source frames to output; a stream decodes
 * every frame they depend on and skips to the keyframe before the next one when
 * that is shorter. `complete` means no extension will follow.
 */
export type VideoReaderCommand =
  | { kind: 'start'; lane: number; generation: number; url: string; frames: number[]; complete: boolean }
  | { kind: 'extend'; lane: number; generation: number; frames: number[]; complete: boolean }
  | { kind: 'credit'; lane: number; generation: number; count: number; minimum: number }
  | { kind: 'stop'; lane: number };

export type VideoReaderReport =
  | { kind: 'frame'; lane: number; generation: number; sourceFrame: number; frame: VideoFrame }
  | { kind: 'failed'; lane: number; generation: number; message: string };
