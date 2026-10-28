import { Compositor, type CompositeClip } from '../preview/compositor.js';
import { whileSerial } from '../shared/serial.js';
import {
  GPU_OFFSET_HEADER,
  GPU_PROTOCOL_VERSION,
  GPU_RESULT_BANDS,
  GPU_SEQUENCE_HEADER,
  GPU_TOKEN_HEADER,
  type GpuFailure,
  type GpuFrameHeader,
  type GpuHello,
  type GpuHelloReply,
  type GpuWorkerConfig,
} from '../shared/gpu-protocol.js';

// Export GPU compositor page, loaded only by the service's own headless browser. It drives its
// own loop over plain loopback HTTP: no DevTools session ever touches the frame data path.
const headers = { [GPU_TOKEN_HEADER]: location.hash.slice(1) };

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, cache: 'no-store', headers: { ...headers, ...init.headers } });
  if (!response.ok && response.status !== 204 && response.status !== 410)
    throw new Error(`${url} returned HTTP ${response.status}.`);
  return response;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown GPU compositor failure.';
}

async function fail(sequence: number | null, error: unknown): Promise<void> {
  const failure: GpuFailure = { sequence, error: message(error).slice(0, 4_000) };
  await request('/failure', { method: 'POST', body: JSON.stringify(failure) });
}

interface Target {
  framebuffer: WebGLFramebuffer;
  output: Uint16Array<ArrayBuffer>;
  floats: Float32Array<ArrayBuffer> | null;
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number, norm16: number | null): Target {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error('Cannot allocate the export render target.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, norm16 ?? gl.RGBA32F, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!complete) throw new Error('The 16-bit export render target is incomplete.');
  return {
    framebuffer,
    output: new Uint16Array(width * height * 4),
    floats: norm16 === null ? new Float32Array(width * height * 4) : null,
  };
}

/** Reads one row band (readback order) into the shared output, as normalized 16-bit RGBA. */
function readBand(gl: WebGL2RenderingContext, target: Target, width: number, start: number, rows: number): void {
  const offset = start * width * 4;
  if (target.floats) {
    const { floats, output } = target;
    gl.readPixels(0, start, width, rows, gl.RGBA, gl.FLOAT, floats, offset);
    for (let index = offset; index < offset + rows * width * 4; index++)
      output[index] = Math.round(Math.min(1, Math.max(0, floats[index]!)) * 65535);
  } else gl.readPixels(0, start, width, rows, gl.RGBA, gl.UNSIGNED_SHORT, target.output, offset);
  const error = gl.getError();
  if (error !== gl.NO_ERROR || gl.isContextLost()) throw new Error(`WebGL readback failed (error ${error}).`);
}

/** Each band is posted while the next one is read back, overlapping readback with transport. */
async function postGroup(compositor: Compositor, target: Target, sequence: number): Promise<void> {
  const gl = compositor.gl;
  const { width, height } = compositor.canvas;
  const rows = Math.ceil(height / GPU_RESULT_BANDS);
  const posts: Promise<Response>[] = [];
  try {
    for (let start = 0; start < height; start += rows) {
      const count = Math.min(rows, height - start);
      readBand(gl, target, width, start, count);
      const offset = start * width * 4;
      posts.push(
        request('/result', {
          method: 'POST',
          headers: { [GPU_SEQUENCE_HEADER]: String(sequence), [GPU_OFFSET_HEADER]: String(offset * 2) },
          body: target.output.subarray(offset, offset + count * width * 4),
        }),
      );
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    await Promise.allSettled(posts);
  }
  await Promise.all(posts);
}

function drawFrame(
  compositor: Compositor,
  target: Target,
  bytes: Uint8Array,
  header: GpuFrameHeader,
  at: number,
): void {
  let offset = at;
  const clips = header.sources.map((source, slot): CompositeClip => {
    const length = source.width * source.height * 3;
    compositor.uploadRgb(slot as 0 | 1, bytes.subarray(offset, offset + length), source.width, source.height);
    offset += length;
    return {
      slot,
      grade: source.grade,
      settings: source.colour,
      aspect: source.width / source.height,
      spatial: source.spatial,
      detail: source.detail,
      originalWidth: source.originalWidth,
      originalHeight: source.originalHeight,
      opacity: source.opacity,
      blendWeight: source.blendWeight,
      brightness: source.brightness,
    };
  });
  if (offset !== bytes.length) throw new Error('The frame bundle length differs from its sources.');
  compositor.drawExportGroup(target.framebuffer, { clips });
}

/** One frame: false once the service closes the loop; 204 is an idle poll. */
async function serveFrame(compositor: Compositor, target: Target): Promise<boolean> {
  const response = await request('/next');
  if (response.status === 410) return false;
  if (response.status === 204) return true;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as GpuFrameHeader;
  try {
    drawFrame(compositor, target, bytes, header, 4 + length);
    await postGroup(compositor, target, header.sequence);
  } catch (error) {
    await fail(header.sequence, error);
  }
  return true;
}

async function start(): Promise<void> {
  const config = (await (await request('/config')).json()) as GpuWorkerConfig;
  const canvas = document.createElement('canvas');
  canvas.width = config.width;
  canvas.height = config.height;
  let compositor: Compositor;
  try {
    compositor = new Compositor(canvas);
  } catch (error) {
    const hello: GpuHello = { protocol: GPU_PROTOCOL_VERSION, renderer: '', norm16: false, error: message(error) };
    await request('/hello', { method: 'POST', body: JSON.stringify(hello) });
    return;
  }
  const gl = compositor.gl;
  const norm16 = gl.getExtension('EXT_texture_norm16');
  const float = norm16 ? null : gl.getExtension('EXT_color_buffer_float');
  const hello: GpuHello = {
    protocol: GPU_PROTOCOL_VERSION,
    renderer: compositor.renderer,
    norm16: !!norm16,
    error: norm16 || float ? null : 'Neither a 16-bit normalized nor a float render target is available.',
  };
  const reply = (await (
    await request('/hello', { method: 'POST', body: JSON.stringify(hello) })
  ).json()) as GpuHelloReply;
  if (!reply.accept) return;
  // Compile every program and allocate the target before the first frame, never per frame.
  compositor.setDecoderCount(2);
  compositor.prepareDetail();
  const target = createTarget(gl, config.width, config.height, norm16 ? norm16.RGBA16_EXT : null);
  let open = true;
  await whileSerial(
    () => open,
    async () => {
      open = await serveFrame(compositor, target);
    },
  );
}

try {
  await start();
} catch (error) {
  await fail(null, error);
}
