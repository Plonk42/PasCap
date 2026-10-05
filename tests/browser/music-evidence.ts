import type { Page } from '@playwright/test';

export interface MusicReceipt { generation: number; startFrame: number; contextFrame: number; samples: number }
export interface MusicStreamEvidence {
  starts: number;
  pauses: number;
  active: boolean;
  underruns: number;
  context: AudioContext | null;
  analyser: AnalyserNode | null;
  signal: Float32Array<ArrayBuffer>;
  receipt: MusicReceipt | null;
  samples: unknown[];
  ranges: number;
  largestRange: number;
}
declare global { interface Window { musicStreamEvidence: MusicStreamEvidence } }

/** Observe actual audio-thread receipts/PCM output, never the engine's inferred frame. */
export async function installMusicEvidence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(globalThis, '__name', (fn: unknown) => fn);
    const evidence: MusicStreamEvidence = {
      starts: 0, pauses: 0, active: false, underruns: 0, context: null,
      analyser: null, signal: new Float32Array(256), receipt: null, samples: [], ranges: 0, largestRange: 0
    };
    window.musicStreamEvidence = evidence;
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name !== 'pascap-streaming-music') return;
        evidence.context = context as AudioContext;
        evidence.analyser = context.createAnalyser(); evidence.analyser.fftSize = 256;
        this.connect(evidence.analyser);
        const post = this.port.postMessage.bind(this.port);
        let generation = -1;
        let stopped = true;
        this.port.postMessage = (message, transfer) => {
          if (message.kind === 'start') {
            generation = message.generation; stopped = false;
            evidence.starts++; evidence.receipt = null;
            window.dispatchEvent(new Event('pascap-test-music-start'));
          }
          if (message.kind === 'stop') {
            stopped = true; evidence.pauses++; evidence.active = false;
            window.dispatchEvent(new Event('pascap-test-music-stop'));
          }
          post(message, Array.isArray(transfer) ? { transfer } : transfer);
        };
        this.port.addEventListener('message', ({ data }) => {
          if (stopped || data.generation !== generation) return;
          if (data.kind === 'started') evidence.active = true;
          if (data.kind === 'underrun') { evidence.underruns++; evidence.active = false; }
          if (data.kind !== 'started' && data.kind !== 'rendered') return;
          evidence.receipt = { generation: data.generation, startFrame: data.startFrame, contextFrame: data.contextFrame, samples: data.samples };
          if (evidence.samples.length < 500) evidence.samples.push({
            ...evidence.receipt, contextTime: context.currentTime,
            output: (context as AudioContext).getOutputTimestamp(), now: performance.now()
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
        evidence.largestRange = Math.max(evidence.largestRange, match ? Number(match[2]) - Number(match[1]) + 1 : Infinity);
      }
      return nativeFetch(...args);
    };
  });
}
