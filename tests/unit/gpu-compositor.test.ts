import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ServiceError } from '../../src/server/errors.js';
import {
  browserArguments,
  copyReversedRows,
  isSoftwareRenderer,
  startGpuCompositor,
  type GpuCompositorOptions,
  type GpuGroupSource,
} from '../../src/server/gpu-compositor.js';
import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';

// A disposable stand-in for the browser: it speaks the page protocol over the same loopback
// HTTP, with behaviour chosen per test. No real browser, GPU or media is involved.
const FAKE_BROWSER = `
const url = new URL(process.argv.at(-1));
const headers = { 'x-pascap-gpu-token': url.hash.slice(1) };
const call = (route, init = {}) => fetch(url.origin + route, { ...init, headers: { ...headers, ...init.headers } });
const mode = process.env.FAKE_GPU_MODE;
const forever = () => new Promise(() => setInterval(() => {}, 1000));
if (mode === 'silent') await forever();
const anonymous = await fetch(url.origin + '/config');
const config = await (await call('/config')).json();
const renderer = mode === 'software' ? 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))' : 'Fake GPU';
const hello = { protocol: 2, renderer, norm16: true, error: anonymous.status === 403 ? null : 'token not enforced' };
const reply = await (await call('/hello', { method: 'POST', body: JSON.stringify(hello) })).json();
if (!reply.accept) await forever();
for (;;) {
  const response = await call('/next');
  if (response.status === 410) break;
  if (response.status === 204) continue;
  const bytes = Buffer.from(await response.arrayBuffer());
  const length = bytes.readUInt32LE(0);
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8'));
  if (mode === 'crash') process.exit(3);
  if (mode === 'hang') await forever();
  if (mode === 'fail') {
    await call('/failure', { method: 'POST', body: JSON.stringify({ sequence: header.sequence, error: 'context lost' }) });
    continue;
  }
  // Readback order: row r counted from the bottom holds r; the first pixel reports what arrived.
  const out = new Uint16Array(config.width * config.height * 4);
  for (let row = 0; row < config.height; row++) out.fill(row, row * config.width * 4, (row + 1) * config.width * 4);
  out[0] = bytes[4 + length];
  out[1] = header.sources.length;
  out[2] = header.sources[0].width;
  out[3] = bytes.length - 4 - length;
  // Two row bands, the upper one first: offsets are bytes in readback order.
  const split = (config.height / 2) * config.width * 4;
  const band = (start, end, offset) =>
    call('/result', {
      method: 'POST',
      headers: { 'x-pascap-gpu-sequence': String(header.sequence), 'x-pascap-gpu-offset': String(offset * 2) },
      body: out.subarray(start, end),
    });
  await band(split, out.length, split);
  await band(0, split, mode === 'overlap' ? split : 0);
}
process.exit(0);
`;

