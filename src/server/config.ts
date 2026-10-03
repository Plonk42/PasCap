import os from 'node:os';
import path from 'node:path';

export interface ServiceConfig {
  dataDir: string;
  mediaRoots: string[];
  webDir: string;
  port: number;
  ffmpeg: string;
  ffprobe: string;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
}

function validateMediaRoots(value: unknown): string[] {
  const issue = 'PASCAP_MEDIA_ROOTS must be a JSON array of at most 32 unique absolute paths, each 1–4096 characters without NUL.';
  if (!Array.isArray(value) || value.length > 32) throw new Error(issue);
  const roots: string[] = [];
  for (const directory of value) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)) throw new Error(issue);
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
  try { value = JSON.parse(setting); }
  catch { throw new Error('PASCAP_MEDIA_ROOTS must be a JSON array of absolute paths.'); }
  return validateMediaRoots(value);
}

export function createConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const port = Number(process.env['PASCAP_PORT'] ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PASCAP_PORT must be an unprivileged port.');
  const origins = [port, 5173].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
  const mediaRoots = overrides.mediaRoots === undefined ? configuredMediaRoots() : validateMediaRoots(overrides.mediaRoots);
  return {
    dataDir: path.resolve(process.env['PASCAP_DATA_DIR'] ?? '.pascap'),
    webDir: path.resolve('dist/web'), port,
    ffmpeg: process.env['PASCAP_FFMPEG'] ?? 'ffmpeg',
    ffprobe: process.env['PASCAP_FFPROBE'] ?? 'ffprobe',
    allowedOrigins: new Set(origins),
    allowedHosts: new Set(origins.map((origin) => new URL(origin).host)),
    ...overrides,
    mediaRoots,
  };
}