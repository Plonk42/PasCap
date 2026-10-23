import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../src/server/errors.js';
import { ColourLutCache } from '../../src/server/layered-colour.js';
import { runProcess } from '../../src/server/process.js';
import {
  composeProjectFrame,
  cropRgb8,
  proxyFrameArgs,
  rgba16ToRgb8,
  sheetGrid,
  STILL_SIZE,
  StillRenderer,
} from '../../src/server/stills.js';
import { createColourSettings } from '../../src/shared/colour.js';
import { compositePixel } from '../../src/shared/composition.js';
import type { MediaAsset, MediaJob } from '../../src/shared/media.js';
import { createClip, createLayer, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout, sampleTimeline } from '../../src/shared/timeline.js';

vi.mock('../../src/server/process.js', () => ({ runProcess: vi.fn() }));

const PIXELS = STILL_SIZE.width * STILL_SIZE.height;
const signal = new AbortController().signal;

function asset(id: string, width = 1280, height = 720): MediaAsset {
  return {
    id,
    name: `${id}.mp4`,
    metadata: { width, height, frameCount: 300, colourRange: 'tv' },
    status: 'ready',
    prepared: {},
  } as unknown as MediaAsset;
}

function pattern(mediaId: string, sourceFrame: number, pixel: number, channel: number): number {
  return (pixel * (31 + channel * 17) + sourceFrame * 7 + mediaId.charCodeAt(4) * 53) % 256;
}

async function decode(media: MediaAsset, sourceFrame: number): Promise<Buffer> {
  const rgb = Buffer.alloc(PIXELS * 3);
  for (let pixel = 0; pixel < PIXELS; pixel++)
    for (let channel = 0; channel < 3; channel++)
      rgb[pixel * 3 + channel] = pattern(media.id, sourceFrame, pixel, channel);
  return rgb;
}

function clip(id: string, mediaId: string, layerId: string, start: number, sourceOut: number) {
  return { ...createClip(id, mediaId, 0, sourceOut, layerId), start };
}

function context(read: (media: MediaAsset, sourceFrame: number) => Promise<Buffer>) {
  return { assetOf: (id: string) => asset(id), decode: read, cache: new ColourLutCache(), signal };
}

/** Track 1: A dissolving into B; track 2 above at Opacity 0.6 with Exposure 0.5. */
function dissolveProject(): ProjectDocument {
  const base = createProject('stills', 'Stills');
  const overlay = {
    ...createLayer('video-2', 'Overlay'),
    opacity: 0.6,
    colour: { ...createColourSettings(), exposure: 0.5 },
  };
  return projectSchema.parse({
    ...base,
    layers: [
      { ...base.layers[0]!, transitions: [{ leftId: 'a', rightId: 'b', type: 'cross-dissolve', duration: 20 }] },
      overlay,
    ],
    clips: [
      clip('a', 'rec-a', 'video-1', 0, 60),
      clip('b', 'rec-b', 'video-1', 40, 60),
      clip('c', 'rec-c', 'video-2', 0, 100),
    ],
  });
}

afterEach(() => {
  vi.mocked(runProcess).mockReset();
});

