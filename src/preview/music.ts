import type { MusicTrack } from '../shared/model.js';
import { musicGainAt, musicSourceFrame } from '../shared/audio.js';
import { framesToSeconds } from '../shared/timing.js';

function aborted(): DOMException { return new DOMException('Music operation cancelled', 'AbortError'); }
function waitMedia(audio: HTMLAudioElement, ready: () => boolean, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted());
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Music did not become ready within 10 seconds.')), 10_000);
    const check = (): void => { if (audio.error) finish(new Error(audio.error.message || 'Music decoding failed.')); else if (ready()) finish(); };
    const cancel = (): void => finish(aborted());
    const events = ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'];
    const finish = (error?: Error): void => {
      clearTimeout(timeout); events.forEach((event) => audio.removeEventListener(event, check)); signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve();
    };
    events.forEach((event) => audio.addEventListener(event, check)); signal.addEventListener('abort', cancel, { once: true }); check();
  });
}

/** A media-element/Web Audio clock; no whole-file AudioBuffer allocation. */
export class MusicPlayback {
  readonly #audio = document.createElement('audio');
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #source: MediaElementAudioSourceNode | null = null;
  #track: MusicTrack | null = null;
  #running = false;
  #clockTime = 0;
  #clockFrame = 0;
  #disposed = false;
  #lastErrorFrames = 0;
  constructor() { this.#audio.preload = 'auto'; this.#audio.dataset['pascapMusic'] = 'true'; document.body.append(this.#audio); }
  get clockSeconds(): number { return this.#context?.currentTime ?? performance.now() / 1000; }
  get errorFrames(): number { return this.#lastErrorFrames; }
  get hasMusic(): boolean { return this.#track !== null; }
  async configure(track: MusicTrack | null, signal: AbortSignal): Promise<void> {
    this.pause(); this.#track = track ? { ...track } : null; this.#lastErrorFrames = 0;
    if (!track) { this.#audio.removeAttribute('src'); this.#audio.load(); return; }
    const url = new URL(`/api/audio/${track.mediaId}/playback`, location.href).href;
    if (this.#audio.src !== url || this.#audio.error) { this.#audio.src = url; this.#audio.load(); }
    await waitMedia(this.#audio, () => this.#audio.readyState >= HTMLMediaElement.HAVE_METADATA, signal);
  }
  #setup(): void {
    if (this.#context) return;
    this.#context = new AudioContext();
    this.#gain = this.#context.createGain(); this.#source = this.#context.createMediaElementSource(this.#audio);
    this.#source.connect(this.#gain); this.#gain.connect(this.#context.destination);
  }
  async resumeContext(): Promise<void> { if (this.#track) { this.#setup(); await this.#context!.resume(); } }
  async start(frame: number, signal: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    if (this.#track) {
      await this.resumeContext();
      const source = musicSourceFrame(this.#track, frame);
      if (source !== null) {
        this.#audio.currentTime = framesToSeconds(source);
        await waitMedia(this.#audio, () => !this.#audio.seeking && this.#audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, signal);
        this.#gain!.gain.setValueAtTime(musicGainAt(this.#track, frame), this.#context!.currentTime);
        await this.#audio.play();
      }
    }
    if (signal.aborted) { this.pause(); throw aborted(); }
    this.#clockFrame = frame; this.#clockTime = this.clockSeconds; this.#running = true;
  }
  projectFrame(): number {
    return this.#clockFrame + Math.floor(Math.max(0, this.clockSeconds - this.#clockTime) / framesToSeconds(1) + 1e-7);
  }
  /** Returns false at a source wrap/late seek so video and music can buffer together. */
  sync(frame: number): boolean {
    if (!this.#track || !this.#running) return true;
    const source = musicSourceFrame(this.#track, frame);
    this.#gain!.gain.setValueAtTime(musicGainAt(this.#track, frame), this.#context!.currentTime);
    if (source === null) { this.#audio.pause(); return true; }
    const desired = framesToSeconds(source);
    this.#lastErrorFrames = Math.abs(this.#audio.currentTime - desired) / framesToSeconds(1);
    return !this.#audio.paused && !this.#audio.seeking && !this.#audio.ended && this.#lastErrorFrames <= 1;
  }
  pause(): void { this.#running = false; this.#audio.pause(); }
  dispose(): void {
    this.#disposed = true; this.pause(); this.#track = null; this.#audio.removeAttribute('src'); this.#audio.load(); this.#audio.remove();
    this.#source?.disconnect(); this.#gain?.disconnect(); void this.#context?.close();
  }
}