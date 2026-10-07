export const vertexShader = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

// Deliberately implements docs/COLOUR_AND_TIMING.md, not an approximation of eq/hue.
export const fragmentShader = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColour;
uniform sampler2D source0;
uniform sampler2D source1;
uniform vec4 tone0;
uniform vec4 tone1;
uniform vec3 extra0;
uniform vec3 extra1;
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

const float alpha = 1.09929682680944;
const float beta = 0.018053968510807;
const vec3 luma = vec3(0.2126, 0.7152, 0.0722);

float decode709(float v) {
  return v < 4.5 * beta ? v / 4.5 : pow((v + alpha - 1.0) / alpha, 1.0 / 0.45);
}
float encode709(float v) {
  return v < beta ? 4.5 * v : alpha * pow(v, 0.45) - (alpha - 1.0);
}
vec3 grade(vec3 code, vec4 tone, vec3 extra) {
  vec3 rgb = vec3(decode709(code.r), decode709(code.g), decode709(code.b));
  rgb = (rgb * exp2(tone.x) - 0.18) * tone.z + 0.18 + tone.y;
  float maskY = clamp(dot(rgb, luma), 0.0, 1.0);
  rgb += 0.25 * (extra.z * pow(1.0 - maskY, 2.0) + extra.y * maskY * maskY);
  float y = dot(rgb, luma);
  float cb = (rgb.b - y) / 1.8556;
  float cr = (rgb.r - y) / 1.5748;
  float u = tone.w * (cb * cos(extra.x) - cr * sin(extra.x));
  float v = tone.w * (cb * sin(extra.x) + cr * cos(extra.x));
  float red = y + 1.5748 * v;
  float blue = y + 1.8556 * u;
  float green = (y - 0.2126 * red - 0.0722 * blue) / 0.7152;
  rgb = clamp(vec3(red, green, blue), 0.0, 1.0);
  return vec3(encode709(rgb.r), encode709(rgb.g), encode709(rgb.b));
}
vec3 sampleGraded(sampler2D source, vec4 tone, vec3 extra, float aspect) {
  vec2 local = uv;
  if (aspect > canvasAspect) local.y = (uv.y - 0.5) * aspect / canvasAspect + 0.5;
  else local.x = (uv.x - 0.5) * canvasAspect / aspect + 0.5;
  if (any(lessThan(local, vec2(0.0))) || any(greaterThan(local, vec2(1.0)))) return vec3(0.0);
  return grade(texture(source, local).rgb, tone, extra);
}
vec4 sampleSpatial(sampler2D source, vec4 tone, vec3 extra, float aspect,
                   vec3 rowU, vec3 rowV, vec4 crop, float neutral) {
  // Exact identity retains the opaque, proxy-aspect letterbox path.
  if (neutral > 0.5) return vec4(sampleGraded(source, tone, extra, aspect), 1.0);
  vec3 outputPoint = vec3(uv.x, 1.0 - uv.y, 1.0);
  vec2 original = vec2(dot(rowU, outputPoint), dot(rowV, outputPoint));
  // Crop IN is inclusive; OUT is exclusive, without refitting the image.
  if (original.x < crop.x || original.x >= 1.0 - crop.y ||
      original.y < crop.z || original.y >= 1.0 - crop.w) return vec4(0.0);
  return vec4(grade(texture(source, vec2(original.x, 1.0 - original.y)).rgb, tone, extra), 1.0);
}
void main() {
  vec4 left = sampleSpatial(source0, tone0, extra0, imageAspect.x,
                            spatialU0, spatialV0, crop0, neutralSpatial.x);
  vec4 right = sampleSpatial(source1, tone1, extra1, imageAspect.y,
                             spatialU1, spatialV1, crop1, neutralSpatial.y);
  // A dissolve is ONE premultiplied group, not two source-over draws.
  // Black fades dim graded RGB without reducing the group's coverage.
  vec3 premultiplied = left.rgb * left.a * coverage.x * brightness.x +
                       right.rgb * right.a * coverage.y * brightness.y;
  outputColour = vec4(premultiplied, left.a * coverage.x + right.a * coverage.y);
}`;
