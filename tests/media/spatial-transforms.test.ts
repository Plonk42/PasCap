import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { startExport, type ExportReceipt } from '../../src/server/export.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { renderLayeredExport, type LayeredRenderReport } from '../../src/server/layered-export.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import { gradePixel, NEUTRAL_COLOUR, type RGB } from '../../src/shared/colour.js';
import { compileDetail, type DetailFilter, type DetailSettings } from '../../src/shared/detail.js';
import {
  EXPORT_PROFILES,
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  planLayeredExport,
} from '../../src/shared/export.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE, type SpatialPose, type SpatialSettings } from '../../src/shared/spatial.js';
import { calculateLayout, sampleTimeline, type PreviewLayer } from '../../src/shared/timeline.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const BASE = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
type Target = { width: number; height: number };
type Bounds = Target & { x: number; y: number };

function pose(changes: Partial<SpatialPose> = {}): SpatialPose {
  return { ...NEUTRAL_SPATIAL_POSE, ...changes };
}

// Deliberately do not call evaluateSpatial, compileSpatialMapping, fittedContent,
// composeLayerFrame or compositePixel in the oracle. These tests exercise them.
function referencePose(settings: SpatialSettings, position: number): SpatialPose {
  const result = { ...settings.base };
  for (const channel of Object.keys(result) as (keyof SpatialPose)[]) {
    const keys = settings.keyframes.filter((key) => key.values[channel] !== null);
    if (!keys.length) continue;
    if (position <= keys[0]!.frame) {
      result[channel] = keys[0]!.values[channel]!;
      continue;
    }
    const rightIndex = keys.findIndex((key) => key.frame > position);
    if (rightIndex < 0) {
      result[channel] = keys.at(-1)!.values[channel]!;
      continue;
    }
    const left = keys[rightIndex - 1]!;
    const right = keys[rightIndex]!;
    const t = (position - left.frame) / (right.frame - left.frame);
    const progress = {
      hold: 0,
      linear: t,
      'ease-in': t * t,
      'ease-out': 2 * t - t * t,
      smooth: 3 * t * t - 2 * t * t * t,
    }[left.interpolation];
    result[channel] = left.values[channel]! * (1 - progress) + right.values[channel]! * progress;
  }
  return result;
}

function referenceBounds(original: Target, target: Target): Bounds {
  const fit = Math.min(target.width / original.width, target.height / original.height);
  const width = Math.min(target.width, Math.max(2, Math.floor((original.width * fit) / 2 + 1e-8) * 2));
  const height = Math.min(target.height, Math.max(2, Math.floor((original.height * fit) / 2 + 1e-8) * 2));
  return { width, height, x: Math.floor((target.width - width) / 2), y: Math.floor((target.height - height) / 2) };
}

interface ReferenceSource {
  sample: PreviewLayer;
  pose: SpatialPose;
  bounds: Bounds;
  rgb: Buffer;
  neutral: boolean;
  /** Shared detail kernel on this independent bilinear sampler; null when neutral. */
  detail: DetailFilter | null;
  cosine: number;
  sine: number;
  denominatorX: number;
  denominatorY: number;
  centreX: number;
  centreY: number;
}

function uvAt(source: ReferenceSource, x: number, y: number): readonly [number, number] {
  // Independent inverse in physical output pixels, using ORIGINAL aspect. The
  // even-rounded decode rectangle is only used later to sample the fitted RGB.
  const dx = x + 0.5 - source.centreX;
  const dy = y + 0.5 - source.centreY;
  return [
    0.5 + (source.cosine * dx + source.sine * dy) / source.denominatorX,
    0.5 + (-source.sine * dx + source.cosine * dy) / source.denominatorY,
  ];
}

function covered(source: ReferenceSource, u: number, v: number): boolean {
  return (
    source.neutral ||
    (u >= source.pose.cropLeft &&
      u < 1 - source.pose.cropRight &&
      v >= source.pose.cropTop &&
      v < 1 - source.pose.cropBottom)
  );
}

