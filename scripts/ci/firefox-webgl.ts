import { firefox, type FullConfig } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fragmentShader, vertexShader } from '../../src/preview/shaders.js';

export interface FirefoxGraphicsReadiness {
  contextError: string;
  renderer: string | null;
  version: string | null;
  shaderError: string | null;
  pixel: number[];
  glError: number;
  contextLost: boolean;
}

const guidance =
  'Firefox WebGL2 prerequisite failed. On GPU-less Linux, install Xvfb/xauth and Mesa EGL/GLX/DRI, then run the Firefox configuration with xvfb-run and the documented llvmpipe environment. Do not force-enable WebGL, skip regressions or change playback bounds.';

export function requireFirefoxGraphics(result: FirefoxGraphicsReadiness): void {
  if (
    !result.renderer ||
    result.version !== 'WebGL 2.0' ||
    result.contextError ||
    result.shaderError ||
    result.contextLost ||
    result.glError !== 0 ||
    result.pixel.join(',') !== '64,128,191,255'
  ) {
    throw new Error(`${guidance}\n${JSON.stringify(result)}`);
  }
}

/** Diagnostic only: the bundled native probe cannot qualify/override WebGL. */
export function nativeFirefoxGraphics(
  executable: string,
): Promise<{ stdout: string; stderr: string; error: string | null }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ['glx'],
      {
        timeout: 5_000,
        maxBuffer: 32_768,
        killSignal: 'SIGKILL',
        env: { ...process.env, MOZ_GFX_DEBUG: '1' },
      },
      (error, stdout, stderr) => resolve({ stdout, stderr, error: error?.message ?? null }),
    );
  });
}

/** Real browser/context/shaders/readback, before any media test; no mocked renderer. */
export default async function firefoxWebGL(config: FullConfig): Promise<void> {
  const use = config.projects[0]!.use;
  const gfxtest = path.join(path.dirname(firefox.executablePath()), 'gfxtest');
  // Firefox allows its own startup GLX probe 4 s; load Mesa/LLVM from a cold runner disk first.
  const warmStarted = performance.now();
  const warmUp = await nativeFirefoxGraphics(gfxtest);
  const warmUpMs = Math.round(performance.now() - warmStarted);
  console.log(`Firefox native graphics warm-up: ${warmUpMs} ms`, warmUp.error ?? '');
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
      browser.newPage().then((page) =>
        page.evaluate(
          ({ vertex, fragment }): FirefoxGraphicsReadiness => {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            let contextError = '';
            canvas.addEventListener('webglcontextcreationerror', (event) => {
              contextError = (event as WebGLContextEvent).statusMessage;
            });
            const gl = canvas.getContext('webgl2', {
              alpha: false,
              antialias: false,
              depth: false,
              stencil: false,
              premultipliedAlpha: false,
            });
            if (!gl)
              return {
                contextError: contextError || 'getContext(webgl2) returned null.',
                renderer: null,
                version: null,
                shaderError: null,
                pixel: [],
                glError: 0,
                contextLost: false,
              };
            const info = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
            const version = String(gl.getParameter(gl.VERSION));
            const program = gl.createProgram();
            const vertexObject = gl.createShader(gl.VERTEX_SHADER);
            const fragmentObject = gl.createShader(gl.FRAGMENT_SHADER);
            let shaderError: string | null = null;
            const pixel = new Uint8Array(4);
            try {
              if (!program || !vertexObject || !fragmentObject)
                shaderError = 'Cannot allocate the actual compositor shaders/program.';
              else {
                for (const [shader, source] of [
                  [vertexObject, vertex],
                  [fragmentObject, fragment],
                ] as const) {
                  gl.shaderSource(shader, source);
                  gl.compileShader(shader);
                  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                    shaderError = gl.getShaderInfoLog(shader) || 'Compositor shader compilation failed.';
                  gl.attachShader(program, shader);
                }
                gl.linkProgram(program);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS))
                  shaderError = gl.getProgramInfoLog(program) || 'Compositor shader link failed.';
              }
              gl.disable(gl.DITHER);
              gl.clearColor(64 / 255, 128 / 255, 191 / 255, 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
              return {
                contextError,
                renderer,
                version,
                shaderError,
                pixel: Array.from(pixel),
                glError: gl.getError(),
                contextLost: gl.isContextLost(),
              };
            } finally {
              gl.deleteShader(vertexObject);
              gl.deleteShader(fragmentObject);
              gl.deleteProgram(program);
              gl.getExtension('WEBGL_lose_context')?.loseContext();
            }
          },
          { vertex: vertexShader, fragment: fragmentShader },
        ),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${guidance}\nGraphics probe exceeded its 10-second deadline.`)),
          10_000,
        );
      }),
    ]);
    try {
      requireFirefoxGraphics(result);
    } catch (cause) {
      // about:support is a privileged page unsupported by Juggler navigation.
      // Run the bundled native GLX/EGL probe in the SAME display/environment,
      // with strict time/output bounds. This is evidence, never a context retry.
      const native = await nativeFirefoxGraphics(gfxtest);
      const diagnostics = {
        browser: browser.version(),
        readiness: result,
        warmUp: { milliseconds: warmUpMs, error: warmUp.error },
        environment: Object.fromEntries(
          [
            'DISPLAY',
            'LIBGL_ALWAYS_SOFTWARE',
            'GALLIUM_DRIVER',
            '__GLX_VENDOR_LIBRARY_NAME',
            '__EGL_VENDOR_LIBRARY_FILENAMES',
          ].map((key) => [key, process.env[key] ?? null]),
        ),
        native,
      };
      const evidence = JSON.stringify(diagnostics, null, 2);
      console.error(`Firefox native graphics failure evidence: ${evidence}`);
      try {
        const directory = path.resolve(config.rootDir, '../../test-results');
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, 'firefox-graphics-prerequisite.json'), evidence);
      } catch (error) {
        console.error(
          `Cannot retain Firefox graphics evidence: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw cause;
    }
    console.log(`Firefox graphics ready: ${JSON.stringify({ browser: browser.version(), ...result })}`);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
