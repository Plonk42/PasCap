import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { generateCube } from '../shared/colour.js';
import type { MediaJob } from '../shared/media.js';
import { projectSchema, type ProjectDocument } from '../shared/model.js';
import { blackFadeParts, calculateLayout } from '../shared/timeline.js';
import { framesToSeconds, PROJECT_FPS, sameRate } from '../shared/timing.js';
import { ServiceError } from './errors.js';
import { assertSourceIdentity } from './files.js';
import type { JobContext } from './jobs.js';
import type { MediaLibrary } from './library.js';
import { probeVideo } from './probe.js';
import { runProcess } from './process.js';
import { atomicWrite } from './storage.js';

/** Endpoint-inclusive black fades. A one-frame fade is exactly black. */
export function nativeFadeFilters(length: number, fadeIn: number, fadeOut: number): string[] {
  const filters: string[] = [];
  if (fadeIn > 1) filters.push(`fade=t=in:start_frame=0:nb_frames=${fadeIn - 1}:color=black`);
  if (fadeIn === 1) filters.push("drawbox=color=black:t=fill:enable='eq(n,0)'");
  if (fadeOut > 1) filters.push(`fade=t=out:start_frame=${length - fadeOut}:nb_frames=${fadeOut - 1}:color=black`);
  if (fadeOut === 1) filters.push(`drawbox=color=black:t=fill:enable='eq(n,${length - 1})'`);
  return filters;
}

export function validateReference(project: ProjectDocument, library: MediaLibrary): ProjectDocument {
  const snapshot = projectSchema.parse(project);
  if (!sameRate(snapshot.frameRate, PROJECT_FPS)) throw new ServiceError('The prototype reference rate must be 30000/1001.');
  if (snapshot.clips.length !== 2 || snapshot.music !== null) throw new ServiceError('The feasibility reference supports exactly two video clips and no music. This is not the final exporter.');
  if (snapshot.layers.length !== 1 || snapshot.layers.some((layer) => !layer.enabled || layer.opacity !== 1 || layer.keyframes.length > 0) ||
    snapshot.clips.some((clip) => clip.opacity !== 1)) {
    throw new ServiceError('The diagnostic reference does not support video layers, opacity or shared project-frame layer points (including speed). Use Export.');
  }
  if (snapshot.clips.some((clip) => clip.speed.mode !== 'constant' || clip.speed.rate !== 1)) throw new ServiceError('The diagnostic reference only supports normal speed. Use Export for retimed clips.');
  if (calculateLayout(snapshot).duration > 3600) throw new ServiceError('Lab references are limited to 3,600 project frames (about two minutes).');
  for (const clip of snapshot.clips) {
    const asset = library.get(clip.mediaId);
    if (clip.sourceOut > asset.metadata.frameCount) throw new ServiceError(`Clip ${clip.id} exceeds its registered source frame count.`);
  }
  return snapshot;
}

export function startReference(project: ProjectDocument, library: MediaLibrary): MediaJob {
  const snapshot = validateReference(project, library);
  return library.jobs.submit('reference', `${snapshot.title} · 720p reference`, async (context) => {
    await renderReference(snapshot, library, context);
    library.jobs.setOutput(context.id, `/api/jobs/${context.id}/reference`, `/api/jobs/${context.id}/receipt`);
  });
}

