import { firefox, type FullConfig } from '@playwright/test';

export interface FirefoxAudioReadiness {
  state: string;
  sampleRate: number;
  renderedFrames: number;
  invalidSamples: number;
  renderedTime: number;
  outputTime: number;
  error: string;
}

const guidance =
  'Firefox audio prerequisite failed. On GPU-less Linux, install pulseaudio/pulseaudio-utils and run scripts/ci/firefox.sh for a private 48 kHz stereo null output. A reachable audio service is required even in headless Firefox. Do not mock the audio clock, skip regressions or increase playback deadlines.';

export function requireFirefoxAudio(result: FirefoxAudioReadiness): void {
  if (
    result.error ||
    result.state !== 'running' ||
    result.sampleRate !== 48_000 ||
    !Number.isSafeInteger(result.renderedFrames) ||
    result.renderedFrames < 4096 ||
    result.invalidSamples !== 0 ||
    !Number.isFinite(result.renderedTime) ||
    result.renderedTime <= 0 ||
    !Number.isFinite(result.outputTime) ||
    result.outputTime < result.renderedTime
  ) {
    throw new Error(`${guidance}\n${JSON.stringify(result)}`);
  }
}

/** Actual stereo DSP and device output clock; no fake audio context or clock. */
export default async function firefoxAudio(config: FullConfig): Promise<void> {
  const use = config.projects[0]!.use;
  const browser = await firefox
    .launch({ ...use.launchOptions, headless: use.headless ?? true, timeout: 15_000 })
    .catch((cause: unknown) => {
      throw new Error(
        `${guidance}\nBrowser launch failed: ${cause instanceof Error ? cause.message : 'Unknown browser launch error.'}`,
      );
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const page = await browser.newPage();
        // Only the disposable probe document is supplied here. Audio uses
        // the real browser/backend; no editor requests are intercepted.
        const url = 'http://127.0.0.1:4320/firefox-audio-prerequisite';
        await page.route(url, (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Firefox audio prerequisite</title>' }),
        );
        await page.goto(url);
        return page.evaluate(async (): Promise<FirefoxAudioReadiness> => {
          const context = new AudioContext({ sampleRate: 48_000 });
          const result: FirefoxAudioReadiness = {
            state: context.state,
            sampleRate: context.sampleRate,
            renderedFrames: 0,
            invalidSamples: 0,
            renderedTime: 0,
            outputTime: 0,
            error: '',
          };
          const module = URL.createObjectURL(
            new Blob(
              [
                `
                        class Source extends AudioWorkletProcessor {
                            process(_inputs, outputs) {
                                outputs[0][0].fill(0.125); outputs[0][1].fill(-0.125);
                                return true;
                            }
                        }
                        class Observer extends AudioWorkletProcessor {
                            frames = 0; invalid = 0; sent = false;
                            process(inputs, outputs) {
                                const frames = outputs[0][0].length;
                                for (let channel = 0; channel < 2; channel++) {
                                    const input = inputs[0][channel];
                                    for (let sample = 0; sample < frames; sample++) {
                                        const value = input?.[sample];
                                        if (value !== (channel === 0 ? 0.125 : -0.125)) this.invalid++;
                                        outputs[0][channel][sample] = value ?? 0;
                                    }
                                }
                                this.frames += frames;
                                if (!this.sent && this.frames >= 4096) {
                                    this.sent = true;
                                    this.port.postMessage({ frames: this.frames, invalid: this.invalid, end: currentFrame + frames });
                                }
                                return true;
                            }
                        }
                        registerProcessor('prerequisite-source', Source);
                        registerProcessor('prerequisite-observer', Observer);
                    `,
              ],
              { type: 'text/javascript' },
            ),
          );
          let source: AudioWorkletNode | undefined;
          let observer: AudioWorkletNode | undefined;
          try {
            await context.audioWorklet.addModule(module);
            source = new AudioWorkletNode(context, 'prerequisite-source', {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [2],
            });
            observer = new AudioWorkletNode(context, 'prerequisite-observer', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2],
            });
            const rendered = new Promise<void>((resolve, reject) => {
              source!.onprocessorerror = () => reject(new Error('Actual audio prerequisite processor failed.'));
              observer!.onprocessorerror = source!.onprocessorerror;
              observer!.port.onmessage = ({ data }: MessageEvent<{ frames: number; invalid: number; end: number }>) => {
                result.renderedFrames = data.frames;
                result.invalidSamples = data.invalid;
                result.renderedTime = data.end / context.sampleRate;
                resolve();
              };
            });
            source.connect(observer);
            observer.connect(context.destination);
            await Promise.all([context.resume(), rendered]);
            await new Promise<void>((resolve, reject) => {
              const clock = setInterval(() => {
                const time = context.getOutputTimestamp().contextTime;
                if (time === undefined || !Number.isFinite(time) || time < 0) {
                  clearInterval(clock);
                  reject(new Error('Actual audio output timestamp is unavailable or invalid.'));
                  return;
                }
                result.outputTime = time;
                if (result.outputTime >= result.renderedTime) {
                  clearInterval(clock);
                  resolve();
                }
              }, 16);
            });
          } catch (cause) {
            result.error = cause instanceof Error ? cause.message : 'Unknown audio prerequisite error.';
          } finally {
            result.state = context.state;
            source?.disconnect();
            observer?.disconnect();
            source?.port.close();
            observer?.port.close();
            URL.revokeObjectURL(module);
            await context.close();
          }
          return result;
        });
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${guidance}\nReal audio resume/render/output probe exceeded its 10-second deadline.`)),
          10_000,
        );
      }),
    ]);
    requireFirefoxAudio(result);
    console.log(`Firefox audio ready: ${JSON.stringify({ browser: browser.version(), ...result })}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith(guidance)) throw cause;
    throw new Error(`${guidance}\n${cause instanceof Error ? cause.message : 'Unknown audio prerequisite error.'}`);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
