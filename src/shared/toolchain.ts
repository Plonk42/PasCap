import { z } from 'zod';

/** The FFmpeg release native processing is qualified on; scripts/setup-ffmpeg.sh builds the same one. */
export const QUALIFIED_FFMPEG = '8.0.1';

/** What native processing and the native tests need from FFmpeg; scripts/setup-ffmpeg.sh verifies the same lists. */
export const REQUIRED_FFMPEG = {
  encoder: ['libx264', 'ffv1', 'aac', 'pcm_s16le'],
  filter: ['lut3d', 'xfade', 'setparams', 'testsrc2', 'sine', 'anullsrc'],
  'bitstream filter': ['setts'],
} as const;

const programSchema = z
  .object({
    /** The configured command: PASCAP_FFMPEG/PASCAP_FFPROBE, else the name looked up on PATH. */
    command: z.string(),
    /** As the program reports it, such as 8.0.1-3ubuntu2. */
    version: z.string().nullable(),
    /** Why it could not run or report its version. */
    error: z.string().nullable(),
  })
  .strict();

/** The service's startup check of its native toolchain. */
export const toolchainSchema = z
  .object({
    ffmpeg: programSchema,
    ffprobe: programSchema,
    /** Required components FFmpeg does not list, such as "libx264 encoder". */
    missing: z.array(z.string()),
  })
  .strict();
export type Toolchain = z.infer<typeof toolchainSchema>;

export interface ToolchainNotice {
  severity: 'error' | 'warning';
  message: string;
}

/** The release a version names: 8.0.1 for 8.0.1-3ubuntu2 or n8.0.1, null for a development snapshot. */
export function toolchainRelease(version: string | null): string | null {
  return /^n?(\d+(?:\.\d+)*)(?:$|[^\d.])/.exec(version ?? '')?.[1] ?? null;
}

function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const ACTION = `Build FFmpeg ${QUALIFIED_FFMPEG} with npm run setup:ffmpeg and point PASCAP_FFMPEG and PASCAP_FFPROBE at it.`;
const PROGRAMS = { ffmpeg: 'FFmpeg', ffprobe: 'ffprobe' } as const;

/** What the editor and the service log say about the toolchain, or null when it is the qualified one. */
export function toolchainNotice(toolchain: Toolchain): ToolchainNotice | null {
  const programs = (Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[]).map((key) => ({
    ...toolchain[key],
    name: PROGRAMS[key],
  }));
  const failures = programs.flatMap(({ command, error }) => (error === null ? [] : [`${command} ${error}`]));
  if (failures.length)
    return {
      severity: 'error',
      message: `FFmpeg cannot run: ${failures.join('; ')}. Recordings cannot be prepared or exported; saved projects still open. ${ACTION}`,
    };
  if (toolchain.missing.length)
    return {
      severity: 'error',
      message: `FFmpeg ${toolchain.ffmpeg.version} lacks the ${listed(toolchain.missing)}: preparing recordings or exporting can fail. ${ACTION}`,
    };
  const unqualified = programs.flatMap(({ name, version }) =>
    toolchainRelease(version) === QUALIFIED_FFMPEG ? [] : [`${name} ${version}`],
  );
  if (unqualified.length)
    return {
      severity: 'warning',
      message: `${listed(unqualified)} ${unqualified.length > 1 ? 'are' : 'is'} not the tested ${QUALIFIED_FFMPEG}: preparation and export may differ or fail. ${ACTION}`,
    };
  return null;
}