export async function renderReference(snapshot: ProjectDocument, library: MediaLibrary, context: JobContext): Promise<void> {
  snapshot = validateReference(snapshot, library);
  const layout = calculateLayout(snapshot);
  const directory = path.join(library.config.dataDir, 'renders', context.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const partial = path.join(directory, 'reference.partial.mp4');
  try {
    const assets = snapshot.clips.map((clip) => library.get(clip.mediaId));
    for (const asset of assets) await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true); // NOSONAR -- read-only checks are deliberately serial.
    context.update(0.01, 'Generating 65³ LUTs from the CPU colour contract');
    for (const [index, clip] of snapshot.clips.entries()) await atomicWrite(path.join(directory, `clip-${index}.cube`), generateCube(clip.colour)); // NOSONAR -- bound CPU LUT generation to one at a time.
    const transition = snapshot.transitions[0]!;
    const black = transition.type === 'fade-through-black' ? blackFadeParts(transition.duration) : { out: 0, in: 0 };
    const chains = snapshot.clips.map((clip, index) => {
      const fadeIn = index === 0 ? snapshot.openingFade : black.in;
      const fadeOut = index === 1 ? snapshot.closingFade : black.out;
      const range = assets[index]!.metadata.colourRange;
      return `[${index}:v]trim=start_frame=${clip.sourceIn}:end_frame=${clip.sourceOut},setpts=PTS-STARTPTS,` +
        `scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=${range}:out_range=pc,` +
        `format=gbrp,lut3d=file=clip-${index}.cube:interp=tetrahedral,` +
        [...nativeFadeFilters(clip.sourceOut - clip.sourceIn, fadeIn, fadeOut), 'pad=1280:720:(ow-iw)/2:(oh-ih)/2:black', 'setsar=1', 'settb=expr=1/30000', 'setpts=N*1001'].join(',') + `[clip${index}]`;
    });
    const outputConversion = 'scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv420p';
    if (transition.type === 'cross-dissolve') {
      const duration = framesToSeconds(transition.duration).toFixed(9);
      const offset = framesToSeconds(layout.clips[1]!.start).toFixed(9);
      chains.push(`[clip0][clip1]xfade=transition=fade:duration=${duration}:offset=${offset},trim=end_frame=${layout.duration},setpts=N*1001,${outputConversion}[out]`);
    } else chains.push(`[clip0][clip1]concat=n=2:v=1:a=0,${outputConversion}[out]`);
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      ...assets.flatMap((asset) => ['-threads', '2', '-i', asset.sourcePath]),
      '-filter_complex_threads', '2', '-filter_complex', chains.join(';'), '-map', '[out]', '-an',
      '-frames:v', String(layout.duration), '-r', '30000/1001', '-fps_mode', 'cfr',
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      '-movflags', '+faststart', '-video_track_timescale', '30000', '-progress', 'pipe:1', partial,
    ];
    context.update(0.05, 'Rendering from original footage, not proxies');
    // Relative LUT names avoid FFmpeg filter-language escaping of user paths.
    await runReferenceProcess(library, directory, args, context, layout.duration);
    context.update(0.94, 'Verifying dimensions, frame count and SDR metadata');
    const verification = await probeVideo(library.config, partial, context.signal);
    if (verification.width !== 1280 || verification.height !== 720 || verification.codec !== 'h264' || verification.frameCount !== layout.duration || verification.hasAudio) throw new ServiceError('Reference verification failed: dimensions, frame count, codec or audio differs from the snapshot.', 422);
    await runProcess(library.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-xerror', '-threads', '2', '-i', partial, '-map', '0:v:0', '-an', '-f', 'null', '-'], { signal: context.signal });
    for (const asset of assets) await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true); // NOSONAR -- verify original identities before publication.
    await atomicWrite(path.join(directory, 'receipt.json'), `${JSON.stringify({
      kind: 'feasibility-reference', schemaVersion: 1, createdAt: new Date().toISOString(),
      project: snapshot, sources: assets.map((asset) => ({ id: asset.id, fingerprint: asset.fingerprint })),
      settings: { width: 1280, height: 720, codec: 'h264', crf: 18, lutSize: 65, interpolation: 'tetrahedral', threadsPerDecoder: 2, filterThreads: 2 },
      filterGraph: chains.join(';'), arguments: args, verification,
    }, null, 2)}\n`);
    await rename(partial, path.join(directory, 'reference.mp4'));
    context.update(0.99, 'Reference verified');
  } finally { await rm(partial, { force: true }); }
}

async function runReferenceProcess(library: MediaLibrary, directory: string, args: string[], context: JobContext, totalFrames: number): Promise<void> {
  await runProcess(library.config.ffmpeg, args, {
    signal: context.signal,
    cwd: directory,
    onProgress: (fields) => {
      const frame = Number(fields['frame']);
      if (Number.isFinite(frame)) context.update(0.05 + 0.88 * Math.min(1, frame / totalFrames), `Rendering frame ${frame} / ${totalFrames}`);
    },
  });
}