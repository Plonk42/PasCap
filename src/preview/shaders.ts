import {
  CLARITY_GAIN,
  DETAIL_CLARITY_TAPS,
  DETAIL_FINE_TAPS,
  DETAIL_WIDE_TAPS,
  HDR_COMPRESSION,
  HDR_DETAIL_GAIN,
  TONE_BASE_GUIDE_TAPS,
  TONE_BASE_RANGE_FACTOR,
  HDR_RATIO_FLOOR,
  TONE_BASE_TAPS,
  LOCAL_TONE_FLOOR,
  LOCAL_TONE_RANGE,
  LOCAL_TONE_SLOPE,
  MID_GREY_STOPS,
  SHARPEN_GAIN,
} from '../shared/detail.js';
import { BLACKS_RANGE, WHITES_RANGE } from '../shared/colour.js';

export const vertexShader = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

// Constant channel/source array selection avoids dynamic indexing across all
// 64 points in software drivers. Generate once, never per frame or project.
const curveUniforms = [0, 1]
  .flatMap((source) => [0, 1, 2, 3].map((channel) => `uniform vec3 curve${source}_${channel}[16];`))
  .join('\n');
const curveFunctions = [0, 1]
  .flatMap((source) =>
    [0, 1, 2, 3].map(
      (channel) => `
float curve${source}_${channel}Value(float value) {
  if (curveIdentity${source}[${channel}] != 0) return value;
  int high = curveCounts${source}[${channel}] - 1;
  if (value <= 0.0) return curve${source}_${channel}[0].y;
  if (value >= 1.0) return curve${source}_${channel}[high].y;
  int low = 0;
  for (int i = 0; i < 4; i++) {
    if (high - low <= 1) break;
    int middle = (low + high) / 2;
    if (value <= curve${source}_${channel}[middle].x) high = middle;
    else low = middle;
  }
  vec3 left = curve${source}_${channel}[low];
  vec3 right = curve${source}_${channel}[high];
  // Cubic Hermite with shared monotone (x, y, slope) nodes; matches compileColourCurve.
  float width = right.x - left.x;
  float t = (value - left.x) / width;
  float t2 = t * t;
  float t3 = t2 * t;
  return clamp((2.0 * t3 - 3.0 * t2 + 1.0) * left.y + (t3 - 2.0 * t2 + t) * width * left.z +
               (3.0 * t2 - 2.0 * t3) * right.y + (t3 - t2) * width * right.z, 0.0, 1.0);
}`,
    ),
  )
  .join('\n');

const glslFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));
const glslVec2Array = (name: string, taps: readonly { x: number; y: number }[]): string =>
  `const vec2 ${name}[${taps.length}] = vec2[${taps.length}](${taps
    .map(({ x, y }) => `vec2(${glslFloat(x)}, ${glslFloat(y)})`)
    .join(', ')});`;
const glslFloatArray = (name: string, values: readonly number[]): string =>
  `const float ${name}[${values.length}] = float[${values.length}](${values.map(glslFloat).join(', ')});`;
const fineTotal = 1 + DETAIL_FINE_TAPS.reduce((sum, tap) => sum + tap.weight, 0);

