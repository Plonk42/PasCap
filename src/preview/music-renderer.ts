import { MUSIC_CHANNELS, MUSIC_CHUNK_SAMPLES, MUSIC_QUEUE_CHUNKS, type MusicChunk } from '../shared/music-format.js';

/** Audio-thread ownership: at most four transferable blocks and no duration-sized storage. */
export class MusicRenderer {
  readonly #chunks: MusicChunk[] = [];
  #read = 0;
  #queued = 0;
  #played = 0;
  #running = true;
  get played(): number {
    return this.#played;
  }
  get running(): boolean {
    return this.#running;
  }
  get queuedChunks(): number {
    return this.#chunks.length;
  }
  enqueue(chunk: MusicChunk): void {
    const samples = chunk.data.length / MUSIC_CHANNELS;
    if (this.#chunks.length >= MUSIC_QUEUE_CHUNKS || chunk.offset !== this.#queued || samples !== MUSIC_CHUNK_SAMPLES) {
      throw new Error('Music blocks must be bounded, consecutive and credit-controlled.');
    }
    this.#queued += samples;
    this.#chunks.push(chunk);
  }
  /** An underrun is explicit and freezes consumption; never advance across invented silence. */
  render(left: Float32Array, right: Float32Array): { released: number; underrun: boolean } {
    left.fill(0);
    right.fill(0);
    if (!this.#running) return { released: 0, underrun: false };
    let released = 0;
    for (let index = 0; index < left.length; index++) {
      const chunk = this.#chunks[0];
      if (!chunk) {
        this.#running = false;
        return { released, underrun: true };
      }
      left[index] = chunk.data[this.#read * MUSIC_CHANNELS]!;
      right[index] = chunk.data[this.#read * MUSIC_CHANNELS + 1]!;
      this.#read++;
      this.#played++;
      if (this.#read === MUSIC_CHUNK_SAMPLES) {
        this.#chunks.shift();
        this.#read = 0;
        released++;
      }
    }
    return { released, underrun: false };
  }
}
