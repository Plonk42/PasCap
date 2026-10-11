import type { Page } from '@playwright/test';

/**
 * Fault injection between the WebCodecs reader worker and the editor: withhold
 * real decoded frames, or replace the next one with a decoder failure. Frames
 * are never fabricated; released frames are delivered unchanged and in order.
 */
export interface VideoFrameGate {
  hold: boolean;
  failNext: string | null;
  heldFrames: number;
  releasedFrames: number;
  release: () => void;
}

declare global {
  interface Window {
    videoFrameGate: VideoFrameGate;
  }
}

export async function installVideoFrameGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Install before nested transpiled callbacks; init-script ordering is unspecified.
    Reflect.set(globalThis, '__name', (fn: unknown) => fn);
    const held: (() => void)[] = [];
    const gate: VideoFrameGate = {
      hold: false,
      failNext: null,
      heldFrames: 0,
      releasedFrames: 0,
      release() {
        gate.hold = false;
        const pending = held.splice(0);
        gate.releasedFrames += pending.length;
        pending.forEach((deliver) => deliver());
      },
    };
    window.videoFrameGate = gate;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name !== 'pascap-video-reader') return;
        let handler: ((event: MessageEvent) => void) | null = null;
        super.onmessage = (
          event: MessageEvent<{ kind: string; lane: number; generation: number; frame?: VideoFrame }>,
        ) => {
          const deliver = (): void => handler?.call(this, event);
          if (event.data.kind !== 'frame') deliver();
          else if (gate.failNext !== null) {
            const message = gate.failNext;
            gate.failNext = null;
            event.data.frame!.close();
            const { lane, generation } = event.data;
            handler?.call(this, new MessageEvent('message', { data: { kind: 'failed', lane, generation, message } }));
          } else if (gate.hold) {
            gate.heldFrames++;
            held.push(deliver);
          } else deliver();
        };
        Object.defineProperty(this, 'onmessage', {
          get: () => handler,
          set: (value: ((event: MessageEvent) => void) | null) => {
            handler = value;
          },
        });
      }
    };
  });
}
