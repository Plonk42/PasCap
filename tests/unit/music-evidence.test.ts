import type { Page } from '@playwright/test';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { installMusicEvidence, type MusicSignalFrame, type MusicSignalReference } from '../browser/music-evidence.js';

interface Signal {
  kind: string;
  frames: MusicSignalFrame[];
  quanta: unknown[];
  receiptSampleViolations: number;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Execute the actual injected observer with a deterministic source processor. */
async function observe(corruptSample = -1, corruptReceipt = false): Promise<Signal> {
  const pcm = Array.from({ length: 6408 }, (_, index) => (Math.floor(index / 2) % 200) * 100 - 10_000);
  const reference: MusicSignalReference = {
    pcm,
    tracks: [
      {
        id: 'test',
        mediaId: 'synthetic',
        sourceIn: 0,
        sourceOut: 2,
        start: 0,
        duration: 2,
        gainDb: 0,
        fadeIn: 0,
        fadeOut: 0,
        loop: false,
      },
    ],
  };
  let observerBlob!: Blob;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!(blob instanceof Blob)) throw new Error('Observer must be a JavaScript Blob.');
    observerBlob = blob;
    return 'blob:synthetic-observer';
  });
  vi.stubGlobal('window', { fetch: vi.fn() });
  vi.stubGlobal(
    'AudioWorklet',
    class {
      addModule(): void {}
    },
  );
  vi.stubGlobal('AudioWorkletNode', class {});
  const page = {
    addInitScript: async (callback: (argument: unknown) => void, argument: unknown) => callback(argument),
  } as unknown as Page;
  await installMusicEvidence(page, true, reference);

  const messages: Signal[] = [];
  let stop!: (event: { data: { kind: string; generation: number } }) => void;
  let Constructor!: new () => {
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: object): boolean;
  };
  const scope = {
    currentFrame: 1000,
    registerProcessor: (_name: string, processor: typeof Constructor) => {
      Constructor = processor;
    },
  };
  runInNewContext(await observerBlob.text(), scope);
  class SourceProcessor {
    played = 0;
    readonly port = {
      postMessage: (message: Signal) => {
        messages.push(message);
      },
      addEventListener: (_event: string, listener: typeof stop) => {
        stop = listener;
      },
    };
    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const channels = outputs[0]!;
      for (let sample = 0; sample < channels[0]!.length; sample++)
        for (let channel = 0; channel < 2; channel++)
          channels[channel]![sample] =
            pcm[(this.played + sample) * 2 + channel]! / 32768 + (this.played + sample === corruptSample ? 0.01 : 0);
      if (!this.played)
        this.port.postMessage({
          kind: 'started',
          generation: 1,
          contextStart: scope.currentFrame,
          startFrame: 0,
          samples: channels[0]!.length,
        } as unknown as Signal);
      this.played += channels[0]!.length;
      this.port.postMessage({ kind: 'rendered', samples: this.played + (corruptReceipt ? 1 : 0) } as unknown as Signal);
      return true;
    }
  }
  scope.registerProcessor('pascap-streaming-music', SourceProcessor as unknown as typeof Constructor);
  const processor = new Constructor();
  for (let quantum = 0; quantum < 16; quantum++) {
    // One repeated native timestamp, then a 256-sample catch-up. Consumption
    // remains consecutive, exactly as witnessed in real Chrome trace evidence.
    scope.currentFrame = 1000 + (quantum === 2 ? 1 : quantum) * 128;
    expect(processor.process([], [[new Float32Array(128), new Float32Array(128)]], {})).toBe(true);
  }
  stop({ data: { kind: 'stop', generation: 1 } });
  return messages.find((message) => message.kind === 'test-pcm-signal')!;
}

it('attributes actual PCM to consumed samples despite repeated native quantum timestamps', async () => {
  const signal = await observe();
  expect(signal.quanta).toHaveLength(1);
  expect(signal.frames[0]!.samples).toBe(1602);
  expect(signal.frames[1]!.samples).toBe(446);
  expect(signal.frames.every((frame) => frame.mismatchedSamples === 0 && frame.maximumSampleError <= 0.0000002)).toBe(
    true,
  );
  expect(signal.receiptSampleViolations).toBe(0);
});

it('still detects corrupted PCM inside the repeated-timestamp quantum', async () => {
  const signal = await observe(256);
  expect(signal.frames[0]!.mismatchedSamples).toBe(1);
  expect(signal.frames[0]!.maximumSampleError).toBeGreaterThan(0.009);
  expect(signal.frames[0]!.mismatchWitnesses).toHaveLength(1);
});

it('independently detects receipts inconsistent with actual observed output lengths', async () => {
  expect((await observe(-1, true)).receiptSampleViolations).toBe(16);
});
