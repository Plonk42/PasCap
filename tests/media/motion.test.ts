import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig, type ServiceConfig } from '../../src/server/config.js';
import { runProcess } from '../../src/server/process.js';
import type { MediaJob } from '../../src/shared/media.js';
import { motionRoughness, smoothRanges, type MotionAnalysis } from '../../src/shared/motion-analysis.js';
import { PROJECT_FPS } from '../../src/shared/timing.js';

const FPS = PROJECT_FPS.numerator / PROJECT_FPS.denominator;

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const headers = { host: '127.0.0.1:4318', 'x-pascap-client': 'preview-lab' };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-motion-native-'));
  roots.push(root);
  const sources = path.join(root, 'sources');
  await mkdir(sources);
  const config = createConfig({
    dataDir: path.join(root, 'cache'),
    webDir: path.join(root, 'absent-web'),
    port: 4318,
    allowedHosts: new Set(['127.0.0.1:4318']),
    allowedOrigins: new Set(['http://127.0.0.1:4318']),
  });
  const service = await createApp(config);
  services.push(service);
  return { sources, ...service };
}

/** 2 s held still, then a steady 4 px/frame pan to the right across a textured synthetic pattern. */
async function pan(config: ServiceConfig, filename: string): Promise<void> {
  await runProcess(config.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    "color=c=gray:s=1280x720:r=30000/1001,format=yuv420p,geq=lum='128+50*sin(X/7.3+Y/31)+40*sin(Y/5.1-X/23)+30*sin((X+Y)/13.7)':cb=128:cr=128",
    '-frames:v',
    '210',
    '-vf',
    "crop=640:360:x='if(lt(n,60),0,4*(n-60))':y=100,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=limited",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
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
}

function median(values: readonly (number | null)[]): number {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

describe.skipIf(!enabled)('smooth-part motion analysis · disposable native fixture', () => {
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('measures the proxy once, caches it next to the proxy and suggests the steady pan', async () => {
    const { sources, config, app, library, jobs } = await fixture();
    const filename = path.join(sources, 'pan.mp4');
    await pan(config, filename);
    const original = await readFile(filename);

    const early = await library.addForEditing(filename);
    const id = early.asset.id;
    const unprepared = await app.inject({ method: 'POST', url: `/api/media/${id}/motion`, headers, payload: {} });
    expect(unprepared.statusCode).toBe(409);
    const prepared = await jobs.wait(early.job!.id);
    expect(prepared.state).toBe('completed');
    expect(prepared.message).toBe('Complete');

    const response = await app.inject({ method: 'GET', url: `/api/media/${id}/motion`, headers });
    const { analysis } = response.json<{ analysis: MotionAnalysis }>();
    expect(analysis.frameCount).toBe(210);
    expect(analysis.verifiedAt).toBe(library.get(id).prepared!.verification.verifiedAt);
    expect(analysis.tx[0]).toBeNull();
    // 4 px/frame at 640 px is 2 analysis pixels; the picture moves left as the view pans right.
    expect(Math.abs(median(analysis.tx.slice(5, 55)))).toBeLessThan(0.1);
    expect(median(analysis.tx.slice(70, 205))).toBeCloseTo(-2, 0);
    expect(Math.abs(median(analysis.ty.slice(70, 205)))).toBeLessThan(0.2);
    const cache = library.motionPath(library.get(id));
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual(analysis);

    const [best] = smoothRanges(motionRoughness(analysis, FPS), 2, FPS);
    expect(best!.sourceIn).toBeGreaterThanOrEqual(60);
    expect(best!.sourceIn).toBeLessThan(95);
    expect(best!.sourceOut).toBe(210);

    // A proxy prepared before the analysis existed is measured on request, once at a time.
    await rm(cache);
    expect((await app.inject({ method: 'GET', url: `/api/media/${id}/motion`, headers })).json()).toEqual({
      analysis: null,
    });
    const started = await app.inject({ method: 'POST', url: `/api/media/${id}/motion`, headers, payload: {} });
    expect(started.statusCode).toBe(202);
    const job = started.json<{ job: MediaJob }>().job;
    expect(job.kind).toBe('motion');
    const again = await app.inject({ method: 'POST', url: `/api/media/${id}/motion`, headers, payload: {} });
    expect(again.json<{ job: MediaJob }>().job.id).toBe(job.id);
    const finished = await jobs.wait(job.id);
    expect(finished.state, finished.message).toBe('completed');
    expect(JSON.parse(await readFile(cache, 'utf8'))).toEqual(analysis);
    expect(await readFile(filename)).toEqual(original);
  });
});