describe('project stills', () => {
  it('composes tracks bottom to top like the export, through a dissolve and track Opacity', async () => {
    const document = dissolveProject();
    const layout = calculateLayout(document);
    const composed = await composeProjectFrame(document, layout, 50, context(decode));
    const output = new Uint16Array(composed.buffer, composed.byteOffset, PIXELS * 4);
    const samples = sampleTimeline(document, 50, layout);
    expect(samples.map((sample) => [sample.clipId, sample.blendWeight])).toEqual([
      ['a', 0.5],
      ['b', 0.5],
      ['c', 1],
    ]);
    let error = 0;
    const checked = Array.from({ length: 400 }, (_, index) => (index * 2_311) % PIXELS);
    for (const pixel of checked) {
      const expected = compositePixel(samples, (sample) => [
        pattern(sample.mediaId, sample.sourceFrame, pixel, 0) / 255,
        pattern(sample.mediaId, sample.sourceFrame, pixel, 1) / 255,
        pattern(sample.mediaId, sample.sourceFrame, pixel, 2) / 255,
      ]);
      for (let channel = 0; channel < 3; channel++)
        error += Math.abs(output[pixel * 4 + channel]! / 65535 - expected[channel]!) * 255;
      expect(output[pixel * 4 + 3]).toBe(65535);
    }
    expect(error / (checked.length * 3)).toBeLessThan(2);
  });

  it('composes the Original image without Colour and Detail, keeping Opacity and dissolves', async () => {
    const graded = dissolveProject();
    const detailed = {
      ...graded,
      clips: graded.clips.map((item) => ({ ...item, detail: { sharpen: 1, clarity: 0.5, denoise: 0 } })),
    };
    const plain = projectSchema.parse({
      ...graded,
      layers: graded.layers.map((layer) => ({ ...layer, colour: createColourSettings() })),
    });
    const layout = calculateLayout(graded);
    const original = await composeProjectFrame(detailed, layout, 50, { ...context(decode), ungraded: true });
    expect(original.equals(await composeProjectFrame(plain, layout, 50, context(decode)))).toBe(true);
    expect(original.equals(await composeProjectFrame(graded, layout, 50, context(decode)))).toBe(false);
  });

  it('draws a transition timeslot as opaque black geometry without decoding it', async () => {
    const base = createProject('slots', 'Slots');
    const document = projectSchema.parse({
      ...base,
      layers: [
        base.layers[0]!,
        {
          ...createLayer('video-2', 'Overlay'),
          transitions: [{ leftId: 'p', rightId: 'q', type: 'fade-black-pause', fade: 4, pause: 10 }],
        },
      ],
      clips: [
        clip('l', 'rec-l', 'video-1', 0, 200),
        clip('p', 'rec-p', 'video-2', 0, 30),
        clip('q', 'rec-q', 'video-2', 40, 30),
      ],
    });
    const layout = calculateLayout(document);
    const decoded: string[] = [];
    const counting = async (media: MediaAsset, frame: number) => {
      decoded.push(media.id);
      return decode(media, frame);
    };
    const pause = rgba16ToRgb8(await composeProjectFrame(document, layout, 35, context(counting)));
    expect(decoded).toEqual(['rec-l']);
    expect(pause.every((value) => value === 0)).toBe(true);
    const shown = rgba16ToRgb8(await composeProjectFrame(document, layout, 10, context(decode)));
    expect(shown.some((value) => value > 0)).toBe(true);
  });

  it('decodes exactly one proxy frame a quarter frame early, fitted and padded like the export', () => {
    const args = proxyFrameArgs('/cache/proxy.mp4', asset('rec-a', 1440, 1080), 30);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '0.992658333']);
    expect(args[args.indexOf('-vf') + 1]).toBe(
      'scale=960:720:flags=bicubic:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,' +
        'format=rgb24,pad=1280:720:160:0:black,setsar=1',
    );
    expect(proxyFrameArgs('/cache/proxy.mp4', asset('rec-a'), 0)).not.toContain('-ss');
  });

  it('crops 1:1 and lays sheets out as square as possible', () => {
    const frame = Buffer.alloc(PIXELS * 3);
    frame[(10 * STILL_SIZE.width + 20) * 3] = 200;
    const crop = cropRgb8(frame, { x: 20, y: 10, width: 4, height: 2 });
    expect(crop).toHaveLength(24);
    expect(crop[0]).toBe(200);
    expect(() => cropRgb8(frame, { x: 1200, y: 0, width: 100, height: 10 })).toThrow(/within the 1280 × 720/);
    expect([1, 2, 4, 5, 9, 10].map(sheetGrid)).toEqual([
      { columns: 1, rows: 1 },
      { columns: 2, rows: 1 },
      { columns: 2, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 3 },
      { columns: 4, rows: 3 },
    ]);
  });
});

describe('still renderer bounds', () => {
  const library = { get: (id: string) => asset(id), proxyPath: () => '/cache/proxy.mp4' };
  const budget = { stillWidth: 480, sheetCellWidth: 240, sheetCells: 9 };

  it('refuses pictures while an export renders', () => {
    const jobs = { list: () => [{ kind: 'export', state: 'running', label: 'Flight · 4K' } as MediaJob] };
    const renderer = new StillRenderer({ ffmpeg: 'ffmpeg' }, library, jobs);
    expect(() => renderer.recordingSheet('rec-a', [0], budget)).toThrow(ServiceError);
    expect(() => renderer.recordingSheet('rec-a', [0], budget)).toThrow(/Flight · 4K/);
  });

  it('runs one picture at a time with up to sixteen calls queued', async () => {
    const releases: (() => void)[] = [];
    vi.mocked(runProcess).mockImplementation(
      () =>
        new Promise<Buffer>((resolve) => {
          releases.push(() => resolve(Buffer.alloc(PIXELS * 3)));
        }),
    );
    const renderer = new StillRenderer({ ffmpeg: 'ffmpeg' }, library, { list: () => [] });
    const frames = Array.from({ length: 16 }, (_, frame) => frame);
    const pending = frames.map((frame) => renderer.recordingSheet('rec-a', [frame], budget));
    expect(() => renderer.recordingSheet('rec-a', [16], budget)).toThrow(/16 pictures and estimates/);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Each picture decodes its frame, then encodes the JPEG.
    for (let step = 0; step < 32; step++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(step));
      releases[step]!();
    }
    const images = await Promise.all(pending);
    expect(images.map((image) => image.width)).toEqual(frames.map(() => 480));
    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(32);
  });

  it('gives up on a call that waited five minutes without starting, and skips it', async () => {
    vi.useFakeTimers();
    try {
      const releases: (() => void)[] = [];
      vi.mocked(runProcess).mockImplementation(
        () =>
          new Promise<Buffer>((resolve) => {
            releases.push(() => resolve(Buffer.alloc(PIXELS * 3)));
          }),
      );
      const renderer = new StillRenderer({ ffmpeg: 'ffmpeg' }, library, { list: () => [] });
      const first = renderer.recordingSheet('rec-a', [0], budget);
      const waiting = renderer.recordingSheet('rec-a', [1], budget);
      const outcome = expect(waiting).rejects.toThrow(/Waited 5 minutes/);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await outcome;
      releases[0]!();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[1]!();
      await expect(first).resolves.toMatchObject({ width: 480 });
      expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
