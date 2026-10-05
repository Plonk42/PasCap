import { gradePixel, NEUTRAL_COLOUR, type ColourSettings, type RGB } from '../shared/colour.js';
import { compositePixel } from '../shared/composition.js';
import type { PreviewLayer } from '../shared/timeline.js';
import { MAX_DECODER_SLOTS } from './assignment.js';
import { fragmentShader, vertexShader } from './shaders.js';

export interface CompositeLayer { settings: ColourSettings; weight: number; aspect: number }
export interface CompositeClip {
  slot: number; settings: ColourSettings; aspect: number;
  opacity: number; blendWeight: number; brightness: number;
}
export interface CompositeGroup { clips: readonly CompositeClip[]; opacity: number }

function compile(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error('Cannot allocate a WebGL shader.');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader);
    throw new Error(`Preview shader compilation failed: ${error}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader);
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentShader);
    program = gl.createProgram();
    if (!program) throw new Error('Cannot allocate the preview program.');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Preview shader link failed: ${gl.getProgramInfoLog(program)}`);
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

/** Owns GPU resources, but never media clocks or React state. */
export class Compositor {
  readonly gl: WebGL2RenderingContext;
  readonly renderer: string;
  readonly #program: WebGLProgram;
  readonly #vao: WebGLVertexArrayObject;
  readonly #textures: WebGLTexture[] = [];
  readonly #sizes: [number, number][] = [];
  readonly #uniforms = new Map<string, WebGLUniformLocation>();
  #disposed = false;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is unavailable. Enable browser GPU acceleration to test the preview.');
    this.gl = gl;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const program = createProgram(gl);
    const vao = gl.createVertexArray();
    if (!vao) { gl.deleteProgram(program); throw new Error('Cannot allocate the preview vertex array.'); }
    this.#program = program; this.#vao = vao;
    try {
      const names = ['source0', 'source1', 'tone0', 'tone1', 'extra0', 'extra1', 'coverage', 'brightness', 'groupOpacity', 'imageAspect', 'canvasAspect'];
      for (const name of names) {
        const location = gl.getUniformLocation(program, name);
        if (location === null) throw new Error(`Missing compositor uniform: ${name}`);
        this.#uniforms.set(name, location);
      }
      this.setDecoderCount(2);
      gl.useProgram(program); gl.bindVertexArray(vao);
      gl.uniform1i(this.#location('source0'), 0); gl.uniform1i(this.#location('source1'), 1);
      gl.disable(gl.DITHER);
      this.clear();
    } catch (error) {
      this.dispose(); throw error;
    }
  }
  get available(): boolean { return !this.#disposed && !this.gl.isContextLost(); }
  get gpuTextureMiB(): number {
    return this.available ? this.#sizes.reduce((sum, [width, height]) => sum + width * height * 4, 0) / 1024 ** 2 : 0;
  }
  /** One cached texture per reusable decoder, not per timeline clip. */
  setDecoderCount(count: number): void {
    if (this.#disposed || !Number.isInteger(count) || count < 0 || count > MAX_DECODER_SLOTS) throw new Error('Invalid compositor decoder count.');
    while (this.#textures.length > count) { this.gl.deleteTexture(this.#textures.pop()!); this.#sizes.pop(); }
    while (this.#textures.length < count) { this.#textures.push(this.#createTexture()); this.#sizes.push([1, 1]); }
  }
  #location(name: string): WebGLUniformLocation { return this.#uniforms.get(name)!; }
  #texture(slot: number): WebGLTexture {
    if (this.#disposed || !Number.isInteger(slot) || !this.#textures[slot]) throw new Error('Source is outside the compositor decoder pool.');
    return this.#textures[slot]!;
  }
  #createTexture(): WebGLTexture {
    const gl = this.gl; const texture = gl.createTexture();
    if (!texture) throw new Error('Cannot allocate preview texture.');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return texture;
  }
  uploadVideo(slot: number, video: HTMLVideoElement): void {
    if (this.#disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.seeking) throw new Error('A decoded frame is not available for upload.');
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#texture(slot));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this.#sizes[slot] = [video.videoWidth, video.videoHeight];
  }
  uploadPixels(slot: 0 | 1, pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#texture(slot));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.#sizes[slot] = [width, height];
  }
  /** Legacy two-source colour-test API; black is the backing surface. */
  draw(layers: readonly [CompositeLayer, CompositeLayer]): void {
    this.drawFrame([{ opacity: 1, clips: layers.map((layer, slot) => ({ slot, settings: layer.settings, aspect: layer.aspect, opacity: 1, blendWeight: layer.weight, brightness: 1 })) }]);
  }
  /** Groups are bottom-to-top; each track's dissolve is drawn exactly once. */
  drawFrame(groups: readonly CompositeGroup[]): void {
    if (this.#disposed || this.gl.isContextLost()) return;
    this.clear();
    const gl = this.gl; gl.useProgram(this.#program); gl.bindVertexArray(this.#vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try { for (const group of groups) this.#drawGroup(group); }
    finally { gl.disable(gl.BLEND); }
  }
  #drawGroup(group: CompositeGroup): void {
    if (group.clips.length < 1 || group.clips.length > 2) throw new Error('A composite group needs one or two sources.');
    const gl = this.gl;
    const empty: CompositeClip = { slot: group.clips[0]!.slot, settings: { ...NEUTRAL_COLOUR }, aspect: this.canvas.width / this.canvas.height, opacity: 0, blendWeight: 0, brightness: 0 };
    const sources = [group.clips[0]!, group.clips[1] ?? empty];
    for (const [index, source] of sources.entries()) {
      const settings = source.settings;
      gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, this.#texture(source.slot));
      gl.uniform4f(this.#location(`tone${index}`), settings.exposure, settings.brightness, settings.contrast, settings.saturation);
      gl.uniform3f(this.#location(`extra${index}`), settings.hue * Math.PI / 180, settings.highlights, settings.shadows);
    }
    gl.uniform2f(this.#location('coverage'), sources[0]!.opacity * sources[0]!.blendWeight, sources[1]!.opacity * sources[1]!.blendWeight);
    gl.uniform2f(this.#location('brightness'), sources[0]!.brightness, sources[1]!.brightness);
    gl.uniform1f(this.#location('groupOpacity'), group.opacity);
    gl.uniform2f(this.#location('imageAspect'), sources[0]!.aspect, sources[1]!.aspect);
    gl.uniform1f(this.#location('canvasAspect'), this.canvas.width / this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  clear(): void {
    if (this.#disposed || this.gl.isContextLost()) return;
    this.gl.clearColor(0, 0, 0, 1); this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }
  readPixels(): Uint8Array {
    if (this.#disposed || this.gl.isContextLost()) throw new Error('Cannot read an unavailable preview surface.');
    const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    this.gl.readPixels(0, 0, this.canvas.width, this.canvas.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const texture of this.#textures) this.gl.deleteTexture(texture);
    this.#textures.length = 0; this.#sizes.length = 0;
    this.gl.deleteVertexArray(this.#vao); this.gl.deleteProgram(this.#program);
  }
}

export interface GpuComparison { meanAbsoluteError8Bit: number; maxError8Bit: number; pixels: number; renderer: string }
export interface GpuCompositionComparison extends GpuComparison { cases: number }

/** Numeric GPU/CPU parity test, separate from browser video conversion and H.264 error. */
export function verifyGpuColour(settings: ColourSettings): GpuComparison {
  const canvas = document.createElement('canvas'); canvas.width = 17; canvas.height = 17;
  const compositor = new Compositor(canvas);
  try {
    const pixels = new Uint8Array(17 * 17 * 4);
    for (let index = 0; index < 17 * 17; index++) {
      pixels[index * 4] = (index * 73) % 256; pixels[index * 4 + 1] = (index * 157) % 256;
      pixels[index * 4 + 2] = (index * 29) % 256; pixels[index * 4 + 3] = 255;
    }
    compositor.uploadPixels(0, pixels, 17, 17);
    compositor.draw([{ settings, weight: 1, aspect: 1 }, { settings: { ...NEUTRAL_COLOUR }, weight: 0, aspect: 1 }]);
    const rendered = compositor.readPixels(); let sum = 0; let maximum = 0;
    for (let index = 0; index < 17 * 17; index++) {
      const input: RGB = [pixels[index * 4]! / 255, pixels[index * 4 + 1]! / 255, pixels[index * 4 + 2]! / 255];
      const expected = gradePixel(input, settings);
      for (let channel = 0; channel < 3; channel++) {
        const error = Math.abs(rendered[index * 4 + channel]! - expected[channel]! * 255);
        sum += error; maximum = Math.max(maximum, error);
      }
    }
    return { meanAbsoluteError8Bit: sum / (17 * 17 * 3), maxError8Bit: maximum, pixels: 289, renderer: compositor.renderer };
  } finally {
    compositor.dispose(); compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function comparisonColour(test: number, random: () => number): ColourSettings {
  if (test < 7) return { ...NEUTRAL_COLOUR };
  return {
    exposure: random() * 1.4 - 0.7, brightness: random() * 0.16 - 0.08,
    contrast: 0.7 + random() * 0.6, saturation: 0.4 + random() * 1.3,
    hue: random() * 220 - 110, highlights: random() * 0.6 - 0.3, shadows: random() * 0.6 - 0.3,
  };
}

function comparisonSource(test: number, group: number, source: number, progress: number, opacity: number, dissolve: boolean, random: () => number): { layer: PreviewLayer; clip: CompositeClip } {
  const slot = (group + source) % 2;
  const settings = comparisonColour(test, random);
  let blendWeight = 1; let brightness = random();
  if (dissolve) { blendWeight = source === 0 ? 1 - progress : progress; brightness = 1; }
  if (test === 3 && group === 1) brightness = 0;
  const clipOpacity = test === 1 || test === 3 ? 1 : random();
  return {
    layer: {
      clipId: `test-${group}-${source}`, mediaId: String(slot), layerId: `layer-${group}`, sourceFrame: 0,
      colour: settings, opacity: clipOpacity, blendWeight, brightness, weight: brightness * blendWeight, layerOpacity: opacity,
    },
    clip: { slot, settings, aspect: 1, opacity: clipOpacity, blendWeight, brightness },
  };
}

function comparisonGroup(test: number, group: number, random: () => number): { layers: PreviewLayer[]; group: CompositeGroup } {
  let opacity = random(); let progress = random();
  if (test === 1) opacity = 1;
  if (test === 2) opacity = 0;
  if (test === 4) progress = 0;
  if (test === 6) progress = 1;
  const dissolve = group === 0 && test % 2 === 0;
  const sources = Array.from({ length: dissolve ? 2 : 1 }, (_, source) => comparisonSource(test, group, source, progress, opacity, dissolve, random));
  return { layers: sources.map((source) => source.layer), group: { opacity, clips: sources.map((source) => source.clip) } };
}

function constantPixelError(rendered: Uint8Array, expected: RGB): { sum: number; maximum: number } {
  let sum = 0; let maximum = 0;
  for (let pixel = 0; pixel < rendered.length / 4; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(rendered[pixel * 4 + channel]! - expected[channel]! * 255);
      sum += error; maximum = Math.max(maximum, error);
    }
  }
  return { sum, maximum };
}

/** Synthetic numeric parity only: no footage, video conversion or performance claim. */
export function verifyLayerComposition(): GpuCompositionComparison {
  const canvas = document.createElement('canvas'); canvas.width = 9; canvas.height = 9;
  const compositor = new Compositor(canvas);
  let seed = 0x706173;
  const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const cases = 32;
  let sum = 0; let maximum = 0;
  try {
    for (let test = 0; test < cases; test++) {
      const colours: RGB[] = [];
      for (const slot of [0, 1] as const) {
        const bytes = new Uint8Array([Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256), 255]);
        compositor.uploadPixels(slot, bytes, 1, 1);
        colours.push([bytes[0]! / 255, bytes[1]! / 255, bytes[2]! / 255]);
      }
      let count = 1 + test % 8;
      if (test < 6) count = 2;
      if (test === 0) count = 0;
      const fixtures = Array.from({ length: count }, (_, group) => comparisonGroup(test, group, random));
      compositor.drawFrame(fixtures.map((fixture) => fixture.group));
      const expected = compositePixel(fixtures.flatMap((fixture) => fixture.layers), (layer) => colours[Number(layer.mediaId)]!);
      const error = constantPixelError(compositor.readPixels(), expected);
      sum += error.sum; maximum = Math.max(maximum, error.maximum);
    }
    const pixels = canvas.width * canvas.height * cases;
    return { meanAbsoluteError8Bit: sum / (pixels * 3), maxError8Bit: maximum, pixels, cases, renderer: compositor.renderer };
  } finally {
    compositor.dispose(); compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}