function fittedRgb(source: ReferenceSource, u: number, v: number, target: Target, out: Float64Array): void {
  const bounds = source.bounds;
  const px = bounds.x + u * bounds.width - 0.5;
  const py = bounds.y + v * bounds.height - 0.5;
  const column = Math.floor(px);
  const row = Math.floor(py);
  const dx = px - column;
  const dy = py - row;
  const value = (xx: number, yy: number, channel: number): number =>
    source.rgb[
      (Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, yy)) * target.width +
        Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, xx))) *
        3 +
        channel
    ]! / 255;
  for (let channel = 0; channel < 3; channel++)
    out[channel] =
      (value(column, row, channel) * (1 - dx) + value(column + 1, row, channel) * dx) * (1 - dy) +
      (value(column, row + 1, channel) * (1 - dx) + value(column + 1, row + 1, channel) * dx) * dy;
}

function sourceRgb(source: ReferenceSource, u: number, v: number, x: number, y: number, target: Target): RGB {
  const bounds = source.bounds;
  if (source.neutral) {
    if (x < bounds.x || x >= bounds.x + bounds.width || y < bounds.y || y >= bounds.y + bounds.height) return [0, 0, 0]; // Exact legacy padding: opaque, black and never graded.
    if (!source.detail) {
      const offset = (y * target.width + x) * 3;
      return gradePixel(
        [source.rgb[offset]! / 255, source.rgb[offset + 1]! / 255, source.rgb[offset + 2]! / 255],
        source.sample.colour,
      );
    }
    u = (x + 0.5 - bounds.x) / bounds.width;
    v = (y + 0.5 - bounds.y) / bounds.height;
  }
  const out = new Float64Array(3);
  if (source.detail) source.detail.apply((su, sv, target_) => fittedRgb(source, su, sv, target, target_), u, v, out);
  else fittedRgb(source, u, v, target, out);
  return gradePixel([out[0]!, out[1]!, out[2]!], source.sample.colour);
}

function referencePixel(groups: readonly ReferenceSource[][], x: number, y: number, target: Target): readonly number[] {
  let lower = [0, 0, 0, 0];
  for (const group of groups) {
    const rgb = [0, 0, 0];
    let alpha = 0;
    for (const source of group) {
      const [u, v] = uvAt(source, x, y);
      if (!covered(source, u, v)) continue;
      const weight = source.sample.opacity * source.sample.blendWeight;
      alpha += weight;
      if (source.sample.brightness === 0 || weight === 0) continue;
      const graded = sourceRgb(source, u, v, x, y, target);
      for (let channel = 0; channel < 3; channel++)
        rgb[channel]! += graded[channel]! * weight * source.sample.brightness;
    }
    // Match the documented RGBA16 pass boundaries, not the implementation's LUT.
    const groupAlpha = Math.round(alpha * 65535) / 65535;
    lower = [
      ...rgb.map(
        (value, channel) => Math.round(Math.round(value * 65535) + lower[channel]! * 65535 * (1 - groupAlpha)) / 65535,
      ),
      Math.round(groupAlpha * 65535 + lower[3]! * 65535 * (1 - groupAlpha)) / 65535,
    ];
  }
  return lower;
}

function referenceAlpha(groups: readonly ReferenceSource[][], x: number, y: number): number {
  let lower = 0;
  for (const group of groups) {
    let alpha = 0;
    for (const source of group) {
      // Avoid allocating a UV tuple for every pixel in the exhaustive UHD mask.
      const dx = x + 0.5 - source.centreX;
      const dy = y + 0.5 - source.centreY;
      const u = 0.5 + (source.cosine * dx + source.sine * dy) / source.denominatorX;
      const v = 0.5 + (-source.sine * dx + source.cosine * dy) / source.denominatorY;
      if (covered(source, u, v)) alpha += source.sample.opacity * source.sample.blendWeight;
    }
    const groupAlpha = Math.round(alpha * 65535);
    lower = Math.round(groupAlpha + lower * (1 - groupAlpha / 65535));
  }
  return lower;
}