const width = 8;
const height = 6;
let root: string;
let browser: string;
let profiles: string;
const previousTemp = process.env['TMPDIR'];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'pascap-gpu-unit-'));
  browser = path.join(root, 'fake-browser.mjs');
  await writeFile(browser, `#!${process.execPath}\n${FAKE_BROWSER}`);
  await chmod(browser, 0o755);
  profiles = path.join(root, 'profiles');
  await mkdir(profiles);
  process.env['TMPDIR'] = profiles; // Browser profiles are created here and must be removed.
});
afterEach(() => {
  delete process.env['FAKE_GPU_MODE'];
});
afterAll(async () => {
  if (previousTemp === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = previousTemp;
  await rm(root, { recursive: true, force: true });
});

function options(mode: string, overrides: Partial<GpuCompositorOptions> = {}): GpuCompositorOptions {
  process.env['FAKE_GPU_MODE'] = mode;
  return {
    width,
    height,
    signal: new AbortController().signal,
    chrome: browser,
    script: async () => '',
    startupTimeoutMs: 10_000,
    frameTimeoutMs: 10_000,
    ...overrides,
  };
}

function source(): GpuGroupSource {
  const rgb = new Uint8Array(width * height * 3);
  // Content rectangle x 2..5, y 1..4; its BOTTOM row (y 4) is sent first.
  rgb[(4 * width + 2) * 3] = 77;
  return {
    rgb,
    bounds: { x: 2, y: 1, width: 4, height: 4 },
    parameters: {
      colour: { ...NEUTRAL_COLOUR, hdr: 0.3 },
      spatial: { ...NEUTRAL_SPATIAL_POSE },
      detail: { sharpen: 0.3, clarity: 0, denoise: 0 },
      originalWidth: 16,
      originalHeight: 16,
      opacity: 1,
      blendWeight: 1,
      brightness: 1,
    },
  };
}

describe('GPU compositor worker protocol', () => {
  it('round-trips a frame: bottom-first content rows out, top-first RGBA16 rows back', async () => {
    const started = await startGpuCompositor(options('echo'));
    expect(started.reason).toBeNull();
    const gpu = started.compositor!;
    try {
      expect(gpu.renderer).toBe('Fake GPU');
      const output = Buffer.alloc(width * height * 8);
      await gpu.compose(output, [source()]);
      await gpu.compose(output, [source()]);
      const values = new Uint16Array(output.buffer, output.byteOffset, output.length / 2);
      const row = (index: number): number[] => Array.from(values.subarray(index * width * 4, (index + 1) * width * 4));
      expect(row(0).every((value) => value === height - 1)).toBe(true);
      // The readback's first pixel is the image's bottom-left corner.
      expect(row(height - 1).slice(0, 4)).toEqual([77, 1, 4, 4 * 4 * 3]);
      expect(gpu.frames).toBe(2);
    } finally {
      await gpu.close();
    }
    expect(await readdir(profiles)).toEqual([]);
  });

  it('rejects software renderers unless explicitly allowed for tests', async () => {
    const rejected = await startGpuCompositor(options('software'));
    expect(rejected.compositor).toBeNull();
    expect(rejected.reason).toMatch(/^vulkan: software renderer .*SwiftShader.*; gl: software renderer/);
    expect(await readdir(profiles)).toEqual([]);
    const allowed = await startGpuCompositor(options('software', { softwareRenderer: true }));
    expect(allowed.reason).toBeNull();
    await allowed.compositor!.close();
    expect(await readdir(profiles)).toEqual([]);
  });

  it('falls back when the browser is missing or the page never starts', async () => {
    const missing = await startGpuCompositor(options('echo', { chrome: path.join(root, 'no-such-browser') }));
    expect(missing.reason).toMatch(/cannot start/);
    const silent = await startGpuCompositor(options('silent', { startupTimeoutMs: 400 }));
    expect(silent.reason).toBe('vulkan: the page did not start in time; gl: the page did not start in time');
    expect(await readdir(profiles)).toEqual([]);
  });

  it('removes profiles left by a killed service, never a running one', async () => {
    const stale = path.join(profiles, 'pascap-gpu-2147483646-abcdef');
    const live = path.join(profiles, `pascap-gpu-${process.pid}-abcdef`);
    const unrelated = path.join(profiles, 'pascap-gpu-spike-abcdef');
    await Promise.all(
      [stale, live, unrelated].map((directory) => mkdir(path.join(directory, 'Default'), { recursive: true })),
    );
    const started = await startGpuCompositor(options('echo'));
    await started.compositor!.close();
    expect((await readdir(profiles)).sort()).toEqual(['pascap-gpu-spike-abcdef', path.basename(live)].sort());
    await Promise.all([live, unrelated].map((directory) => rm(directory, { recursive: true })));
  });

  it('fails a frame on page failure, browser exit or timeout, and stays failed', async () => {
    for (const [mode, error] of [
      ['fail', /the GPU page failed: context lost/],
      ['crash', /the browser exited \(3\)/],
      ['hang', /the GPU did not return its frame in time/],
      ['overlap', /unexpected GPU result band/],
    ] as const) {
      const { compositor } = await startGpuCompositor(options(mode, { frameTimeoutMs: 500 }));
      try {
        const output = Buffer.alloc(width * height * 8);
        await expect(compositor!.compose(output, [source()])).rejects.toThrow(error);
        await expect(compositor!.compose(output, [source()])).rejects.toThrow(error);
      } finally {
        await compositor!.close();
      }
    }
    expect(await readdir(profiles)).toEqual([]);
  });

  it('cancels a frame with the job and removes the browser profile', async () => {
    const controller = new AbortController();
    const { compositor } = await startGpuCompositor(options('hang', { signal: controller.signal }));
    const frame = compositor!.compose(Buffer.alloc(width * height * 8), [source()]);
    setTimeout(() => controller.abort(), 100);
    await expect(frame).rejects.toEqual(new ServiceError('Job cancelled.', 499));
    await compositor!.close();
    expect(await readdir(profiles)).toEqual([]);
  });

  it('validates frames before sending them', async () => {
    const { compositor } = await startGpuCompositor(options('echo'));
    try {
      const output = Buffer.alloc(width * height * 8);
      await expect(compositor!.compose(output.subarray(8), [source()])).rejects.toThrow(/accumulator/);
      const outside = { ...source(), bounds: { x: 6, y: 1, width: 4, height: 4 } };
      await expect(compositor!.compose(output, [outside])).rejects.toThrow(/content rectangle/);
    } finally {
      await compositor!.close();
    }
  });
});

describe('GPU compositor helpers', () => {
  it('recognises software renderers', () => {
    for (const renderer of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'ANGLE (Mesa, llvmpipe (LLVM 19.1.1, 256 bits), OpenGL 4.5)',
      'lavapipe',
      '',
    ])
      expect(isSoftwareRenderer(renderer), renderer).toBe(true);
    for (const renderer of [
      'ANGLE (Intel, Mesa Intel(R) UHD Graphics (TGL GT1), OpenGL ES 3.2)',
      'ANGLE (NVIDIA, Vulkan 1.4.341 (NVIDIA NVIDIA T1200 Laptop GPU (0x00001FBC)), NVIDIA)',
    ])
      expect(isSoftwareRenderer(renderer), renderer).toBe(false);
  });

  it('launches an isolated headless browser without a DevTools port', () => {
    const args = browserArguments('vulkan', '/tmp/profile', 'http://127.0.0.1:1/#token');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--use-angle=vulkan');
    expect(args).toContain('--ignore-gpu-blocklist');
    expect(args.some((arg) => arg.includes('remote-debugging'))).toBe(false);
    expect(args.at(-1)).toBe('http://127.0.0.1:1/#token');
    expect(browserArguments('swiftshader', '/p', 'u')).toContain('--enable-unsafe-swiftshader');
  });

  it('reverses readback rows across arbitrary chunk boundaries', () => {
    const rowBytes = 4;
    const readback = Buffer.from([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
    const output = Buffer.alloc(readback.length);
    for (const [start, end] of [
      [0, 3],
      [3, 9],
      [9, 12],
    ] as const)
      copyReversedRows(output, readback.subarray(start, end), start, rowBytes);
    expect(Array.from(output)).toEqual([20, 21, 22, 23, 10, 11, 12, 13, 0, 1, 2, 3]);
  });
});
