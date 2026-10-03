import { z } from 'zod';
import { metadataSchema, type VideoMetadata } from '../shared/media.js';
import { framesToSeconds, parseRate, PROJECT_FPS, sameRate } from '../shared/timing.js';
import type { ServiceConfig } from './config.js';
import { ServiceError } from './errors.js';
import { runProcess } from './process.js';

const streamSchema = z.looseObject({
  codec_type: z.string(), codec_name: z.string().optional(),
  width: z.number().optional(), height: z.number().optional(), pix_fmt: z.string().optional(),
  r_frame_rate: z.string(), avg_frame_rate: z.string(), time_base: z.string(),
  nb_frames: z.string().optional(), duration_ts: z.number().optional(), start_pts: z.number().optional(),
  color_range: z.string().optional(), color_space: z.string().optional(),
  color_transfer: z.string().optional(), color_primaries: z.string().optional(),
  side_data_list: z.array(z.looseObject({ rotation: z.number().optional() })).optional(),
});
const probeSchema = z.looseObject({ streams: z.array(streamSchema) });

export async function inspectStreams(config: ServiceConfig, filename: string, signal?: AbortSignal): Promise<z.infer<typeof probeSchema>> {
  const options = signal ? { signal } : {};
  const output = await runProcess(config.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', filename], options);
  return probeSchema.parse(JSON.parse(output.toString('utf8')));
}

/** Header agreement plus every video packet's PTS/duration. Ambiguous sources fail. */
export async function probeVideo(config: ServiceConfig, filename: string, signal?: AbortSignal): Promise<VideoMetadata> {
  const probe = await inspectStreams(config, filename, signal);
  const videos = probe.streams.filter((stream) => stream.codec_type === 'video');
  if (videos.length !== 1) throw new ServiceError('Exactly one video stream is supported.', 422);
  const video = videos[0]!;
  const average = parseRate(video.avg_frame_rate);
  const nominal = parseRate(video.r_frame_rate);
  if (!sameRate(average, PROJECT_FPS) || !sameRate(nominal, PROJECT_FPS)) throw new ServiceError('Only constant 30000/1001 fps footage is accepted in this prototype.', 422);
  const frameCount = Number(video.nb_frames);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || video.duration_ts === undefined || video.start_pts !== 0) throw new ServiceError('Ambiguous frame count, duration or non-zero source start timestamp.', 422);
  const timeBase = parseRate(video.time_base);
  const duration = video.duration_ts * timeBase.numerator / timeBase.denominator;
  if (Math.abs(duration - framesToSeconds(frameCount)) > 1e-5) throw new ServiceError('Frame count and source timestamps disagree; variable/ambiguous timing is unsupported.', 422);
  if (video.side_data_list?.some((data) => data.rotation !== undefined && data.rotation !== 0)) throw new ServiceError('Rotated recordings are not supported in the initial landscape prototype.', 422);
  if (video.color_space !== 'bt709' || video.color_transfer !== 'bt709' || video.color_primaries !== 'bt709' || !['tv', 'pc'].includes(video.color_range ?? '')) throw new ServiceError('Explicit SDR BT.709 primaries, transfer, matrix and range are required; HDR/untagged footage is unsupported.', 422);
  if (video.pix_fmt !== 'yuv420p') throw new ServiceError('Initial source support is 8-bit yuv420p SDR. Other pixel formats are not silently converted.', 422);
  await verifyPacketTiming(config, filename, frameCount, signal);
  return metadataSchema.parse({
    width: video.width, height: video.height, codec: video.codec_name, pixelFormat: video.pix_fmt,
    frameRate: { ...PROJECT_FPS }, frameCount, durationSeconds: duration,
    colourPrimaries: video.color_primaries, colourTransfer: video.color_transfer, colourSpace: video.color_space,
    colourRange: video.color_range, hasAudio: probe.streams.some((stream) => stream.codec_type === 'audio'),
  });
}

export async function verifyPacketTiming(config: ServiceConfig, filename: string, frameCount: number, signal?: AbortSignal): Promise<void> {
  const output = await runProcess(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filename], signal ? { signal } : {});
  const packets = output.toString('utf8').trim().split('\n');
  if (packets.length !== frameCount) throw new ServiceError('Packet count does not match the source frame count.', 422);
  const period = framesToSeconds(1);
  const seen = new Set<number>();
  for (const packet of packets) {
    const [ptsText, durationText] = packet.split(',');
    const timestamp = Number(ptsText); const duration = Number(durationText);
    const frame = Math.round(timestamp / period);
    if (!Number.isFinite(timestamp) || Math.abs(timestamp / period - frame) > 0.0001 || frame < 0 || frame >= frameCount || seen.has(frame)) throw new ServiceError('Video presentation timestamps are not unique consecutive project frames.', 422);
    if (!Number.isFinite(duration) || Math.abs(duration - period) > 2e-6) throw new ServiceError('Video packet durations are not constant project frames.', 422);
    seen.add(frame);
  }
}