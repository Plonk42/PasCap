import type { Page } from '@playwright/test';
import type { MusicTrack } from '../../src/shared/model.js';

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
  maximumSampleError: number;
  mismatchedSamples: number;
  mismatchWitnesses?: unknown[];
}
export interface MusicSignalReference {
  /** Interleaved PCM16 read from the existing synthetic cache, never invented audio. */
  pcm: number[];
  tracks: MusicTrack[];
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
  renderQuanta: unknown[];
  receiptSampleViolations: number;
  playback: unknown[];
  queueEvents: unknown[];
  rangeTimings: unknown[];
  ranges: number;
  largestRange: number;
}
declare global {
  interface Window {
    musicStreamEvidence: MusicStreamEvidence;
  }
}

/** Observe actual audio-thread receipts/PCM output, never the engine's inferred frame. */
export async function installMusicEvidence(
  page: Page,
  captureSignal = false,
  reference?: MusicSignalReference,
): Promise<void> {
  await page.addInitScript(
    ({ captureSignal, reference }) => {
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
        renderQuanta: [],
        receiptSampleViolations: 0,
        playback: [],
        queueEvents: [],
        rangeTimings: [],
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
        const reference = ${JSON.stringify(reference ?? null)};
        const samplesPerFrame = 48000 * 1001 / 30000;
        const referenceAt = position => {
          const expected = [0, 0];
          for (const track of reference.tracks) {
            const offset = position - Math.round(track.start * samplesPerFrame);
            const sourceIn = Math.round(track.sourceIn * samplesPerFrame);
            const length = Math.round(track.sourceOut * samplesPerFrame) - sourceIn;
            if (offset < 0 || offset >= Math.round(track.duration * samplesPerFrame) || (!track.loop && offset >= length)) continue;
            const source = sourceIn + (track.loop ? offset % length : offset);
            const elapsed = position / samplesPerFrame - track.start;
            const gain = Math.pow(10, track.gainDb / 20)
              * (track.fadeIn ? Math.min(1, Math.max(0, elapsed / track.fadeIn)) : 1)
              * (track.fadeOut ? Math.min(1, Math.max(0, (track.duration - elapsed) / track.fadeOut)) : 1);
            for (let channel = 0; channel < 2; channel++) {
              const value = reference.pcm[source * 2 + channel];
              if (value === undefined) throw new Error('Synthetic PCM reference does not cover the selected source.');
              expected[channel] = Math.fround(expected[channel] + value * gain / 32768);
            }
          }
          return expected;
        };
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
                  previousContextFrame: null,
                  renderedSamples: 0, quanta: [], receiptSampleViolations: 0, witnessCount: 0,
                  frames: Array.from({ length: 90 }, (_, frame) => ({ frame, samples: 0, peak: 0, rightPeak: 0, stereoDifference: 0, maximumSampleError: 0, mismatchedSamples: 0, mismatchWitnesses: [] }))
                };
                if ((message.kind === 'started' || message.kind === 'rendered') && this.observation &&
                    message.samples !== this.observation.renderedSamples + this.quantumLength)
                  this.observation.receiptSampleViolations++;
                post(message, transfer);
              };
              this.port.addEventListener('message', ({ data }) => {
                if (data.kind !== 'stop' || data.generation !== this.observation?.generation) return;
                post({ kind: 'test-pcm-signal', generation: data.generation, frames: this.observation.frames,
                  quanta: this.observation.quanta, receiptSampleViolations: this.observation.receiptSampleViolations });
                this.observation = null;
              });
            }
            process(inputs, outputs, parameters) {
              const beforeContextFrame = currentFrame;
              this.quantumLength = outputs[0]?.[0]?.length ?? 0;
              const running = super.process(inputs, outputs, parameters);
              const observation = this.observation;
              const left = outputs[0]?.[0]; const right = outputs[0]?.[1];
              if (observation && observation.quanta.length < 10 && currentFrame - observation.origin !== observation.renderedSamples)
                observation.quanta.push({ beforeContextFrame, contextFrame: currentFrame, previousContextFrame: observation.previousContextFrame, renderedSamples: observation.renderedSamples, origin: observation.origin });
              if (observation && left && right) for (let sample = 0; sample < left.length; sample++) {
                // Chrome can expose one repeated native currentFrame and catch up
                // on the next quantum. PCM belongs to consecutive consumed samples,
                // independently checked against the processor's actual receipts.
                // Native timestamps remain evidence, not waveform array indices.
                const position = Math.round(observation.startFrame * samplesPerFrame) + observation.renderedSamples + sample;
                const frame = Math.floor(position / samplesPerFrame);
                const entry = observation.frames[frame];
                if (!entry) continue;
                entry.samples++;
                entry.peak = Math.max(entry.peak, Math.abs(left[sample]));
                entry.rightPeak = Math.max(entry.rightPeak, Math.abs(right[sample]));
                entry.stereoDifference = Math.max(entry.stereoDifference, Math.abs(left[sample] - right[sample]));
                if (reference) {
                  const expected = referenceAt(position);
                  const error = Math.max(
                    Math.abs(left[sample] - Math.max(-1, Math.min(1, expected[0]))),
                    Math.abs(right[sample] - Math.max(-1, Math.min(1, expected[1])))
                  );
                  entry.maximumSampleError = Math.max(entry.maximumSampleError, error);
                  if (!Number.isFinite(error) || error > 0.0000002) {
                    entry.mismatchedSamples++;
                    if (observation.witnessCount < 10 && entry.mismatchWitnesses.length < 3) {
                      observation.witnessCount++;
                      entry.mismatchWitnesses.push({
                      contextFrame: currentFrame, previousContextFrame: observation.previousContextFrame,
                      origin: observation.origin, sample, position, consumedPosition: observation.renderedSamples + sample, expected,
                      actual: [left[sample], right[sample]], error,
                      sources: reference.tracks.map(track => {
                        const offset = position - Math.round(track.start * samplesPerFrame);
                        const sourceIn = Math.round(track.sourceIn * samplesPerFrame);
                        const length = Math.round(track.sourceOut * samplesPerFrame) - sourceIn;
                        const source = sourceIn + (track.loop ? offset % length : offset);
                        return { id: track.id, offset, source, length, pcm: reference.pcm.slice(source * 2, source * 2 + 2) };
                      })
                      });
                    }
                  }
                }
              }
              if (observation && left && right) {
                observation.previousContextFrame = currentFrame;
                observation.renderedSamples += left.length;
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
            if (['start', 'stop', 'chunk'].includes(message.kind) && evidence.queueEvents.length < 500)
              evidence.queueEvents.push({
                direction: 'sent',
                kind: message.kind,
                generation: message.generation,
                offset: message.chunk?.offset,
                now: performance.now(),
                contextTime: context.currentTime,
              });
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
              evidence.renderQuanta = data.quanta;
              evidence.receiptSampleViolations = data.receiptSampleViolations;
              return;
            }
            if (stopped || data.generation !== generation) return;
            if (['started', 'credit', 'underrun'].includes(data.kind) && evidence.queueEvents.length < 500)
              evidence.queueEvents.push({
                direction: 'received',
                ...data,
                now: performance.now(),
                contextTime: context.currentTime,
              });
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
        const started = performance.now();
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
        const response = await nativeFetch(...args);
        if (range && url.includes('/api/audio/') && evidence.rangeTimings.length < 500)
          evidence.rangeTimings.push({ range, started, completed: performance.now(), status: response.status });
        return response;
      };
    },
    { captureSignal, reference },
  );
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
