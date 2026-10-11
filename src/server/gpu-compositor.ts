import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_PROTOCOL_VERSION,
  GPU_SEQUENCE_HEADER,
  GPU_TOKEN_HEADER,
  type GpuFailure,
  type GpuFrameHeader,
  type GpuFrameSource,
  type GpuHello,
  type GpuHelloReply,
  type GpuWorkerConfig,
} from '../shared/gpu-protocol.js';
import { forEachSerial } from '../shared/serial.js';
import { ServiceError } from './errors.js';
import type { ContentBounds } from './layered-frame.js';

export type GpuBackend = 'gl' | 'vulkan' | 'swiftshader';
/**
 * Hardware ANGLE backends, in order; the first non-software renderer wins. ANGLE's Vulkan
 * backend selects a discrete GPU when present, while GL follows the display's (often integrated) one.
 */
export const GPU_BACKENDS: readonly GpuBackend[] = ['vulkan', 'gl'];
const BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i;
export const GPU_STARTUP_TIMEOUT_MS = 30_000;
export const GPU_FRAME_TIMEOUT_MS = 60_000;
const IDLE_POLL_MS = 20_000;
const JSON_LIMIT = 16_384;
/** Browser profiles name their owning service process, so a killed service's leftovers are recognisable. */
const PROFILE_PREFIX = 'pascap-gpu-';
const PROFILE_OWNER = /^pascap-gpu-(\d+)-/;

export interface GpuGroupSource {
  /** The export's target-size RGB8 frame; only its fitted content rectangle is sent. */
  rgb: Uint8Array;
  bounds: ContentBounds;
  parameters: Omit<GpuFrameSource, 'width' | 'height'>;
}
export interface GpuCompositorOptions {
  width: number;
  height: number;
  signal: AbortSignal;
  /** Browser executable; otherwise google-chrome or chromium from PATH. */
  chrome?: string | null;
  /** Tests only: accept SwiftShader so CI can exercise the worker without a GPU. */
  softwareRenderer?: boolean;
  startupTimeoutMs?: number;
  frameTimeoutMs?: number;
  /** Test seam replacing the bundled page script. */
  script?: () => Promise<string>;
}
export type GpuStart = { compositor: GpuCompositor; reason: null } | { compositor: null; reason: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}
function deferred<T>(): Deferred<T> {
  const result = { settled: false } as Deferred<T>;
  result.promise = new Promise<T>((resolve, reject) => {
    result.resolve = (value) => {
      result.settled = true;
      resolve(value);
    };
    result.reject = (error) => {
      result.settled = true;
      reject(error);
    };
  });
  result.promise.catch(() => undefined); // Rejections are observed by whoever awaits them.
  return result;
}

interface Frame {
  sequence: number;
  sources: readonly GpuGroupSource[];
  output: Buffer;
  sent: boolean;
  receiving: boolean;
  done: Deferred<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function isSoftwareRenderer(renderer: string): boolean {
  return !renderer.trim() || SOFTWARE_RENDERER.test(renderer);
}

export function browserArguments(backend: GpuBackend, profile: string, url: string): string[] {
  return [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-breakpad',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--password-store=basic',
    `--use-angle=${backend}`,
    ...(backend === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : ['--ignore-gpu-blocklist']),
    url,
  ];
}

async function findBrowser(explicit: string | null | undefined): Promise<string | null> {
  if (explicit) return explicit;
  const candidates = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((directory) => path.isAbsolute(directory))
    .flatMap((directory) => BROWSERS.map((name) => path.join(directory, name)));
  const usable = await Promise.all(
    candidates.map((candidate) =>
      access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      ),
    ),
  );
  return candidates[usable.indexOf(true)] ?? null;
}