describe.skipIf(!enabled)('spatial transforms · real native FFmpeg, disposable short originals', () => {
  let root: string;
  let config: ServiceConfig;
  let jobs: JobQueue;
  let library: MediaLibrary;
  const assets: MediaAsset[] = [];
  const originals: Buffer[] = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pascap-spatial-media-'));
    config = createConfig({ dataDir: path.join(root, 'cache') });
    jobs = new JobQueue();
    library = new MediaLibrary(config, jobs);
    await library.initialise();
    // Asymmetric, frame-coded patches distinguish orientation, source identity,
    // translation and crop. Non-16:9 sources also expose original-vs-rounded fit.
    for (const [index, [width, height]] of [
      [160, 90],
      [158, 114],
      [154, 86],
    ].entries()) {
      const sourceDirectory = path.join(root, 'synthetic-sources');
      await mkdir(sourceDirectory, { recursive: true });
      const filename = path.join(sourceDirectory, `generated-pattern-${index}.mp4`);
      await runProcess(config.ffmpeg, [
        ...BASE,
        '-n',
        '-f',
        'lavfi',
        '-i',
        `nullsrc=size=${width}x${height}:rate=30000/1001,geq=lum='55+14*N+25*gte(X,W/2)+12*gte(Y,H/2)':cb='${95 + index * 17}+12*gte(X,W/3)':cr='${155 - index * 13}-15*gte(Y,H/3)',setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
        '-frames:v',
        '4',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '2',
        '-filter_threads',
        '2',
        '-bf',
        '0',
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-color_range',
        'tv',
        '-video_track_timescale',
        '30000',
        filename,
      ]);
      const asset = await library.register(filename);
      expect(asset.metadata).toMatchObject({ width, height, frameCount: 4, pixelFormat: 'yuv420p' });
      assets.push(asset);
      originals.push(await readFile(filename));
    }
  });

  afterAll(async () => {
    await jobs?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function unchanged(): Promise<void> {
    for (const [index, asset] of assets.entries()) {
      expect(await fingerprintFile(asset.sourcePath)).toEqual(asset.fingerprint);
      expect(await readFile(asset.sourcePath)).toEqual(originals[index]);
    }
  }

  // One selected decoded frame at a time, never a whole UHD movie in memory.
  async function frameBytes(
    filename: string,
    frame: number,
    target: Target,
    rgba: boolean,
    filter = '',
  ): Promise<Buffer> {
    const bytesPerPixel = rgba ? 8 : 3;
    const bytes = await runProcess(
      config.ffmpeg,
      [
        ...BASE,
        '-threads',
        '2',
        '-noautorotate',
        '-i',
        filename,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-dn',
        '-filter_threads',
        '2',
        '-vf',
        `select=eq(n\\,${frame})${filter ? `,${filter}` : ''}`,
        '-frames:v',
        '1',
        '-fps_mode',
        'passthrough',
        '-c:v',
        'rawvideo',
        '-pix_fmt',
        rgba ? 'rgba64le' : 'rgb24',
        '-threads',
        '2',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { maxBytes: target.width * target.height * bytesPerPixel },
    );
    expect(bytes).toHaveLength(target.width * target.height * bytesPerPixel);
    return bytes;
  }

  async function referenceSources(
    project: ProjectDocument,
    frame: number,
    target: Target,
  ): Promise<ReferenceSource[][]> {
    const layout = calculateLayout(project);
    const samples = sampleTimeline(project, frame, layout);
    const prepared: ReferenceSource[] = [];
    for (const sample of samples) {
      const clip = project.clips.find((clip) => clip.id === sample.clipId)!;
      const placed = layout.clips.find((placed) => placed.clip.id === sample.clipId)!;
      const asset = assets.find((asset) => asset.id === sample.mediaId)!;
      expect(sample.sourceFrame).toBe(placed.retiming.sourceAt(frame - placed.start));
      expect(sample.sourcePosition).toBe(placed.retiming.sourcePositionAt(frame - placed.start));
      expect(sample.sourceFrame).toBeGreaterThanOrEqual(clip.sourceIn);
      expect(sample.sourceFrame).toBeLessThan(clip.sourceOut);
      const spatial = referencePose(clip.spatial, sample.sourcePosition);
      for (const channel of Object.keys(spatial) as (keyof SpatialPose)[])
        expect(sample.spatial[channel]).toBeCloseTo(spatial[channel], 12);
      const bounds = referenceBounds(asset.metadata, target);
      const rgb = await frameBytes(
        asset.sourcePath,
        sample.sourceFrame,
        target,
        false,
        `scale=${bounds.width}:${bounds.height}:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24,pad=${target.width}:${target.height}:${bounds.x}:${bounds.y}:black,setsar=1`,
      );
      const fit = Math.min(target.width / asset.metadata.width, target.height / asset.metadata.height);
      const radians = (spatial.rotation * Math.PI) / 180;
      prepared.push({
        sample,
        pose: spatial,
        bounds,
        rgb,
        neutral: (Object.keys(spatial) as (keyof SpatialPose)[]).every(
          (key) => spatial[key] === NEUTRAL_SPATIAL_POSE[key],
        ),
        detail: compileDetail(sample.detail, asset.metadata.width / asset.metadata.height, sample.colour.hdr),
        cosine: Math.cos(radians),
        sine: Math.sin(radians),
        denominatorX: fit * asset.metadata.width * spatial.scale,
        denominatorY: fit * asset.metadata.height * spatial.scale,
        centreX: target.width * (0.5 + spatial.translateX),
        centreY: target.height * (0.5 + spatial.translateY),
      });
    }
    return project.layers.map((row) => prepared.filter((source) => source.sample.layerId === row.id));
  }

  function resourceBounds(report: LayeredRenderReport, target: Target, project: ProjectDocument): void {
    expect(report.peakOriginalVideoDecoders).toBe(1);
    expect(report.peakIntermediateVideoDecoders).toBeLessThanOrEqual(2);
    expect(report.peakVideoEncoders).toBe(1);
    expect(report.peakNativeVideoChildren).toBeLessThanOrEqual(3);
    expect(report.peakLosslessClipFiles).toBeLessThanOrEqual(2);
    expect(report.peakLosslessTimelineRepresentations).toBeLessThanOrEqual(3);
    expect(report.rawFrameBuffers).toBe(4);
    expect(report.rawBufferBytes).toBe(target.width * target.height * 22);
    expect(report.peakLutEntries).toBeLessThanOrEqual(2);
    expect(report.lutBytes).toBeLessThanOrEqual(LAYERED_EXPORT_RESOURCES.lutBytes * 2);
    expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    expect(report.originalDecoderProcesses).toBe(project.clips.length);
    const rows = project.layers.filter((row) => row.enabled && project.clips.some((clip) => clip.layerId === row.id));
    expect(report.layerPasses).toBe(rows.length);
    expect(report.sourceOverPasses).toBe(rows.length - 1);
    expect(report.compositeFrames).toBe(calculateLayout(project).duration * (2 * rows.length - 1));
    expect(report.compositePixels).toBe(report.compositeFrames * target.width * target.height);
  }

  async function lossless(project: ProjectDocument, target: Target, directory: string): Promise<string> {
    const result = await renderLayeredExport({
      document: project,
      plan: planLayeredExport(project),
      assets: project.clips.map((clip) => library.get(clip.mediaId)),
      ffmpeg: config.ffmpeg,
      directory,
      target: { ...EXPORT_PROFILES.draft720, ...target },
      context: { id: randomUUID(), signal: new AbortController().signal, update: () => {} },
    });
    resourceBounds(result.report, target, project);
    expect(await readdir(directory)).toEqual([result.filename]);
    expect(result.retiming).toHaveLength(project.clips.length);
    for (const [index, report] of result.retiming.entries()) {
      const placed = calculateLayout(project).clips.find(
        (placed) => placed.clip.id === result.report.renderedClipIds[index],
      )!;
      expect(report).toMatchObject({
        decodedFrames: placed.clip.sourceOut - placed.clip.sourceIn,
        outputFrames: placed.duration,
        frameBytes: target.width * target.height * 3,
        rawFrameBuffers: 1,
      });
      expect(report.largestReadChunkBytes).toBeLessThanOrEqual(256 * 1024);
    }
    return path.join(directory, result.filename);
  }

  async function exactFrames(filename: string, target: Target, count: number, packets = false): Promise<void> {
    const bytes = await runProcess(config.ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_streams',
      '-show_entries',
      'stream=width,height,nb_read_frames,r_frame_rate',
      '-of',
      'json',
      filename,
    ]);
    const streams = (
      JSON.parse(bytes.toString('utf8')) as {
        streams: { width: number; height: number; nb_read_frames: string; r_frame_rate: string }[];
      }
    ).streams;
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      width: target.width,
      height: target.height,
      nb_read_frames: String(count),
      r_frame_rate: '30000/1001',
    });
    if (!packets) return;
    const data = await runProcess(config.ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-show_entries',
      'packet=pts,dts,duration',
      '-of',
      'json',
      filename,
    ]);
    const entries = (JSON.parse(data.toString('utf8')) as { packets: { pts: number; dts: number; duration: number }[] })
      .packets;
    expect(entries).toHaveLength(count);
    entries.forEach((packet, frame) =>
      expect(packet).toEqual({ pts: frame * 1001, dts: frame * 1001, duration: 1001 }),
    );
  }

  async function parity(
    project: ProjectDocument,
    target: Target,
    losslessFile: string,
    encodedFile?: string,
  ): Promise<void> {
    const duration = calculateLayout(project).duration;
    await exactFrames(losslessFile, target, duration);
    if (encodedFile) await exactFrames(encodedFile, target, duration, true);
    for (let frame = 0; frame < duration; frame++) {
      const groups = await referenceSources(project, frame, target);
      const raw = await frameBytes(losslessFile, frame, target, true);
      const actual = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
      const encoded = encodedFile
        ? await frameBytes(
            encodedFile,
            frame,
            target,
            false,
            'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24',
          )
        : null;
      let maskError = 0;
      let transparentErrors = 0;
      // Every output pixel, including rotated/cropped edges, has a strict mask
      // check. RGB uses a fixed dense lattice plus off-lattice canonical probes;
      // no edge exclusion or increased existing MAE tolerances for spatial edits.
      for (let y = 0; y < target.height; y++) {
        for (let x = 0; x < target.width; x++) {
          const offset = (y * target.width + x) * 4;
          const alpha = referenceAlpha(groups, x, y);
          maskError = Math.max(maskError, Math.abs(actual[offset + 3]! - alpha));
          if (alpha === 0 && (actual[offset]! || actual[offset + 1]! || actual[offset + 2]! || actual[offset + 3]!))
            transparentErrors++;
        }
      }
      expect(maskError, `frame ${frame}: full-resolution RGBA16 coverage`).toBeLessThanOrEqual(2);
      expect(transparentErrors, `frame ${frame}: unavailable coverage must be exactly transparent black`).toBe(0);
      let losslessError = 0;
      let encodedError = 0;
      let channels = 0;
      let canonicalMaximum = 0;
      const check = (x: number, y: number, canonical = false): void => {
        const expected = referencePixel(groups, x, y, target);
        const pixel = y * target.width + x;
        for (let channel = 0; channel < 3; channel++) {
          const error = Math.abs(actual[pixel * 4 + channel]! / 65535 - expected[channel]!) * 255;
          losslessError += error;
          if (canonical) canonicalMaximum = Math.max(canonicalMaximum, error);
          if (encoded) encodedError += Math.abs(encoded[pixel * 3 + channel]! - expected[channel]! * 255);
          channels++;
        }
      };
      // 7-pixel sampling retains narrow edges without allocating a reference image.
      for (let y = 0; y < target.height; y += 7) for (let x = 0; x < target.width; x += 7) check(x, y);
      for (let row = 0; row < 9; row++)
        for (let column = 0; column < 9; column++)
          check(Math.floor(((column + 0.31) * target.width) / 9), Math.floor(((row + 0.43) * target.height) / 9), true);
      expect(
        canonicalMaximum,
        `frame ${frame}: canonical RGB maximum / 255, same bound as the GPU contract`,
      ).toBeLessThan(2);
      expect(losslessError / channels, `frame ${frame}: independent lossless RGB MAE / 255`).toBeLessThan(1);
      if (encoded) expect(encodedError / channels, `frame ${frame}: H.264 RGB MAE / 255`).toBeLessThan(4);
    }
  }

  const staticCases: {
    name: string;
    changes: Partial<SpatialPose>;
    asset: number;
    detail?: DetailSettings;
    hdr?: number;
  }[] = [
    {
      name: 'crop with exact inclusive IN/exclusive OUT pixel centres',
      asset: 0,
      changes: {
        // Dyadic UV boundaries at exact pixel centres avoid an ambiguous floating
        // point tie while still exercising IN inclusion and OUT exclusion.
        cropLeft: 242.5 / 1280,
        cropRight: 1 - 1002.5 / 1280,
        cropTop: 112.5 / 720,
        cropBottom: 1 - 607.5 / 720,
      },
    },
    { name: 'uniform scale about original centre', asset: 1, changes: { scale: 0.61 } },
    { name: 'translation in full-canvas fractions', asset: 1, changes: { translateX: 0.19, translateY: -0.23 } },
    { name: 'clockwise rotation', asset: 1, changes: { rotation: 37 } },
    {
      name: 'combined crop/scale/translation/rotation with original aspect',
      asset: 1,
      changes: {
        scale: 1.31,
        rotation: -29,
        translateX: -0.13,
        translateY: 0.07,
        cropLeft: 0.14,
        cropBottom: 0.23,
      },
    },
    {
      name: 'Sharpen, Clarity and Denoise on the neutral letterboxed path',
      asset: 1,
      changes: {},
      detail: { sharpen: 0.8, clarity: 0.6, denoise: 0.5 },
    },
    {
      name: 'Sharpen, negative Clarity and Denoise before a rotated, scaled grade',
      asset: 0,
      changes: { scale: 1.2, rotation: 13, translateX: 0.04 },
      detail: { sharpen: 0.5, clarity: -0.7, denoise: 0.9 },
    },
    { name: 'track HDR on the neutral letterboxed path', asset: 1, changes: {}, hdr: 0.8 },
    {
      name: 'track HDR with clip detail before a rotated, scaled grade',
      asset: 0,
      changes: { scale: 1.2, rotation: 13, translateX: 0.04 },
      detail: { sharpen: 0.4, clarity: 0.3, denoise: 0.5 },
      hdr: 0.6,
    },
  ];

  it.each(staticCases)('720p lossless native parity: $name', async ({ changes, asset, detail, hdr }) => {
    const project = createProject('static-spatial', 'Disposable one-frame spatial test');
    const clip = createClip('pattern', assets[asset]!.id, 1, 2);
    clip.spatial.base = pose(changes);
    if (detail) clip.detail = detail;
    if (hdr) project.layers[0]!.colour.hdr = hdr;
    project.clips = [clip];
    const captured = projectSchema.parse(project);
    expect(needsLayeredExport(captured)).toBe(true);
    const work = await mkdtemp(path.join(root, 'static-'));
    try {
      const filename = await lossless(captured, EXPORT_PROFILES.draft720, work);
      await parity(captured, EXPORT_PROFILES.draft720, filename);
      expect(project).toEqual(captured);
      await unchanged();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  function compound(): ProjectDocument {
    const project = createProject('animated-spatial', 'Four-frame held-source spatial dissolve');
    const lower = project.layers[0]!;
    lower.opacity = 0.8;
    const upper = createLayer('upper', 'Independent spatial sources', true);
    upper.opacity = 0.91; // Keys override this once, not again after composition.
    upper.openingFade = 1;
    upper.closingFade = 1;
    upper.keyframes = [
      {
        frame: 0,
        interpolation: 'linear',
        values: { ...EMPTY_KEY_VALUES, opacity: 0.35, temperature: -0.8, tint: 0.6 },
      },
      {
        frame: 3,
        interpolation: 'hold',
        values: { ...EMPTY_KEY_VALUES, opacity: 0.75, temperature: 0.9, tint: -0.7 },
      },
    ];
    project.layers.push(upper);
    const base = createClip('base', assets[0]!.id, 0, 4);
    const left = createClip('left', assets[1]!.id, 1, 2, upper.id);
    const right = createClip('right', assets[2]!.id, 2, 3, upper.id);
    left.speed = right.speed = { mode: 'constant', rate: 1 / 3 };
    right.start = 1;
    project.layers[0]!.colour = {
      ...NEUTRAL_COLOUR,
      temperature: 0.7,
      tint: -0.5,
      exposure: 0.2,
      contrast: 0.95,
      saturation: 0.8,
      brightness: 0.03,
    };
    left.spatial = {
      base: pose({ scale: 3 }),
      keyframes: [
        {
          frame: 1,
          interpolation: 'linear',
          values: pose({
            cropLeft: 0.12,
            cropRight: 0.18,
            cropTop: 0.09,
            cropBottom: 0.21,
            scale: 0.83,
            rotation: 21,
            translateX: -0.1,
            translateY: 0.08,
          }),
        },
        {
          frame: 2,
          interpolation: 'hold',
          values: pose({
            cropLeft: 0.23,
            cropRight: 0.07,
            cropTop: 0.17,
            cropBottom: 0.11,
            scale: 1.17,
            rotation: -17,
            translateX: 0.16,
            translateY: -0.13,
          }),
        },
      ],
    };
    right.spatial = {
      base: pose({ rotation: 90 }),
      keyframes: [
        {
          frame: 2,
          interpolation: 'smooth',
          values: pose({
            cropLeft: 0.07,
            cropRight: 0.11,
            cropTop: 0.23,
            cropBottom: 0.06,
            scale: 0.71,
            rotation: -31,
            translateX: 0.21,
            translateY: -0.17,
          }),
        },
        {
          frame: 3,
          interpolation: 'hold',
          values: pose({
            cropLeft: 0.19,
            cropRight: 0.22,
            cropTop: 0.08,
            cropBottom: 0.16,
            scale: 1.09,
            rotation: 26,
            translateX: -0.11,
            translateY: 0.14,
          }),
        },
      ],
    };
    upper.transitions = [{ leftId: left.id, rightId: right.id, type: 'cross-dissolve', duration: 2 }];
    project.clips = [base, left, right];
    return projectSchema.parse(project);
  }

  it.each(['draft720', 'final4k'] as const)(
    'actual %s export and lossless masks: animated held sources, differing dissolve poses, row opacity and black fades',
    async (profile) => {
      const project = compound();
      const captured = structuredClone(project);
      const target = EXPORT_PROFILES[profile];
      const layout = calculateLayout(project);
      expect(layout.duration).toBe(4);
      expect(layout.transitions[0]).toMatchObject({ start: 1, end: 3 });
      for (let frame = 0; frame < 4; frame++) {
        for (const sample of sampleTimeline(project, frame, layout).filter((sample) => sample.layerId === 'upper')) {
          const start = sample.clipId === 'left' ? 0 : 1;
          const sourceIn = sample.clipId === 'left' ? 1 : 2;
          expect(sample.sourceFrame).toBe(sourceIn); // Repeated recorded image.
          expect(sample.sourcePosition).toBeCloseTo(sourceIn + (frame - start) / 3, 12);
          expect(sample.opacity).toBeCloseTo(0.35 + (0.4 * frame) / 3, 12);
          expect(sample.colour.temperature).toBeCloseTo(-0.8 + (1.7 * frame) / 3, 12);
          expect(sample.colour.tint).toBeCloseTo(0.6 - (1.3 * frame) / 3, 12);
        }
      }
      const a = sampleTimeline(project, 1).find((sample) => sample.clipId === 'left')!;
      const b = sampleTimeline(project, 2).find((sample) => sample.clipId === 'left')!;
      expect(a.sourceFrame).toBe(b.sourceFrame);
      expect(a.spatial).not.toEqual(b.spatial);
      const dissolve = sampleTimeline(project, 2).filter((sample) => sample.layerId === 'upper');
      expect(dissolve.map((sample) => sample.blendWeight)).toEqual([0.5, 0.5]);
      expect(dissolve[0]!.spatial).not.toEqual(dissolve[1]!.spatial);
      expect(dissolve[0]!.colour).toEqual(dissolve[1]!.colour);
      expect(sampleTimeline(project, 0).find((sample) => sample.clipId === 'left')!.brightness).toBe(0);
      expect(sampleTimeline(project, 3).find((sample) => sample.clipId === 'right')!.brightness).toBe(0);
      const work = await mkdtemp(path.join(root, 'compound-'));
      try {
        const losslessFile = await lossless(project, target, work);
        const job = startExport(project, profile, library);
        const completed = await jobs.wait(job.id);
        expect(completed.state, completed.message).toBe('completed');
        const directory = path.join(config.dataDir, 'renders', job.id);
        expect((await readdir(directory)).sort()).toEqual(['export.mp4', 'receipt.json']);
        const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')) as ExportReceipt;
        expect(receipt.snapshot).toEqual(captured);
        expect(receipt.settings.pipeline).toBe('sequential-layered');
        expect(receipt.settings.resources).toEqual(LAYERED_EXPORT_RESOURCES);
        expect(receipt.verification).toMatchObject({
          width: target.width,
          height: target.height,
          frameCount: 4,
          codec: 'h264',
          pixelFormat: 'yuv420p',
          colourRange: 'tv',
          fullDecode: true,
          faststart: true,
          hasAudio: false,
        });
        expect(receipt.settings.layered).not.toBeNull();
        resourceBounds(receipt.settings.layered!, target, project);
        await parity(project, target, losslessFile, path.join(directory, 'export.mp4'));
        expect(project).toEqual(captured);
        await unchanged();
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it('preserves exact neutral opaque/ungraded letterbox RGB and coverage over a lower row', async () => {
    const project = createProject('neutral-letterbox', 'Exact legacy neutral bytes');
    project.layers.push(createLayer('letterbox', 'Opaque neutral padding', true));
    const lower = createClip('lower', assets[0]!.id, 2, 3);
    const upper = createClip('neutral', assets[1]!.id, 1, 2, 'letterbox');
    // Neutral full-pose keys must enter layered export without changing identity.
    upper.spatial.keyframes = [
      { frame: 0, interpolation: 'smooth', values: pose() },
      { frame: 4, interpolation: 'hold', values: pose() },
    ];
    project.clips = [lower, upper];
    const captured = projectSchema.parse(project);
    const target = EXPORT_PROFILES.draft720;
    const work = await mkdtemp(path.join(root, 'legacy-'));
    try {
      const filename = await lossless(captured, target, work);
      await exactFrames(filename, target, 1);
      const groups = await referenceSources(captured, 0, target);
      const top = groups[1]![0]!;
      expect(top.neutral).toBe(true);
      expect(top.bounds.x).toBeGreaterThan(0);
      const raw = await frameBytes(filename, 0, target, true);
      const actual = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
      let mismatches = 0;
      for (let pixel = 0; pixel < target.width * target.height; pixel++) {
        if (actual[pixel * 4 + 3] !== 65535) mismatches++;
        for (let channel = 0; channel < 3; channel++)
          if (actual[pixel * 4 + channel] !== top.rgb[pixel * 3 + channel]! * 257) mismatches++;
      }
      expect(mismatches, 'Every legacy RGB byte, including opaque black padding, must remain exact').toBe(0);
      expect(Array.from(actual.subarray(360 * target.width * 4, 360 * target.width * 4 + 4))).toEqual([0, 0, 0, 65535]);
      await unchanged();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
