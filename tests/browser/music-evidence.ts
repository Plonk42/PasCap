import type { Page } from '@playwright/test';

export interface MusicReceipt {
  generation: number;
  startFrame: number;
  contextFrame: number;
  samples: number;
}
export interface MusicSignalFrame {
  frame: number;
  samples: number;
  peak: number;
  rightPeak: number;
  stereoDifference: number;
}
export interface MusicStreamEvidence {
  starts: number;
  pauses: number;
  active: boolean;
  underruns: number;
  context: AudioContext | null;
  receipt: MusicReceipt | null;
  samples: unknown[];
  renderedSignal: MusicSignalFrame[];
  playback: unknown[];
  ranges: number;
  largestRange: number;
}
declare global {
  interface Window {
    musicStreamEvidence: MusicStreamEvidence;
  }
}

/** Observe actual audio-thread receipts/PCM output, never the engine's inferred frame. */
export async function installMusicEvidence(page: Page, captureSignal = false): Promise<void> {
  await page.addInitScript((captureSignal) => {
    Reflect.set(globalThis, '__name', (fn: unknown) => fn);
    const evidence: MusicStreamEvidence = {
      starts: 0,
      pauses: 0,
      active: false,
      underruns: 0,
      context: null,
      receipt: null,
      samples: [],
      renderedSignal: [],
      playback: [],
      ranges: 0,
      largestRange: 0,
    };
    window.musicStreamEvidence = evidence;
    if (captureSignal) {
      // Wrap only the synthetic test's processor. Observe its actual render
      // outputs after process(), without changing samples, clock or messages.
      const observerUrl = URL.createObjectURL(
        new Blob(
          [
            `
        const nativeRegister = globalThis.registerProcessor;
        globalThis.registerProcessor = (name, Processor) => {
          if (name !== 'pascap-streaming-music') return nativeRegister(name, Processor);
          nativeRegister(name, class extends Processor {
            constructor() {
              super();
              this.observation = null;
              const post = this.port.postMessage.bind(this.port);
              this.port.postMessage = (message, transfer) => {
                if (message.kind === 'started') this.observation = {
                  generation: message.generation, origin: message.contextStart, startFrame: message.startFrame,
                  frames: Array.from({ length: 90 }, (_, frame) => ({ frame, samples: 0, peak: 0, rightPeak: 0, stereoDifference: 0 }))
                };
                post(message, transfer);
              };
              this.port.addEventListener('message', ({ data }) => {
                if (data.kind !== 'stop' || data.generation !== this.observation?.generation) return;
                post({ kind: 'test-pcm-signal', generation: data.generation, frames: this.observation.frames });
                this.observation = null;
              });
            }
            process(inputs, outputs, parameters) {
              const running = super.process(inputs, outputs, parameters);
              const observation = this.observation;
              const left = outputs[0]?.[0]; const right = outputs[0]?.[1];
              if (observation && left && right) for (let sample = 0; sample < left.length; sample++) {
                const frame = observation.startFrame + Math.floor((currentFrame + sample - observation.origin) / (48000 * 1001 / 30000));
                const entry = observation.frames[frame];
                if (!entry) continue;
                entry.samples++;
                entry.peak = Math.max(entry.peak, Math.abs(left[sample]));
                entry.rightPeak = Math.max(entry.rightPeak, Math.abs(right[sample]));
                entry.stereoDifference = Math.max(entry.stereoDifference, Math.abs(left[sample] - right[sample]));
              }
              return running;
            }
          });
        };
      `,
          ],
          { type: 'text/javascript' },
        ),
      );
      const observerModules = new WeakMap<Worklet, Promise<void>>();
      const nativeAddModule = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = async function (url, options) {
        let ready = observerModules.get(this);
        if (!ready) {
          ready = nativeAddModule.call(this, observerUrl);
          observerModules.set(this, ready);
        }
        await ready;
        await nativeAddModule.call(this, url, options);
      };
    }
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== 'pascap-streaming-music') return;
        evidence.context = context as AudioContext;
        const post = this.port.postMessage;
        let generation = -1;
        let stopped = true;
        this.port.postMessage = (message, transfer) => {
          if (message.kind === 'start') {
            generation = message.generation;
            stopped = false;
            evidence.starts++;
            evidence.receipt = null;
            window.dispatchEvent(new Event('pascap-test-music-start'));
          }
          if (message.kind === 'stop') {
            stopped = true;
            evidence.pauses++;
            evidence.active = false;
            window.dispatchEvent(new Event('pascap-test-music-stop'));
          }
          Reflect.apply(post, this.port, [message, transfer]);
        };
        this.port.addEventListener('message', ({ data }) => {
          if (data.kind === 'test-pcm-signal' && data.generation === generation) {
            evidence.renderedSignal = data.frames;
            return;
          }
          if (stopped || data.generation !== generation) return;
          if (data.kind === 'started') evidence.active = true;
          if (data.kind === 'underrun') {
            evidence.underruns++;
            evidence.active = false;
          }
          if (data.kind !== 'started' && data.kind !== 'rendered') return;
          evidence.receipt = {
            generation: data.generation,
            startFrame: data.startFrame,
            contextFrame: data.contextFrame,
            samples: data.samples,
          };
          if (evidence.samples.length < 500)
            evidence.samples.push({
              ...evidence.receipt,
              contextTime: context.currentTime,
              output: (context as AudioContext).getOutputTimestamp(),
              now: performance.now(),
            });
        });
      }
    };
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const range = new Headers(args[1]?.headers).get('Range');
      const url = args[0] instanceof Request ? args[0].url : args[0].toString();
      if (range && url.includes('/api/audio/')) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        evidence.ranges++;
        evidence.largestRange = Math.max(
          evidence.largestRange,
          match ? Number(match[2]) - Number(match[1]) + 1 : Infinity,
        );
      }
      return nativeFetch(...args);
    };
  }, captureSignal);
}

/** Bounded causal evidence for an unexpected restart; never changes playback. */
export async function observeMusicPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const evidence = window.musicStreamEvidence;
    let previous = '';
    const capture = (event: string): void => {
      const state = window.pascapLab!.engine.diagnostics();
      const identity = `${state.status}:${state.requestedFrame}:${state.frame}`;
      if (event === 'state' && identity === previous) return;
      previous = identity;
      if (evidence.playback.length >= 500) return;
      evidence.playback.push({
        event,
        now: performance.now(),
        state,
        receipt: evidence.receipt,
        output: evidence.context?.getOutputTimestamp(),
        videos: Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-pascap-decoder]'), (video) => ({
          slot: video.dataset['pascapDecoder'],
          currentTime: video.currentTime,
          rate: video.playbackRate,
          paused: video.paused,
          seeking: video.seeking,
          ready: video.readyState,
        })),
      });
    };
    window.pascapLab!.engine.subscribe(() => capture('state'));
    window.addEventListener('pascap-test-music-start', () => capture('music-start'));
    window.addEventListener('pascap-test-music-stop', () => capture('music-stop'));
  });
}
