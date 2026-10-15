/** Decoded frames one timeline decoder may hold ahead of presentation, queued or inside the decoder. */
export const DECODER_FRAME_BUDGET = 6;
/**
 * Frames of one GOP a reversed decoder decodes forward and holds to deliver
 * backwards, besides DECODER_FRAME_BUDGET; lower wanted frames of a longer GOP
 * are decoded again from its keyframe on a later pass.
 */
export const REVERSE_GROUP_FRAMES = 6;

/**
 * `frames` are the original source frames to output, ascending, or descending
 * when `reverse`; a stream decodes every frame they depend on and skips to the
 * keyframe before the next one when that is shorter. `complete` means no
 * extension will follow. A credit's `needed` is the frame the clock needs now:
 * frames it has passed (below it, above it when reversed) are skipped.
 */
export type VideoReaderCommand =
  | {
      kind: 'start';
      lane: number;
      generation: number;
      url: string;
      frames: number[];
      reverse: boolean;
      complete: boolean;
    }
  | { kind: 'extend'; lane: number; generation: number; frames: number[]; complete: boolean }
  | { kind: 'credit'; lane: number; generation: number; count: number; needed: number }
  | { kind: 'stop'; lane: number };

export type VideoReaderReport =
  | { kind: 'frame'; lane: number; generation: number; sourceFrame: number; frame: VideoFrame }
  | { kind: 'failed'; lane: number; generation: number; message: string };