// The same taps, weights and order as compileDetail() in src/shared/detail.ts.
const detailFunction = `
${glslVec2Array('detailFine', DETAIL_FINE_TAPS)}
${glslFloatArray(
  'detailFineWeight',
  DETAIL_FINE_TAPS.map((tap) => tap.weight),
)}
${glslVec2Array('detailWide', DETAIL_WIDE_TAPS)}
${glslFloatArray(
  'detailWideWeight',
  DETAIL_WIDE_TAPS.map((tap) => tap.weight),
)}
${glslVec2Array('detailClarity', DETAIL_CLARITY_TAPS)}
${glslVec2Array('toneBaseTaps', TONE_BASE_TAPS)}
${glslFloatArray(
  'toneBaseWeight',
  TONE_BASE_TAPS.map((tap) => tap.weight),
)}
float toneBase(sampler2D source, vec2 coordinate, float y, vec2 stride) {
  float levels[${TONE_BASE_TAPS.length}];
  float guide = y;
  for (int i = 0; i < ${TONE_BASE_TAPS.length}; i++) {
    levels[i] = dot(texture(source, coordinate + toneBaseTaps[i] * stride).rgb, luma);
    if (i < ${TONE_BASE_GUIDE_TAPS}) guide += levels[i];
  }
  guide /= ${glslFloat(TONE_BASE_GUIDE_TAPS + 1)};
  float total = exp(-(y - guide) * (y - guide) * ${glslFloat(TONE_BASE_RANGE_FACTOR)});
  float sum = total * y;
  for (int i = 0; i < ${TONE_BASE_TAPS.length}; i++) {
    float weight = toneBaseWeight[i] * exp(-(levels[i] - guide) * (levels[i] - guide) * ${glslFloat(TONE_BASE_RANGE_FACTOR)});
    sum += weight * levels[i];
    total += weight;
  }
  return sum / total;
}
vec3 hdrTone(vec3 rgb, float y, float base, float amount, float contrast) {
  float target = base + ${glslFloat(HDR_COMPRESSION)} * amount * base * (1.0 - base) * (1.0 - 2.0 * base) +
                 (y - base) * (1.0 + ${glslFloat(HDR_DETAIL_GAIN)} * amount + contrast);
  float lift = target - y;
  if (y <= 0.0) return rgb + lift;
  float blend = min(1.0, y / ${glslFloat(HDR_RATIO_FLOOR)});
  return rgb + lift + blend * (rgb * (target / y) - rgb - lift);
}
// localTone: (shadows, highlights, hdr, exposure).
float softRamp(float x) {
  float knee = clamp(x, 0.0, 1.0);
  return knee * knee * knee - 0.5 * knee * knee * knee * knee + max(0.0, x - 1.0);
}
float toneDistance(float stops) {
  return softRamp(stops) - softRamp(stops - ${glslFloat(LOCAL_TONE_RANGE)});
}
float localToneStops(float base, vec4 localTone) {
  float stops = log2(max(${glslFloat(LOCAL_TONE_FLOOR)}, decode709(clamp(base, 0.0, 1.0)) * exp2(localTone.w)));
  return ${glslFloat(LOCAL_TONE_SLOPE)} * (localTone.x * toneDistance(${glslFloat(MID_GREY_STOPS)} - stops) +
                                           localTone.y * toneDistance(stops - ${glslFloat(MID_GREY_STOPS)}));
}
vec3 detailFilter(sampler2D source, vec2 coordinate, vec3 centre, vec4 detail, vec2 stride, vec4 localTone,
                  float contrast) {
  vec3 denoised = centre;
  vec3 gaussian = centre;
  if (detail.x > 0.0 || detail.z > 0.0) {
    float denoisedWeight = 1.0;
    for (int i = 0; i < ${DETAIL_FINE_TAPS.length}; i++) {
      vec3 tap = texture(source, coordinate + detailFine[i] * stride).rgb;
      gaussian += detailFineWeight[i] * tap;
      if (detail.z > 0.0) {
        vec3 difference = tap - centre;
        float weight = detailFineWeight[i] * exp(-dot(difference, difference) * detail.w);
        denoised += weight * tap;
        denoisedWeight += weight;
      }
    }
    if (detail.z > 0.0) {
      for (int i = 0; i < ${DETAIL_WIDE_TAPS.length}; i++) {
        vec3 tap = texture(source, coordinate + detailWide[i] * stride).rgb;
        vec3 difference = tap - centre;
        float weight = detailWideWeight[i] * exp(-dot(difference, difference) * detail.w);
        denoised += weight * tap;
        denoisedWeight += weight;
      }
    }
    gaussian /= ${glslFloat(fineTotal)};
    denoised /= denoisedWeight;
  }
  float base = dot(denoised, luma);
  float delta = 0.0;
  if (detail.y != 0.0) {
    float mean = dot(centre, luma);
    for (int i = 0; i < ${DETAIL_CLARITY_TAPS.length}; i++)
      mean += dot(texture(source, coordinate + detailClarity[i] * stride).rgb, luma);
    mean /= ${glslFloat(DETAIL_CLARITY_TAPS.length + 1)};
    delta += ${glslFloat(CLARITY_GAIN)} * detail.y * clamp(4.0 * base * (1.0 - base), 0.0, 1.0) * (base - mean);
  }
  if (detail.x > 0.0) delta += ${glslFloat(SHARPEN_GAIN)} * detail.x * (base - dot(gaussian, luma));
  if (any(notEqual(localTone.xyz, vec3(0.0))) || contrast != 0.0) {
    float smoothBase = toneBase(source, coordinate, base, stride);
    if (localTone.z > 0.0 || contrast != 0.0)
      denoised = hdrTone(denoised, base, smoothBase, localTone.z, contrast);
    if (localTone.x != 0.0 || localTone.y != 0.0) {
      float gain = exp2(localToneStops(smoothBase, localTone));
      denoised = vec3(encode709(decode709(denoised.r) * gain), encode709(decode709(denoised.g) * gain),
                      encode709(decode709(denoised.b) * gain));
    }
  }
  return clamp(denoised + delta, 0.0, 1.0);
}`;
// (sharpen, clarity, denoise, denoise range factor), the 1/720-image-height step in texture UV
// and the evaluated track Colour (shadows, highlights, hdr, exposure) and Local contrast per source.
const detailUniforms = `uniform vec4 detail0;
uniform vec4 detail1;
uniform vec2 detailStep0;
uniform vec2 detailStep1;
uniform vec4 localTone0;
uniform vec4 localTone1;
uniform vec2 localContrast;`;
const detailSample = `vec3 centre = texture(source, coordinate).rgb;
  vec4 detail = sourceIndex == 0 ? detail0 : detail1;
  vec4 localTone = sourceIndex == 0 ? localTone0 : localTone1;
  float contrast = sourceIndex == 0 ? localContrast.x : localContrast.y;
  if (all(equal(detail.xyz, vec3(0.0))) && all(equal(localTone.xyz, vec3(0.0))) && contrast == 0.0) return centre;
  vec2 stride = sourceIndex == 0 ? detailStep0 : detailStep1;
  return detailFilter(source, coordinate, centre, detail, stride, localTone, contrast);`;

