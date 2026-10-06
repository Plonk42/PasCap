/** The current preview transport: little-endian, interleaved stereo PCM16. */
export const MUSIC_SAMPLE_RATE = 48_000;
export const MUSIC_CHANNELS = 2;
export const MUSIC_BYTES_PER_SAMPLE = 4;
export const MUSIC_CHUNK_SAMPLES = 16_384;
export const MUSIC_QUEUE_CHUNKS = 4;
export const MUSIC_SAMPLES_PER_FRAME = (48_000 * 1_001) / 30_000;
export interface MusicChunk {
  offset: number;
  data: Float32Array<ArrayBuffer>;
}
