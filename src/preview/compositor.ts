import {
  colorCurveSlopes,
  CURVE_CHANNELS,
  HSL_BANDS,
  isIdentityCurve,
  isNeutralHsl,
} from '../shared/advanced-color.js';
import {
  type ColorSettings,
  createColorSettings,
  gradePixel,
  NEUTRAL_COLOR,
  type RGB,
  temperatureTintGains,
} from '../shared/color.js';
import { compositePixel } from '../shared/composition.js';
import {
  DETAIL_REFERENCE_LINES,
  denoiseRangeFactor,
  detailShift,
  isNeutralDetail,
  NEUTRAL_DETAIL,
  type DetailSettings,
  type LocalTone,
} from '../shared/detail.js';
import { isNeutralTone, sourceGrades } from '../shared/grade.js';
import { compileSpatialMapping, NEUTRAL_SPATIAL_POSE, type SpatialPose } from '../shared/spatial.js';
import { MAX_VIDEO_LAYERS } from '../shared/model.js';
import type { PreviewLayer } from '../shared/timeline.js';
import { fragmentShader, fragmentShaderFor, vertexShader, type FragmentVariant } from './shaders.js';

const DETAIL_UNIFORMS = [
  'detail0',
  'detail1',
  'detailStep0',
  'detailStep1',
  'localTone0',
  'localTone1',
  'localContrast',
];
/** Fragment uniform vectors of the two-source program grading each source twice with HSL ranges and curves. */
export const STAGED_UNIFORM_VECTORS = 330;
/** Two timeline video decoders per track: both dissolve sources, or the active and next clip. */
export const MAX_VIDEO_DECODERS = 2 * MAX_VIDEO_LAYERS;

type GradePath = 'full' | 'single' | 'scalar';
interface ProgramVariant {
  path: GradePath;
  detail: boolean;
  staged: boolean;
}
interface CompiledProgram {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
}
const variantKey = ({ path, detail, staged }: ProgramVariant): string => `${path}:${detail}:${staged}`;
const SHADER_SOURCES: Record<GradePath, Pick<FragmentVariant, 'single' | 'advanced'>> = {
  full: { single: false, advanced: true },
  single: { single: true, advanced: true },
  scalar: { single: false, advanced: false },
};
/** Uniforms of one grade stage; the clip grade before the track's uses the `first_` ones. */
const gradeUniforms = (p: string): string[] => [
  `${p}tone0`,
  `${p}tone1`,
  `${p}extra0`,
  `${p}extra1`,
  `${p}correction0`,
  `${p}correction1`,
  `${p}vibrance`,
  `${p}hsl0[0]`,
  `${p}hsl1[0]`,
  ...[0, 1].flatMap((source) => [0, 1, 2, 3].map((channel) => `${p}curve${source}_${channel}[0]`)),
  `${p}curveCounts0`,
  `${p}curveCounts1`,
  `${p}curveIdentity0`,
  `${p}curveIdentity1`,
  `${p}neutralHsl`,
];
const BASE_UNIFORMS = [
  'source0',
  'source1',
  ...gradeUniforms(''),
  'coverage',
  'brightness',
  'imageAspect',
  'canvasAspect',
  'spatialU0',
  'spatialV0',
  'spatialU1',
  'spatialV1',
  'crop0',
  'crop1',
  'neutralSpatial',
];
const STAGE_UNIFORMS = gradeUniforms('first_');

export interface CompositeClip {
  slot: number;
  /** The clip's own grade, applied before `settings`, the adjustment's Color; absent is neutral. */
  grade?: ColorSettings;
  settings: ColorSettings;
  aspect: number;
  spatial: SpatialPose;
  detail: DetailSettings;
  originalWidth: number;
  originalHeight: number;
  opacity: number;
  blendWeight: number;
  brightness: number;
}
export interface CompositeGroup {
  clips: readonly CompositeClip[];
}

