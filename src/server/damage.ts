import type { DamagedRange, MediaAsset } from '../shared/media.js';
import { framesToSeconds } from '../shared/timing.js';
import type { ServiceConfig } from './config.js';
import { runProcess } from './process.js';

async function videoPackets(
  config: ServiceConfig,
  filename: string,
  signal: AbortSignal,
): Promise<{ frame: number; keyframe: boolean }[]> {
  const output = await runProcess(
    config.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', filename],
    { signal },
  );
  const period = framesToSeconds(1);
  return output
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [time, flags] = line.split(',');
      return { frame: Math.round(Number(time) / period), keyframe: flags?.startsWith('K') === true };
    });
}

/**
 * Each frame missing from the proxy damages its whole group of pictures: the
 * decoder silently conceals the frames around an undecodable one, keyframe included.
 */
export function damagedRanges(
  missing: readonly number[],
  keyframes: readonly number[],
  frameCount: number,
): DamagedRange[] {
  const sorted = [...keyframes].sort((a, b) => a - b);
  const ranges: DamagedRange[] = [];
  for (const frame of [...missing].sort((a, b) => a - b)) {
    const next = sorted.findIndex((keyframe) => keyframe > frame);
    const start = (next < 0 ? sorted.at(-1) : sorted[next - 1]) ?? 0;
    const end = next < 0 ? frameCount : sorted[next]!;
    const last = ranges.at(-1);
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

/** Original frames the passthrough proxy lacks, extended to their groups of pictures. */
export async function findDamage(
  config: ServiceConfig,
  original: string,
  proxy: string,
  frameCount: number,
  signal: AbortSignal,
): Promise<{ missing: number; damage: DamagedRange[] }> {
  const present = new Set((await videoPackets(config, proxy, signal)).map((packet) => packet.frame));
  const missing: number[] = [];
  for (let frame = 0; frame < frameCount; frame++) if (!present.has(frame)) missing.push(frame);
  if (!missing.length) return { missing: 0, damage: [] };
  const keyframes = (await videoPackets(config, original, signal))
    .filter((packet) => packet.keyframe)
    .map((packet) => packet.frame);
  return { missing: missing.length, damage: damagedRanges(missing, keyframes, frameCount) };
}

/** Whether any picture comes after a later one in decode order (B-frames). */
export async function hasReorderedFrames(
  config: ServiceConfig,
  original: string,
  signal: AbortSignal,
): Promise<boolean> {
  const packets = await videoPackets(config, original, signal);
  return packets.some((packet, index) => index > 0 && packet.frame < packets[index - 1]!.frame);
}

/**
 * Input options for decoding an accepted damaged original. After a hole the decoder can
 * output a stale picture whose timestamp goes backwards; FFmpeg then labels every later
 * frame from packet decode timestamps, which DJI files offset by one frame. Without
 * them it keeps the pictures' own timestamps, so frames stay at their positions.
 */
export function repairInputArgs(damage: readonly DamagedRange[]): string[] {
  return damage.length ? ['-bsf:v', 'setts=dts=NOPTS'] : [];
}

/** Strict decoding, unless the original's damage was found and accepted at preparation. */
export function originalErrorArgs(asset: Pick<MediaAsset, 'damage'>): string[] {
  return asset.damage.length ? repairInputArgs(asset.damage) : ['-xerror', '-err_detect', 'explode'];
}

/**
 * Filter prefix for a decode whose first output is original frame `first`:
 * refills the frames the decoder drops (so frame counts stay exact) and blacks
 * out every damaged range. Empty for undamaged originals.
 */
export function repairFilter(damage: readonly DamagedRange[], first: number): string {
  if (!damage.length) return '';
  const enable = damage.map((range) => `between(n,${range.start - first},${range.end - 1 - first})`).join('+');
  return `fps=30000/1001:start_time=0,tpad=stop=-1:stop_mode=clone,drawbox=c=black:t=fill:enable='${enable}',`;
}
