import { musicGainAt } from './audio.js';
import type { MusicTrack } from './model.js';
import {
  MUSIC_BYTES_PER_SAMPLE,
  MUSIC_CHANNELS,
  MUSIC_CHUNK_SAMPLES,
  MUSIC_SAMPLES_PER_FRAME,
} from './music-format.js';
export {
  MUSIC_BYTES_PER_SAMPLE,
  MUSIC_CHANNELS,
  MUSIC_CHUNK_SAMPLES,
  MUSIC_QUEUE_CHUNKS,
  MUSIC_SAMPLE_RATE,
  MUSIC_SAMPLES_PER_FRAME,
  type MusicChunk,
} from './music-format.js';

export interface MusicRead {
  source: number | null;
  samples: number;
}

/** Split reads at placement/selected-range boundaries; never read the whole file. */
export function musicReadAt(track: MusicTrack, frame: number, maximum: number): MusicRead {
  const offset = Math.round(frame * MUSIC_SAMPLES_PER_FRAME) - Math.round(track.start * MUSIC_SAMPLES_PER_FRAME);
  const duration = Math.round(track.duration * MUSIC_SAMPLES_PER_FRAME);
  const start = Math.round(track.sourceIn * MUSIC_SAMPLES_PER_FRAME);
  const length = Math.round(track.sourceOut * MUSIC_SAMPLES_PER_FRAME) - start;
  if (offset < 0 || offset >= duration || (!track.loop && offset >= length)) {
    const untilStart = offset < 0 ? -offset : maximum;
    return { source: null, samples: Math.min(maximum, untilStart) };
  }
  const selected = track.loop ? offset % length : offset;
  return { source: start + selected, samples: Math.min(maximum, length - selected, duration - offset) };
}

/** Convert exactly one bounded PCM16 range, applying the project's amplitude envelope. */
export function decodeMusicRange(
  bytes: ArrayBuffer | DataView<ArrayBuffer>,
  track: MusicTrack,
  frame: number,
): Float32Array<ArrayBuffer> {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MUSIC_CHUNK_SAMPLES * MUSIC_BYTES_PER_SAMPLE ||
    bytes.byteLength % MUSIC_BYTES_PER_SAMPLE
  ) {
    throw new Error('Music range is not a complete bounded stereo PCM16 block.');
  }
  const input = bytes instanceof DataView ? bytes : new DataView(bytes);
  const output = new Float32Array(bytes.byteLength / 2);
  for (let sample = 0; sample < output.length / MUSIC_CHANNELS; sample++) {
    const gain = musicGainAt(track, frame + sample / MUSIC_SAMPLES_PER_FRAME) / 32_768;
    for (let channel = 0; channel < MUSIC_CHANNELS; channel++) {
      output[sample * MUSIC_CHANNELS + channel] = input.getInt16((sample * MUSIC_CHANNELS + channel) * 2, true) * gain;
    }
  }
  return output;
}
