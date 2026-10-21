import os from 'node:os';
import path from 'node:path';

export interface ServiceConfig {
  dataDir: string;
  mediaRoots: string[];
  webDir: string;
  port: number;
  ffmpeg: string;
  ffprobe: string;
  /** Browser for the export GPU compositor; null searches PATH for Chrome or Chromium. */
  chrome: string | null;
  /** Composite detail/HDR export groups on the GPU when a hardware renderer starts. */
  gpuCompositing: boolean;
  /** Decode undamaged originals for proxy encodes with NVDEC when a CUDA device starts. */
  hardwareDecode: boolean;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  /** Largest pictures the assistant operations render. */
  assistantImages: AssistantImageBudget;
  assistantSessions: AssistantSessionLimits;
}

export interface AssistantSessionLimits {
  /** A session ends after this long without assistant activity; null keeps it until the user or assistant ends it. */
  leaseMs: number | null;
  /** Checkpoints kept per project, oldest removed first. */
  checkpoints: number;
}

export interface AssistantImageBudget {
  /** Width of a single still or crop, in pixels. */
  stillWidth: number;
  /** Width of each cell of a contact sheet. */
  sheetCellWidth: number;
  /** Frames per contact sheet. */
  sheetCells: number;
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const setting = process.env[name];
  const value = setting === undefined ? fallback : Number(setting);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function leaseMs(minutes: number): number | null {
  return minutes === 0 ? null : minutes * 60_000;
}

/** Conservative defaults keep each picture cheap for a model; raise them in the environment. */
function assistantImageBudget(): AssistantImageBudget {
  return {
    stillWidth: integerSetting('PASCAP_ASSISTANT_STILL_WIDTH', 480, 160, 1280),
    sheetCellWidth: integerSetting('PASCAP_ASSISTANT_SHEET_CELL_WIDTH', 240, 96, 640),
    sheetCells: integerSetting('PASCAP_ASSISTANT_SHEET_CELLS', 16, 1, 24),
  };
}

function validateMediaRoots(value: unknown): string[] {
  const issue =
    'PASCAP_MEDIA_ROOTS must be a JSON array of at most 32 unique absolute paths, each 1–4096 characters without NUL.';
  if (!Array.isArray(value) || value.length > 32) throw new Error(issue);
  const roots: string[] = [];
  for (const directory of value) {
    if (
      typeof directory !== 'string' ||
      directory.length === 0 ||
      directory.length > 4096 ||
      directory.includes('\0') ||
      !path.isAbsolute(directory)
    )
      throw new Error(issue);
    const normalised = path.resolve(directory);
    if (roots.includes(normalised)) throw new Error(issue);
    roots.push(normalised);
  }
  return roots;
}

function configuredMediaRoots(): string[] {
  const setting = process.env['PASCAP_MEDIA_ROOTS'];
  if (setting === undefined) return [path.join(os.homedir(), 'Videos')];
  let value: unknown;
  try {
    value = JSON.parse(setting);
  } catch {
    throw new Error('PASCAP_MEDIA_ROOTS must be a JSON array of absolute paths.');
  }
  return validateMediaRoots(value);
}

export function createConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const port = Number(process.env['PASCAP_PORT'] ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PASCAP_PORT must be an unprivileged port.');
  const origins = [port, 5173].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
  const mediaRoots =
    overrides.mediaRoots === undefined ? configuredMediaRoots() : validateMediaRoots(overrides.mediaRoots);
  const gpu = process.env['PASCAP_GPU_COMPOSITING'] ?? 'auto';
  if (gpu !== 'auto' && gpu !== 'off') throw new Error('PASCAP_GPU_COMPOSITING must be auto or off.');
  const decode = process.env['PASCAP_HW_DECODE'] ?? 'auto';
  if (decode !== 'auto' && decode !== 'off') throw new Error('PASCAP_HW_DECODE must be auto or off.');
  return {
    dataDir: path.resolve(process.env['PASCAP_DATA_DIR'] ?? '.pascap'),
    webDir: path.resolve('dist/web'),
    port,
    ffmpeg: process.env['PASCAP_FFMPEG'] ?? 'ffmpeg',
    ffprobe: process.env['PASCAP_FFPROBE'] ?? 'ffprobe',
    chrome: process.env['PASCAP_CHROME'] || null,
    gpuCompositing: gpu === 'auto',
    hardwareDecode: decode === 'auto',
    allowedOrigins: new Set(origins),
    allowedHosts: new Set(origins.map((origin) => new URL(origin).host)),
    assistantImages: assistantImageBudget(),
    assistantSessions: {
      leaseMs: leaseMs(integerSetting('PASCAP_ASSISTANT_LEASE_MINUTES', 0, 0, 1440)),
      checkpoints: integerSetting('PASCAP_ASSISTANT_CHECKPOINTS', 5, 1, 50),
    },
    ...overrides,
    mediaRoots,
  };
}