let pageScript: Promise<string> | null = null;
/** Source checkouts (tsx/Vitest) bundle the current page; builds read the file Vite produced. */
export function gpuWorkerScript(): Promise<string> {
  pageScript ??= loadScript().catch((error: unknown) => {
    pageScript = null;
    throw error;
  });
  return pageScript;
}
async function loadScript(): Promise<string> {
  if (!import.meta.url.endsWith('.ts'))
    return readFile(new URL('../../gpu-worker/gpu-worker.js', import.meta.url), 'utf8');
  const { build } = await import('vite');
  const result = await build({
    configFile: fileURLToPath(new URL('../../vite.gpu-worker.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: { write: false },
  });
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((output) => ('output' in output ? output.output : []))
    .find((item) => item.type === 'chunk');
  if (chunk?.type !== 'chunk') throw new Error('The GPU worker page did not build.');
  return chunk.code;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('GPU worker request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
  });
}

/** Copy part of a bottom-row-first RGBA16 readback into its top-row-first output position. */
export function copyReversedRows(output: Buffer, chunk: Buffer, offset: number, rowBytes: number): void {
  const rows = output.length / rowBytes;
  let read = 0;
  while (read < chunk.length) {
    const position = offset + read;
    const row = Math.floor(position / rowBytes);
    const column = position - row * rowBytes;
    const count = Math.min(rowBytes - column, chunk.length - read);
    chunk.copy(output, (rows - 1 - row) * rowBytes + column, read, read + count);
    read += count;
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>PasCap GPU compositor</title><script type="module" src="/gpu-worker.js"></script>`;

/**
 * One headless browser page compositing detail/HDR track groups for one layered export.
 * Loopback HTTP with a per-launch random token; one frame in flight; the readback is
 * streamed into the caller's existing RGBA16 accumulator, never another Node frame buffer.
 */
export class GpuCompositor {
  readonly #options: GpuCompositorOptions;
  readonly #script: string;
  readonly #token = randomBytes(32);
  readonly #server: Server;
  readonly #hello = deferred<GpuHello>();
  readonly #helloReply = deferred<GpuHelloReply>();
  readonly #ready = deferred<void>();
  readonly #exited = deferred<void>();
  #port = 0;
  #profile = '';
  #child: ChildProcess | null = null;
  #stderr = '';
  #next: ServerResponse | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #frame: Frame | null = null;
  #sequence = 0;
  #failure: Error | null = null;
  #closing: Promise<void> | null = null;
  renderer = '';
  norm16 = false;
  frames = 0;
  private constructor(options: GpuCompositorOptions, script: string) {
    this.#options = options;
    this.#script = script;
    this.#server = createServer((request, response) => this.#handle(request, response));
  }

  /** Launch one backend; rejects with the reason it is unusable after cleaning up. */
  static async launch(
    binary: string,
    backend: GpuBackend,
    options: GpuCompositorOptions,
    script: string,
  ): Promise<GpuCompositor> {
    const compositor = new GpuCompositor(options, script);
    try {
      await compositor.#start(binary, backend);
      return compositor;
    } catch (error) {
      await compositor.close();
      throw error;
    }
  }

  async #start(binary: string, backend: GpuBackend): Promise<void> {
    const { signal } = this.#options;
    this.#profile = await mkdtemp(path.join(os.tmpdir(), `${PROFILE_PREFIX}${process.pid}-`));
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => resolve());
    });
    this.#port = (this.#server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${this.#port}/#${this.#token.toString('hex')}`;
    const child = spawn(binary, browserArguments(backend, this.#profile, url), {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.#child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-4_096);
    });
    child.once('error', (error) => {
      // A browser that never started emits no exit event.
      if (child.pid === undefined) this.#exited.resolve();
      this.#fail(new Error(`cannot start ${binary}: ${error.message}`));
    });
    child.once('exit', (code, exitSignal) => {
      this.#exited.resolve();
      this.#fail(new Error(`the browser exited (${exitSignal ?? code}) ${this.#stderr.trim().slice(-300)}`.trim()));
    });
    const deadline = Date.now() + (this.#options.startupTimeoutMs ?? GPU_STARTUP_TIMEOUT_MS);
    const hello = await this.#wait(this.#hello.promise, deadline, 'the page did not start');
    this.renderer = hello.renderer;
    this.norm16 = hello.norm16;
    const rejection = this.#reject(hello);
    this.#helloReply.resolve({ accept: rejection === null });
    if (rejection) throw new Error(rejection);
    await this.#wait(this.#ready.promise, deadline, 'the page did not prepare its programs');
    if (signal.aborted) throw new ServiceError('Job cancelled.', 499);
  }

  #reject(hello: GpuHello): string | null {
    if (hello.error) return hello.error;
    if (hello.protocol !== GPU_PROTOCOL_VERSION) return `page protocol ${hello.protocol} differs from the service`;
    if (isSoftwareRenderer(hello.renderer) && !this.#options.softwareRenderer)
      return `software renderer ${hello.renderer || '(unnamed)'}`;
    return null;
  }

  /** Waits for `promise` until the deadline, a browser failure or job cancellation. */
  async #wait<T>(promise: Promise<T>, deadline: number, timeout: string): Promise<T> {
    const { signal } = this.#options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${timeout} in time`)), Math.max(0, deadline - Date.now()));
          onAbort = () => reject(new ServiceError('Job cancelled.', 499));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of [this.#hello, this.#ready, this.#frame?.done])
      if (pending && !pending.settled) pending.reject(this.#failure);
  }

  /** One premultiplied RGBA16 group, top row first, written over `output`. */
  async compose(output: Buffer, sources: readonly GpuGroupSource[]): Promise<void> {
    const { width, height } = this.#options;
    if (this.#failure) throw this.#failure;
    if (this.#frame) throw new Error('The GPU compositor renders one frame at a time.');
    if (output.length !== width * height * 8 || !sources.length || sources.length > 2)
      throw new Error('A GPU track group needs one RGBA16 accumulator and one or two sources.');
    for (const { rgb, bounds } of sources) {
      if (
        rgb.length !== width * height * 3 ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > width ||
        bounds.y + bounds.height > height
      )
        throw new Error('Invalid GPU source frame or content rectangle.');
    }
    const frame: Frame = {
      sequence: ++this.#sequence,
      sources,
      output,
      sent: false,
      receiving: false,
      done: deferred<void>(),
    };
    this.#frame = frame;
    try {
      if (this.#next) this.#send(this.#next, frame);
      await this.#wait(
        frame.done.promise,
        Date.now() + (this.#options.frameTimeoutMs ?? GPU_FRAME_TIMEOUT_MS),
        'the GPU did not return its frame',
      );
      this.frames++;
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(message(error)));
      throw error;
    } finally {
      this.#frame = null;
    }
  }

  #send(response: ServerResponse, frame: Frame): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#next = null;
    frame.sent = true;
    const { width } = this.#options;
    const header: GpuFrameHeader = {
      sequence: frame.sequence,
      sources: frame.sources.map(({ bounds, parameters }) => ({
        ...parameters,
        width: bounds.width,
        height: bounds.height,
      })),
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(json.length, 0);
    const pixels = frame.sources.reduce((sum, { bounds }) => sum + bounds.width * bounds.height * 3, 0);
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(4 + json.length + pixels),
      'cache-control': 'no-store',
    });
    response.cork();
    response.write(prefix);
    response.write(json);
    // Content rows bottom first, as WebGL textures expect; no copy of the frame.
    for (const { rgb, bounds } of frame.sources)
      for (let row = bounds.y + bounds.height - 1; row >= bounds.y; row--) {
        const start = (row * width + bounds.x) * 3;
        response.write(rgb.subarray(start, start + bounds.width * 3));
      }
    response.uncork();
    response.end();
  }

  #authorized(request: IncomingMessage): boolean {
    const header = request.headers[GPU_TOKEN_HEADER];
    if (typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header)) return false;
    return timingSafeEqual(Buffer.from(header, 'hex'), this.#token);
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.headers.host !== `127.0.0.1:${this.#port}`) {
      response.writeHead(421).end();
      return;
    }
    const route = `${request.method} ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`;
    if (route === 'GET /') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'",
        'cache-control': 'no-store',
      });
      response.end(PAGE);
      return;
    }
    if (route === 'GET /gpu-worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(this.#script);
      return;
    }
    if (!this.#authorized(request)) {
      response.writeHead(403).end();
      return;
    }
    this.#route(route, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(400).end();
      this.#fail(new Error(`invalid GPU worker request: ${message(error)}`));
    });
  }

  async #route(route: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    switch (route) {
      case 'GET /config': {
        const config: GpuWorkerConfig = {
          protocol: GPU_PROTOCOL_VERSION,
          width: this.#options.width,
          height: this.#options.height,
        };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(config));
        return;
      }
      case 'POST /hello': {
        const hello = JSON.parse((await readBody(request, JSON_LIMIT)).toString('utf8')) as GpuHello;
        if (this.#hello.settled) throw new Error('repeated hello');
        this.#hello.resolve({
          protocol: Number(hello.protocol),
          renderer: String(hello.renderer).slice(0, 300),
          norm16: hello.norm16 === true,
          error: hello.error === null ? null : String(hello.error).slice(0, 500),
        });
        const reply = await this.#helloReply.promise;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
        return;
      }
      case 'GET /next':
        this.#poll(response);
        return;
      case 'POST /result':
        await this.#result(request, response);
        return;
      case 'POST /failure': {
        const failure = JSON.parse((await readBody(request, JSON_LIMIT)).toString('utf8')) as GpuFailure;
        response.writeHead(204).end();
        this.#fail(new Error(`the GPU page failed: ${String(failure.error).slice(0, 500)}`));
        return;
      }
      default:
        response.writeHead(404).end();
    }
  }

  #poll(response: ServerResponse): void {
    if (this.#next) this.#next.writeHead(204).end();
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#next = null;
    if (this.#closing !== null || this.#failure) {
      response.writeHead(410).end();
      return;
    }
    if (!this.#ready.settled) this.#ready.resolve();
    if (this.#frame && !this.#frame.sent) {
      this.#send(response, this.#frame);
      return;
    }
    this.#next = response;
    response.once('close', () => {
      if (this.#next === response) this.#next = null;
    });
    // Idle long polls return so neither side relies on an unbounded pending request.
    this.#idle = setTimeout(() => {
      if (this.#next === response) {
        this.#next = null;
        response.writeHead(204).end();
      }
    }, IDLE_POLL_MS);
  }

  #result(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const frame = this.#frame;
    const expected = this.#options.width * this.#options.height * 8;
    if (
      !frame?.sent ||
      frame.receiving ||
      Number(request.headers[GPU_SEQUENCE_HEADER]) !== frame.sequence ||
      Number(request.headers['content-length']) !== expected
    )
      throw new Error('unexpected GPU result');
    frame.receiving = true;
    const rowBytes = this.#options.width * 8;
    let received = 0;
    return new Promise<void>((resolve, reject) => {
      request.on('data', (chunk: Buffer) => {
        if (received + chunk.length > expected) {
          request.destroy();
          reject(new Error('oversized GPU result'));
          return;
        }
        copyReversedRows(frame.output, chunk, received, rowBytes);
        received += chunk.length;
      });
      request.once('error', reject);
      request.once('end', () => {
        if (received !== expected) {
          reject(new Error('truncated GPU result'));
          return;
        }
        response.writeHead(204).end();
        frame.done.resolve();
        resolve();
      });
    });
  }

  /** Stop the browser, its server and remove its profile; idempotent. */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }
  async #close(): Promise<void> {
    this.#fail(new Error('the GPU compositor closed'));
    if (!this.#helloReply.settled) this.#helloReply.resolve({ accept: false });
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#next && !this.#next.headersSent) this.#next.writeHead(410).end();
    this.#next = null;
    const child = this.#child;
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killed = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await this.#exited.promise;
      clearTimeout(killed);
    }
    this.#server.closeAllConnections();
    if (this.#server.listening) await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (this.#profile) await rm(this.#profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Profiles left by a service that was killed before it could close its browser. */
export async function removeStaleProfiles(): Promise<void> {
  const directory = os.tmpdir();
  const names = await readdir(directory).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const owner = PROFILE_OWNER.exec(name)?.[1];
      if (owner && !running(Number(owner))) await rm(path.join(directory, name), { recursive: true, force: true });
    }),
  );
}

/** First usable hardware backend, or the reason the CPU compositor must be used instead. */
export async function startGpuCompositor(options: GpuCompositorOptions): Promise<GpuStart> {
  await removeStaleProfiles();
  const binary = await findBrowser(options.chrome);
  if (!binary) return { compositor: null, reason: 'no Chrome or Chromium browser found (set PASCAP_CHROME)' };
  let script: string;
  try {
    script = await (options.script ?? gpuWorkerScript)();
  } catch (error) {
    return { compositor: null, reason: `the GPU worker page is unavailable: ${message(error)}` };
  }
  const reasons: string[] = [];
  let compositor: GpuCompositor | null = null;
  await forEachSerial(options.softwareRenderer ? (['swiftshader'] as const) : GPU_BACKENDS, async (backend) => {
    if (compositor) return;
    try {
      compositor = await GpuCompositor.launch(binary, backend, options, script);
    } catch (error) {
      if (options.signal.aborted) throw new ServiceError('Job cancelled.', 499);
      reasons.push(`${backend}: ${message(error)}`);
    }
  });
  return compositor ? { compositor, reason: null } : { compositor: null, reason: reasons.join('; ') };
}