function compile(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error('Cannot allocate a WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Preview shader compilation failed: ${error}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, source = fragmentShader): WebGLProgram {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader);
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, source);
    program = gl.createProgram();
    if (!program) throw new Error('Cannot allocate the preview program.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(`Preview shader link failed: ${gl.getProgramInfoLog(program)}`);
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

/** What one source's two grades need from a program, and what to upload as each stage. */
function sourceStages(source: CompositeClip): { stages: ColorSettings[]; tone: LocalTone } {
  const { stages, tone } = sourceGrades(source.grade ?? NEUTRAL_COLOR, source.settings);
  return { stages, tone };
}
const isAdvancedStage = (settings: ColorSettings): boolean =>
  !isNeutralHsl(settings.hsl) || CURVE_CHANNELS.some((channel) => !isIdentityCurve(settings.curves[channel]));

/** Owns GPU resources, but never media clocks or React state. */
export class Compositor {
  readonly gl: WebGL2RenderingContext;
  readonly renderer: string;
  /** The capacity a two-grade advanced program needs; checked before compiling one. */
  readonly fragmentUniformVectors: number;
  readonly #programs = new Map<string, CompiledProgram>();
  #current: CompiledProgram;
  #advanced = true;
  readonly #vao: WebGLVertexArrayObject;
  readonly #textures: WebGLTexture[] = [];
  readonly #sizes: [number, number][] = [];
  readonly #hslUniform = new Float32Array(32);
  readonly #curveUniform = new Float32Array(192);
  #disposed = false;
  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('WebGL2 is unavailable. Enable browser GPU acceleration to test the preview.');
    this.gl = gl;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = extension
      ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    this.fragmentUniformVectors = Number(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS));
    const program = createProgram(gl);
    const vao = gl.createVertexArray();
    if (!vao) {
      gl.deleteProgram(program);
      throw new Error('Cannot allocate the preview vertex array.');
    }
    this.#vao = vao;
    const uniforms = new Map<string, WebGLUniformLocation>();
    this.#current = { program, uniforms };
    this.#programs.set(variantKey({ path: 'full', detail: false, staged: false }), this.#current);
    try {
      for (const name of BASE_UNIFORMS) {
        const location = gl.getUniformLocation(program, name);
        if (location === null) throw new Error(`Missing compositor uniform: ${name}`);
        uniforms.set(name, location);
      }
      // Compile the three bounded paths before playback. First Compare activation
      // must never compile/link synchronously against an advancing audio clock.
      this.#use({ path: 'scalar', detail: false, staged: false });
      this.#use({ path: 'single', detail: false, staged: false });
      this.setDecoderCount(2);
      this.#use({ path: 'full', detail: false, staged: false });
      gl.bindVertexArray(vao);
      gl.disable(gl.DITHER);
      this.clear();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  get available(): boolean {
    return !this.#disposed && !this.gl.isContextLost();
  }
  get gpuTextureMiB(): number {
    return this.available ? this.#sizes.reduce((sum, [width, height]) => sum + width * height * 4, 0) / 1024 ** 2 : 0;
  }
  /** One cached texture per timeline video decoder, not per clip. */
  setDecoderCount(count: number): void {
    if (this.#disposed || !Number.isInteger(count) || count < 0 || count > MAX_VIDEO_DECODERS)
      throw new Error('Invalid compositor decoder count.');
    while (this.#textures.length > count) {
      this.gl.deleteTexture(this.#textures.pop()!);
      this.#sizes.pop();
    }
    while (this.#textures.length < count) {
      this.#textures.push(this.#createTexture());
      this.#sizes.push([1, 1]);
    }
  }
  #location(name: string): WebGLUniformLocation | null {
    return this.#current.uniforms.get(name) ?? null;
  }

  /** Compile the detail variants ahead of a draw that needs them, never against a running clock. */
  prepareDetail(): void {
    if (this.#disposed) return;
    for (const path of ['full', 'single', 'scalar'] as const) this.#compiled({ path, detail: true, staged: false });
  }
  /** Compile the variants grading a clip before its track, ahead of a draw that needs them. */
  prepareStaged(detail: boolean): void {
    if (this.#disposed) return;
    for (const path of ['full', 'single', 'scalar'] as const) {
      this.#compiled({ path, detail: false, staged: true });
      if (detail) this.#compiled({ path, detail: true, staged: true });
    }
  }
  #compiled(variant: ProgramVariant): CompiledProgram {
    const key = variantKey(variant);
    const existing = this.#programs.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const program = createProgram(gl, fragmentShaderFor({ ...SHADER_SOURCES[variant.path], ...variant }));
    const uniforms = new Map<string, WebGLUniformLocation>();
    const names = [
      ...BASE_UNIFORMS,
      ...(variant.detail ? DETAIL_UNIFORMS : []),
      ...(variant.staged ? STAGE_UNIFORMS : []),
    ];
    for (const name of names) {
      const location = gl.getUniformLocation(program, name);
      if (location !== null) uniforms.set(name, location);
    }
    const compiled = { program, uniforms };
    this.#programs.set(key, compiled);
    if (variant.path === 'full' && variant.detail && DETAIL_UNIFORMS.some((name) => !uniforms.has(name)))
      throw new Error('Missing compositor detail uniforms.');
    return compiled;
  }
  #use(variant: ProgramVariant): void {
    const gl = this.gl;
    this.#current = this.#compiled(variant);
    this.#advanced = variant.path !== 'scalar';
    gl.useProgram(this.#current.program);
    gl.uniform1i(this.#location('source0'), 0);
    gl.uniform1i(this.#location('source1'), 1);
  }
  #texture(slot: number): WebGLTexture {
    if (this.#disposed || !Number.isInteger(slot) || !this.#textures[slot])
      throw new Error('Source is outside the compositor decoder pool.');
    return this.#textures[slot]!;
  }
  #createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
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
  uploadFrame(slot: number, frame: VideoFrame): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture(slot));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    this.#sizes[slot] = [frame.displayWidth, frame.displayHeight];
  }
  uploadPixels(slot: 0 | 1, pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture(slot));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.#sizes[slot] = [width, height];
  }
  /** Tightly packed RGB8 rows, first row at the image bottom like uploadPixels. */
  uploadRgb(slot: 0 | 1, pixels: Uint8Array, width: number, height: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#texture(slot));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, width, height, 0, gl.RGB, gl.UNSIGNED_BYTE, pixels);
    } finally {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    }
    this.#sizes[slot] = [width, height];
  }
  /**
   * One premultiplied group over transparent black into an export render target the size
   * of the canvas, without blending. Leaves that framebuffer bound for readback.
   */
  drawExportGroup(framebuffer: WebGLFramebuffer, group: CompositeGroup): void {
    if (this.#disposed || this.gl.isContextLost()) throw new Error('The compositor is unavailable.');
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.#vao);
    this.#drawGroup(group);
  }
  /** Groups are bottom-to-top; each track's dissolve is drawn exactly once. */
  drawFrame(groups: readonly CompositeGroup[]): void {
    if (this.#disposed || this.gl.isContextLost()) return;
    this.clear();
    const gl = this.gl;
    gl.useProgram(this.#current.program);
    gl.bindVertexArray(this.#vao);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    try {
      for (const group of groups) this.#drawGroup(group);
    } finally {
      gl.disable(gl.BLEND);
    }
  }
  /** One stage's grade uniforms, `p` '' for the last (track) grade and 'first_' for the clip grade before it. */
  #uploadStage(p: string, index: number, settings: ColorSettings): void {
    const gl = this.gl;
    const gains = temperatureTintGains(settings);
    gl.uniform4f(this.#location(`${p}correction${index}`), gains[0], gains[1], gains[2], settings.blacks);
    gl.uniform4f(
      this.#location(`${p}tone${index}`),
      settings.exposure,
      settings.brightness,
      settings.contrast,
      settings.saturation,
    );
    gl.uniform2f(this.#location(`${p}extra${index}`), (settings.hue * Math.PI) / 180, settings.whites);
    if (!this.#advanced) return;
    HSL_BANDS.forEach((band, at) => {
      const value = settings.hsl[band];
      this.#hslUniform.set([value.hue, value.saturation, value.lightness, 0], at * 4);
    });
    gl.uniform4fv(this.#location(`${p}hsl${index}[0]`), this.#hslUniform);
    this.#curveUniform.fill(0);
    CURVE_CHANNELS.forEach((channel, at) => {
      const points = settings.curves[channel];
      const slopes = colorCurveSlopes(points);
      points.forEach((point, position) => {
        this.#curveUniform.set([point.x, point.y, slopes[position]!], at * 48 + position * 3);
      });
    });
    for (let channel = 0; channel < 4; channel++)
      gl.uniform3fv(
        this.#location(`${p}curve${index}_${channel}[0]`),
        this.#curveUniform.subarray(channel * 48, (channel + 1) * 48),
      );
    gl.uniform4iv(
      this.#location(`${p}curveCounts${index}`),
      CURVE_CHANNELS.map((channel) => settings.curves[channel].length),
    );
    gl.uniform4iv(
      this.#location(`${p}curveIdentity${index}`),
      CURVE_CHANNELS.map((channel) => Number(isIdentityCurve(settings.curves[channel]))),
    );
  }
  /** Detail settings and the source's summed local tone, for the detail program variants. */
  #uploadDetail(index: number, source: CompositeClip, tone: LocalTone): void {
    const gl = this.gl;
    const { sharpen, clarity, denoise } = source.detail;
    gl.uniform4f(this.#location(`detail${index}`), sharpen, clarity, denoise, denoiseRangeFactor(denoise));
    // Texture UV spans the image: one step is 1/720 of its height, in the original aspect.
    const stepV = 1 / DETAIL_REFERENCE_LINES;
    const aspect = source.originalWidth / source.originalHeight;
    const stepU = stepV / aspect;
    const lines = this.#sizes[source.slot]![1];
    const shiftV = (isNeutralDetail(source.detail) ? 0 : detailShift(lines)) / lines;
    // Texture rows run bottom-up: a shift down the image is negative in texture V.
    gl.uniform4f(this.#location(`detailStep${index}`), stepU, stepV, shiftV / aspect, -shiftV);
    gl.uniform4f(this.#location(`localTone${index}`), tone.shadows, tone.highlights, tone.hdr, tone.exposure);
  }
  #uploadNeutralHsl(prefix: '' | 'first_', grades: readonly ColorSettings[]): void {
    this.gl.uniform2f(
      this.#location(`${prefix}neutralHsl`),
      Number(isNeutralHsl(grades[0]!.hsl)),
      Number(isNeutralHsl(grades[1]!.hsl)),
    );
  }
  #drawGroup(group: CompositeGroup): void {
    if (group.clips.length < 1 || group.clips.length > 2)
      throw new Error('A composite group needs one or two sources.');
    const gl = this.gl;
    const empty: CompositeClip = {
      slot: group.clips[0]!.slot,
      settings: { ...NEUTRAL_COLOR },
      aspect: this.canvas.width / this.canvas.height,
      spatial: { ...NEUTRAL_SPATIAL_POSE },
      detail: { ...NEUTRAL_DETAIL },
      originalWidth: this.canvas.width,
      originalHeight: this.canvas.height,
      opacity: 0,
      blendWeight: 0,
      brightness: 0,
    };
    const sources = [group.clips[0]!, group.clips[1] ?? empty];
    const graded = sources.map(sourceStages);
    // One stage uploads as the program's only grade; two put the clip grade first.
    const last = graded.map(({ stages }) => stages.at(-1) ?? NEUTRAL_COLOR);
    const first = graded.map(({ stages }) => (stages.length > 1 ? stages[0]! : NEUTRAL_COLOR));
    const staged = graded.some(({ stages }) => stages.length > 1);
    const advanced = [...last, ...first].some(isAdvancedStage);
    const advancedPath = group.clips.length === 1 ? 'single' : 'full';
    const detailed = sources.some(
      (source, index) => !isNeutralDetail(source.detail) || !isNeutralTone(graded[index]!.tone),
    );
    if (staged && advanced && this.fragmentUniformVectors < STAGED_UNIFORM_VECTORS)
      throw new Error(
        `This GPU supports ${this.fragmentUniformVectors} fragment uniform vectors; grading a clip and an adjustment with HSL ranges or curves needs ${STAGED_UNIFORM_VECTORS}.`,
      );
    this.#use({ path: advanced ? advancedPath : 'scalar', detail: detailed, staged });
    const mappings = sources.map((source) =>
      compileSpatialMapping(
        source.spatial,
        source.originalWidth,
        source.originalHeight,
        this.canvas.width,
        this.canvas.height,
      ),
    );
    for (const [index, source] of sources.entries()) {
      this.#uploadStage('', index, last[index]!);
      if (staged) this.#uploadStage('first_', index, first[index]!);
      const mapping = mappings[index]!;
      const [a, b, c, d, e, f] = mapping.affine;
      gl.uniform3f(this.#location(`spatialU${index}`), a, b, c);
      gl.uniform3f(this.#location(`spatialV${index}`), d, e, f);
      gl.uniform4f(
        this.#location(`crop${index}`),
        mapping.cropLeft,
        mapping.cropRight,
        mapping.cropTop,
        mapping.cropBottom,
      );
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, this.#texture(source.slot));
      if (detailed) this.#uploadDetail(index, source, graded[index]!.tone);
    }
    if (detailed)
      gl.uniform2f(this.#location('localContrast'), graded[0]!.tone.localContrast, graded[1]!.tone.localContrast);
    gl.uniform2f(
      this.#location('coverage'),
      sources[0]!.opacity * sources[0]!.blendWeight,
      sources[1]!.opacity * sources[1]!.blendWeight,
    );
    gl.uniform2f(this.#location('brightness'), sources[0]!.brightness, sources[1]!.brightness);
    gl.uniform2f(this.#location('vibrance'), last[0]!.vibrance, last[1]!.vibrance);
    if (staged) gl.uniform2f(this.#location('first_vibrance'), first[0]!.vibrance, first[1]!.vibrance);
    if (this.#advanced) {
      this.#uploadNeutralHsl('', last);
      if (staged) this.#uploadNeutralHsl('first_', first);
    }
    gl.uniform2f(this.#location('neutralSpatial'), Number(mappings[0]!.neutral), Number(mappings[1]!.neutral));
    gl.uniform2f(this.#location('imageAspect'), sources[0]!.aspect, sources[1]!.aspect);
    gl.uniform1f(this.#location('canvasAspect'), this.canvas.width / this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  clear(): void {
    if (this.#disposed || this.gl.isContextLost()) return;
    this.gl.clearColor(0, 0, 0, 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
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
    this.#textures.length = 0;
    this.#sizes.length = 0;
    this.gl.deleteVertexArray(this.#vao);
    for (const { program } of this.#programs.values()) this.gl.deleteProgram(program);
  }
}

export interface GpuComparison {
  meanAbsoluteError8Bit: number;
  maxError8Bit: number;
  pixels: number;
  renderer: string;
}
export interface GpuCompositionComparison extends GpuComparison {
  cases: number;
}

/** Numeric GPU/CPU parity test, separate from browser video conversion and H.264 error; `grade` is a clip grade before `settings`. */
export function verifyGpuColor(settings: ColorSettings, grade: ColorSettings = NEUTRAL_COLOR): GpuComparison {
  const canvas = document.createElement('canvas');
  canvas.width = 17;
  canvas.height = 17;
  const compositor = new Compositor(canvas);
  try {
    const pixels = new Uint8Array(17 * 17 * 4);
    for (let index = 0; index < 17 * 17; index++) {
      pixels[index * 4] = (index * 73) % 256;
      pixels[index * 4 + 1] = (index * 157) % 256;
      pixels[index * 4 + 2] = (index * 29) % 256;
      pixels[index * 4 + 3] = 255;
    }
    compositor.uploadPixels(0, pixels, 17, 17);
    compositor.drawFrame([
      {
        clips: [
          {
            slot: 0,
            grade,
            settings,
            aspect: 1,
            spatial: { ...NEUTRAL_SPATIAL_POSE },
            detail: { ...NEUTRAL_DETAIL },
            originalWidth: 17,
            originalHeight: 17,
            opacity: 1,
            blendWeight: 1,
            brightness: 1,
          },
        ],
      },
    ]);
    const rendered = compositor.readPixels();
    let sum = 0;
    let maximum = 0;
    for (let index = 0; index < 17 * 17; index++) {
      const input: RGB = [pixels[index * 4]! / 255, pixels[index * 4 + 1]! / 255, pixels[index * 4 + 2]! / 255];
      const expected = gradePixel(gradePixel(input, grade), settings);
      for (let channel = 0; channel < 3; channel++) {
        const error = Math.abs(rendered[index * 4 + channel]! - expected[channel]! * 255);
        sum += error;
        maximum = Math.max(maximum, error);
      }
    }
    return {
      meanAbsoluteError8Bit: sum / (17 * 17 * 3),
      maxError8Bit: maximum,
      pixels: 289,
      renderer: compositor.renderer,
    };
  } finally {
    compositor.dispose();
    compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function comparisonColor(test: number, random: () => number): ColorSettings {
  if (test < 7) return { ...NEUTRAL_COLOR };
  return {
    ...NEUTRAL_COLOR,
    exposure: random() * 1.4 - 0.7,
    brightness: random() * 0.16 - 0.08,
    contrast: 0.7 + random() * 0.6,
    saturation: 0.4 + random() * 1.3,
    vibrance: random() * 0.8 - 0.4,
    hue: random() * 220 - 110,
    whites: random() * 0.6 - 0.3,
    blacks: random() * 0.6 - 0.3,
  };
}

function comparisonSource(
  test: number,
  group: number,
  source: number,
  progress: number,
  opacity: number,
  settings: ColorSettings,
  random: () => number,
): { layer: PreviewLayer; clip: CompositeClip } {
  const slot = (group + source) % 2;
  const dissolve = group === 0 && test % 2 === 0;
  let blendWeight = 1;
  let brightness = random();
  if (dissolve) {
    blendWeight = source === 0 ? 1 - progress : progress;
    brightness = 1;
  }
  if (test === 3 && group === 1) brightness = 0;
  return {
    layer: {
      clipId: `test-${group}-${source}`,
      mediaId: String(slot),
      layerId: `layer-${group}`,
      sourceFrame: 0,
      sourcePosition: 0,
      spatial: { ...NEUTRAL_SPATIAL_POSE },
      detail: { ...NEUTRAL_DETAIL },
      grade: createColorSettings(),
      color: settings,
      opacity,
      blendWeight,
      brightness,
      weight: brightness * blendWeight,
    },
    clip: {
      slot,
      settings,
      aspect: 1,
      spatial: { ...NEUTRAL_SPATIAL_POSE },
      detail: { ...NEUTRAL_DETAIL },
      originalWidth: 1,
      originalHeight: 1,
      opacity,
      blendWeight,
      brightness,
    },
  };
}

function comparisonGroup(
  test: number,
  group: number,
  random: () => number,
): { layers: PreviewLayer[]; group: CompositeGroup } {
  let opacity = random();
  let progress = random();
  if (test === 1 || test === 3) opacity = 1;
  if (test === 2) opacity = 0;
  if (test === 4) progress = 0;
  if (test === 6) progress = 1;
  const dissolve = group === 0 && test % 2 === 0;
  const settings = comparisonColor(test, random);
  const sources = Array.from({ length: dissolve ? 2 : 1 }, (_, source) =>
    comparisonSource(test, group, source, progress, opacity, settings, random),
  );
  return {
    layers: sources.map((source) => source.layer),
    group: { clips: sources.map((source) => source.clip) },
  };
}

function constantPixelError(rendered: Uint8Array, expected: RGB): { sum: number; maximum: number } {
  let sum = 0;
  let maximum = 0;
  for (let pixel = 0; pixel < rendered.length / 4; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const error = Math.abs(rendered[pixel * 4 + channel]! - expected[channel]! * 255);
      sum += error;
      maximum = Math.max(maximum, error);
    }
  }
  return { sum, maximum };
}

/** Synthetic numeric parity only: no footage, video conversion or performance claim. */
export function verifyLayerComposition(): GpuCompositionComparison {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 9;
  const compositor = new Compositor(canvas);
  let seed = 0x706173;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const cases = 32;
  let sum = 0;
  let maximum = 0;
  try {
    for (let test = 0; test < cases; test++) {
      const colors: RGB[] = [];
      for (const slot of [0, 1] as const) {
        const bytes = new Uint8Array([
          Math.floor(random() * 256),
          Math.floor(random() * 256),
          Math.floor(random() * 256),
          255,
        ]);
        compositor.uploadPixels(slot, bytes, 1, 1);
        colors.push([bytes[0]! / 255, bytes[1]! / 255, bytes[2]! / 255]);
      }
      let count = 1 + (test % 8);
      if (test < 6) count = 2;
      if (test === 0) count = 0;
      const fixtures = Array.from({ length: count }, (_, group) => comparisonGroup(test, group, random));
      compositor.drawFrame(fixtures.map((fixture) => fixture.group));
      const expected = compositePixel(
        fixtures.flatMap((fixture) => fixture.layers),
        (layer) => colors[Number(layer.mediaId)]!,
      );
      const error = constantPixelError(compositor.readPixels(), expected);
      sum += error.sum;
      maximum = Math.max(maximum, error.maximum);
    }
    const pixels = canvas.width * canvas.height * cases;
    return {
      meanAbsoluteError8Bit: sum / (pixels * 3),
      maxError8Bit: maximum,
      pixels,
      cases,
      renderer: compositor.renderer,
    };
  } finally {
    compositor.dispose();
    compositor.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
