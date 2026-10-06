import { firefox, type FullConfig } from '@playwright/test';
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

/** Real browser/context/shaders/readback, before any media test; no mocked renderer. */
export default async function firefoxWebGL(config: FullConfig): Promise<void> {
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
    requireFirefoxGraphics(result);
    console.log(`Firefox graphics ready: ${JSON.stringify({ browser: browser.version(), ...result })}`);
  } finally {
    clearTimeout(timer);
    await browser.close();
  }
}
