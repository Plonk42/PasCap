import { forEachSerial } from '../shared/serial.js';
import { REQUIRED_FFMPEG, type Toolchain } from '../shared/toolchain.js';
import type { ServiceConfig } from './config.js';
import { errorMessage } from './errors.js';
import { runProcess } from './process.js';

const TIMEOUT_MS = 10_000;

/** Output of one bounded run; failures read after the command's name, such as "was not found". */
async function run(command: string, args: string[]): Promise<string> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return (await runProcess(command, ['-hide_banner', ...args], { signal, maxBytes: 1024 * 1024 })).toString('utf8');
  } catch (error) {
    if (signal.aborted) throw new Error(`did not answer within ${TIMEOUT_MS / 1000} s`);
    const text = errorMessage(error);
    if (text.includes('ENOENT')) throw new Error('was not found');
    if (text.includes('EACCES')) throw new Error('is not executable');
    const reason = text.startsWith(`${command} `) ? text.slice(command.length + 1) : text;
    throw new Error(reason.length > 300 ? `${reason.slice(0, 299)}…` : reason);
  }
}

const VERSION_LINES = { ffmpeg: /^ffmpeg version (\S+)/m, ffprobe: /^ffprobe version (\S+)/m } as const;

/** The version a -version banner reports, such as 8.0.1-3ubuntu2. */
export function reportedVersion(output: string, program: keyof typeof VERSION_LINES): string | null {
  return VERSION_LINES[program].exec(output)?.[1] ?? null;
}

/**
 * Names that -encoders and -filters list after their flags (legend lines read "flags = meaning"), or that
 * -bsfs lists one per line; FFmpeg 6 prints no ------ line under its filter legend.
 */
export function listedNames(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split('\n').slice(1)) {
    const [first, second] = line.trim().split(/\s+/);
    if (!first) continue;
    if (second === undefined) names.add(first);
    else if (second !== '=') names.add(second);
  }
  return names;
}

async function version(command: string, program: keyof typeof VERSION_LINES): Promise<Toolchain['ffmpeg']> {
  try {
    const reported = reportedVersion(await run(command, ['-version']), program);
    return { command, version: reported, error: reported === null ? 'did not report its version' : null };
  } catch (error) {
    return { command, version: null, error: errorMessage(error) };
  }
}

const LISTS = { encoder: '-encoders', filter: '-filters', 'bitstream filter': '-bsfs' } as const;

/** Runs the configured ffmpeg and ffprobe once, serially: their versions and the required components FFmpeg lacks. */
export async function checkToolchain(config: Pick<ServiceConfig, 'ffmpeg' | 'ffprobe'>): Promise<Toolchain> {
  const ffmpeg = await version(config.ffmpeg, 'ffmpeg');
  const ffprobe = await version(config.ffprobe, 'ffprobe');
  const missing: string[] = [];
  await forEachSerial(Object.keys(LISTS) as (keyof typeof LISTS)[], async (kind) => {
    if (ffmpeg.error !== null) return;
    try {
      const names = listedNames(await run(config.ffmpeg, [LISTS[kind]]));
      missing.push(...REQUIRED_FFMPEG[kind].filter((name) => !names.has(name)).map((name) => `${name} ${kind}`));
    } catch (error) {
      ffmpeg.error = `${LISTS[kind]} failed: ${errorMessage(error)}`;
    }
  });
  return { ffmpeg, ffprobe, missing };
}
