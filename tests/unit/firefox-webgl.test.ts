import { describe, expect, it, vi } from 'vitest';
import {
  nativeFirefoxGraphics,
  requireFirefoxGraphics,
  type FirefoxGraphicsReadiness,
} from '../../scripts/ci/firefox-webgl.js';

const nativeProbe = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void
  >(),
);
vi.mock('node:child_process', () => ({ execFile: nativeProbe }));

const ready: FirefoxGraphicsReadiness = {
  contextError: '',
  renderer: 'llvmpipe (LLVM)',
  version: 'WebGL 2.0',
  shaderError: null,
  pixel: [64, 128, 191, 255],
  glError: 0,
  contextLost: false,
};

describe('Firefox graphics prerequisite', () => {
  it('accepts successful real-context evidence', () => {
    expect(() => requireFirefoxGraphics(ready)).not.toThrow();
  });

  it.each([
    { contextError: 'AllowWebgl2:false restricts context creation on this system.', renderer: null, pixel: [] },
    { renderer: null },
    { version: 'WebGL 1.0' },
    { shaderError: 'Compositor shader compilation failed.' },
    { contextLost: true },
    { glError: 1282 },
    { pixel: [0, 0, 0, 255] },
  ])('fails explicitly on missing/broken graphics evidence: %j', (failure) => {
    const result = { ...ready, ...failure };
    expect(() => requireFirefoxGraphics(result)).toThrow('Firefox WebGL2 prerequisite failed.');
    expect(() => requireFirefoxGraphics(result)).toThrow('xvfb-run');
    expect(() => requireFirefoxGraphics(result)).toThrow(JSON.stringify(result));
  });
});

describe('Firefox native failure evidence', () => {
  it('runs only the real bundled GLX/EGL probe with bounded time/output and no capability overrides', async () => {
    nativeProbe.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(null, 'RENDERER\nllvmpipe\n', 'GLX_TEST: finished\n');
    });
    await expect(nativeFirefoxGraphics('/synthetic/firefox/gfxtest')).resolves.toEqual({
      stdout: 'RENDERER\nllvmpipe\n',
      stderr: 'GLX_TEST: finished\n',
      error: null,
    });
    expect(nativeProbe).toHaveBeenLastCalledWith(
      '/synthetic/firefox/gfxtest',
      ['glx'],
      {
        timeout: 5_000,
        maxBuffer: 32_768,
        killSignal: 'SIGKILL',
        env: { ...process.env, MOZ_GFX_DEBUG: '1' },
      },
      expect.any(Function),
    );
  });

  it.each(['Native probe exceeded its deadline.', 'spawn gfxtest ENOENT', 'stdout maxBuffer length exceeded'])(
    'retains probe errors without substituting successful readiness: %s',
    async (message) => {
      nativeProbe.mockImplementationOnce((_file, _args, _options, callback) => {
        callback(new Error(message), 'ERROR\nEGL failed\n', 'Native failure\n');
      });
      await expect(nativeFirefoxGraphics('/synthetic/firefox/gfxtest')).resolves.toEqual({
        stdout: 'ERROR\nEGL failed\n',
        stderr: 'Native failure\n',
        error: message,
      });
      expect(() => requireFirefoxGraphics({ ...ready, renderer: null, pixel: [] })).toThrow(
        'Firefox WebGL2 prerequisite failed.',
      );
    },
  );
});