const singleMain = `void main() {
  vec4 left = vec4(0.0);
  if (coverage.x > 0.0) left = sampleSpatial(source0, tone0, extra0, imageAspect.x,
                            spatialU0, spatialV0, crop0, neutralSpatial.x, 0);
  outputColour = vec4(left.rgb * left.a * coverage.x * brightness.x, left.a * coverage.x);
}`;
const groupMain = `void main() {
  vec4 left = vec4(0.0);
  vec4 right = vec4(0.0);
  if (coverage.x > 0.0) left = sampleSpatial(source0, tone0, extra0, imageAspect.x,
                            spatialU0, spatialV0, crop0, neutralSpatial.x, 0);
  if (coverage.y > 0.0) right = sampleSpatial(source1, tone1, extra1, imageAspect.y,
                             spatialU1, spatialV1, crop1, neutralSpatial.y, 1);
  // A dissolve is ONE premultiplied group, not two source-over draws.
  // Black fades dim graded RGB without reducing the group's coverage.
  vec3 premultiplied = left.rgb * left.a * coverage.x * brightness.x +
                       right.rgb * right.a * coverage.y * brightness.y;
  outputColour = vec4(premultiplied, left.a * coverage.x + right.a * coverage.y);
}`;

// Deliberately implements docs/COLOUR_AND_TIMING.md, not an approximation of eq/hue.
const createFragmentShader = (single: boolean, detail: boolean): string => `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 uv;
out vec4 outputColour;
uniform sampler2D source0;
uniform sampler2D source1;
uniform vec4 tone0;
uniform vec4 tone1;
uniform vec2 extra0;
uniform vec2 extra1;
uniform vec4 correction0;
uniform vec4 correction1;
uniform vec2 vibrance;
uniform vec2 coverage;
uniform vec2 brightness;
uniform vec2 imageAspect;
uniform float canvasAspect;
uniform vec3 spatialU0;
uniform vec3 spatialV0;
uniform vec3 spatialU1;
uniform vec3 spatialV1;
uniform vec4 crop0;
uniform vec4 crop1;
uniform vec2 neutralSpatial;
uniform vec4 hsl0[8];
uniform vec4 hsl1[8];
${curveUniforms}
uniform ivec4 curveCounts0;
uniform ivec4 curveCounts1;
uniform ivec4 curveIdentity0;
uniform ivec4 curveIdentity1;
uniform vec2 neutralHsl;
${detail ? detailUniforms : ''}
const float alpha = 1.09929682680944;
const float beta = 0.018053968510807;
const vec3 luma = vec3(0.2126, 0.7152, 0.0722);

float decode709(float v) {
  return v < 4.5 * beta ? v / 4.5 : pow((v + alpha - 1.0) / alpha, 1.0 / 0.45);
}
float encode709(float v) {
  return v < beta ? 4.5 * v : alpha * pow(v, 0.45) - (alpha - 1.0);
}
${detail ? detailFunction : ''}
// extra: (hue in radians, whites).
float toneCurve(float v, vec4 tone, vec2 extra) {
  v += (tone.z - 1.0) * v * (1.0 - v) * (2.0 * v - 1.0);
  v += 2.0 * tone.y * v * (1.0 - v);
  return v + extra.y * ${glslFloat(WHITES_RANGE)} * v * v * v * v;
}
float blacksCurve(float v, float blacks) {
  float shadow = (1.0 - v) * (1.0 - v);
  return v + blacks * ${glslFloat(BLACKS_RANGE)} * shadow * shadow;
}
// correction: Temperature/Tint linear gains in xyz, Blacks in w.
vec3 scalarGrade(vec3 code, vec4 tone, vec2 extra, vec4 correction, float vibrance) {
  if (all(equal(correction, vec4(1.0, 1.0, 1.0, 0.0))) && all(equal(tone, vec4(0.0, 0.0, 1.0, 1.0))) &&
      all(equal(extra, vec2(0.0))) && vibrance == 0.0) return code;
  vec3 rgb = vec3(decode709(code.r), decode709(code.g), decode709(code.b));
  rgb *= correction.xyz;
  rgb *= exp2(tone.x);
  float baseY = clamp(dot(rgb, luma), 0.0, 1.0);
  float blacks = correction.w;
  if (tone.y != 0.0 || tone.z != 1.0 || extra.y != 0.0 || blacks != 0.0) {
    float toned = toneCurve(encode709(baseY), tone, extra);
    if (blacks < 0.0) toned = max(0.0, blacksCurve(toned, blacks));
    float blackGain = blacks < 0.0 ? 0.0 : (2.0 - tone.z) * (1.0 + 2.0 * tone.y);
    rgb *= baseY > 0.0 ? decode709(toned) / baseY : blackGain;
    if (blacks > 0.0) rgb += decode709(blacksCurve(toned, blacks)) - decode709(toned);
  }
  float y = dot(rgb, luma);
  float cb = (rgb.b - y) / 1.8556;
  float cr = (rgb.r - y) / 1.5748;
  float chroma = tone.w;
  if (vibrance != 0.0) {
    float maximum = max(rgb.r, max(rgb.g, rgb.b));
    float colourfulness = maximum > 0.0 ? (maximum - min(rgb.r, min(rgb.g, rgb.b))) / maximum : 0.0;
    float muted = 1.0 - min(1.0, colourfulness);
    chroma *= 1.0 + vibrance * muted * muted;
  }
  float u = chroma * (cb * cos(extra.x) - cr * sin(extra.x));
  float v = chroma * (cb * sin(extra.x) + cr * cos(extra.x));
  float red = y + 1.5748 * v;
  float blue = y + 1.8556 * u;
  float green = (y - 0.2126 * red - 0.0722 * blue) / 0.7152;
  rgb = clamp(vec3(red, green, blue), 0.0, 1.0);
  return vec3(encode709(rgb.r), encode709(rgb.g), encode709(rgb.b));
}
float hueComponent(float h) {
  float k = mod(h, 360.0) / 60.0;
  return clamp(abs(k - 3.0) - 1.0, 0.0, 1.0);
}
vec3 rangeGrade(vec3 code, int sourceIndex) {
  if (neutralHsl[sourceIndex] > 0.5) return code;
  float maximum = max(code.r, max(code.g, code.b));
  float minimum = min(code.r, min(code.g, code.b));
  float chroma = maximum - minimum;
  if (chroma == 0.0) return code;
  float h;
  if (maximum == code.r) h = 60.0 * (code.g - code.b) / chroma;
  else if (maximum == code.g) h = 60.0 * (2.0 + (code.b - code.r) / chroma);
  else h = 60.0 * (4.0 + (code.r - code.g) / chroma);
  h = mod(h + 360.0, 360.0);
  const float centres[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);
  int band = 7;
  for (int i = 0; i < 7; i++) { if (h < centres[i + 1]) { band = i; break; } }
  float weight = smoothstep(centres[band], centres[band + 1], h);
  vec3 left = sourceIndex == 0 ? hsl0[band].xyz : hsl1[band].xyz;
  vec3 right = sourceIndex == 0 ? hsl0[(band + 1) % 8].xyz : hsl1[(band + 1) % 8].xyz;
  vec3 offset = mix(left, right, weight) * smoothstep(0.0, 0.1, chroma);
  if (all(equal(offset, vec3(0.0)))) return code;
  float l = (maximum + minimum) * 0.5;
  float s = clamp(chroma / (1.0 - abs(2.0 * l - 1.0)) * (1.0 + offset.y), 0.0, 1.0);
  l = clamp(l + offset.z, 0.0, 1.0);
  h += offset.x;
  float amplitude = (1.0 - abs(2.0 * l - 1.0)) * s;
  return vec3(l) + amplitude * (vec3(hueComponent(h), hueComponent(h - 120.0), hueComponent(h - 240.0)) - 0.5);
}
${curveFunctions}
vec3 grade(vec3 code, vec4 tone, vec2 extra, int sourceIndex) {
  vec3 base = scalarGrade(code, tone, extra, sourceIndex == 0 ? correction0 : correction1,
                          sourceIndex == 0 ? vibrance.x : vibrance.y);
  ivec4 identity = sourceIndex == 0 ? curveIdentity0 : curveIdentity1;
  if (neutralHsl[sourceIndex] > 0.5 && all(equal(identity, ivec4(1)))) return base;
  vec3 rgb = rangeGrade(base, sourceIndex);
  if (all(equal(identity, ivec4(1)))) return rgb;
  if (sourceIndex == 0) return vec3(curve0_1Value(curve0_0Value(rgb.r)),
                                    curve0_2Value(curve0_0Value(rgb.g)),
                                    curve0_3Value(curve0_0Value(rgb.b)));
  return vec3(curve1_1Value(curve1_0Value(rgb.r)),
              curve1_2Value(curve1_0Value(rgb.g)),
              curve1_3Value(curve1_0Value(rgb.b)));
}
vec3 sampleRgb(sampler2D source, vec2 coordinate, int sourceIndex) {
  ${detail ? detailSample : 'return texture(source, coordinate).rgb;'}
}
vec3 sampleGraded(sampler2D source, vec4 tone, vec2 extra, float aspect, int sourceIndex) {
  vec2 local = uv;
  if (aspect > canvasAspect) local.y = (uv.y - 0.5) * aspect / canvasAspect + 0.5;
  else local.x = (uv.x - 0.5) * canvasAspect / aspect + 0.5;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return vec3(0.0);
  return grade(sampleRgb(source, local, sourceIndex), tone, extra, sourceIndex);
}
vec4 sampleSpatial(sampler2D source, vec4 tone, vec2 extra, float aspect,
                   vec3 rowU, vec3 rowV, vec4 crop, float neutral, int sourceIndex) {
  // Exact identity retains the opaque, proxy-aspect letterbox path.
  if (neutral > 0.5) return vec4(sampleGraded(source, tone, extra, aspect, sourceIndex), 1.0);
  vec3 outputPoint = vec3(uv.x, 1.0 - uv.y, 1.0);
  vec2 original = vec2(dot(rowU, outputPoint), dot(rowV, outputPoint));
  // Crop IN is inclusive; OUT is exclusive, without refitting the image.
  if (original.x < crop.x || original.x >= 1.0 - crop.y ||
      original.y < crop.z || original.y >= 1.0 - crop.w) return vec4(0.0);
  return vec4(grade(sampleRgb(source, vec2(original.x, 1.0 - original.y), sourceIndex), tone, extra, sourceIndex), 1.0);
}
${single ? singleMain : groupMain}`;

export const fragmentShader = createFragmentShader(false, false);
// A fixed single-source specialization lets drivers eliminate unused source-1
// grade arrays/functions. Dissolves retain the complete grouped shader above.
export const singleFragmentShader = createFragmentShader(true, false);

// Share geometry/composition verbatim. Rows with identity advanced settings use
// a scalar-only program, avoiding driver execution cost of unused bounded arrays.
const scalarOf = (shader: string): string =>
  shader.slice(0, shader.indexOf('float hueComponent')) +
  `vec3 grade(vec3 code, vec4 tone, vec2 extra, int sourceIndex) {
    return scalarGrade(code, tone, extra, sourceIndex == 0 ? correction0 : correction1,
                       sourceIndex == 0 ? vibrance.x : vibrance.y);
  }
` +
  shader.slice(shader.indexOf('vec3 sampleRgb'));
export const scalarFragmentShader = scalarOf(fragmentShader);

// Software rasterizers can execute untaken uniform branches' texture taps, so neutral
// clips never run the detail kernel: it lives only in these separate variants.
export const detailFragmentShader = createFragmentShader(false, true);
export const singleDetailFragmentShader = createFragmentShader(true, true);
export const scalarDetailFragmentShader = scalarOf(detailFragmentShader);
