import { describe, expect, it } from 'vitest';
import { constantRate } from '../../src/server/probe.js';
import { assertSourceRanges } from '../../src/server/project-sources.js';
import type { AudioAsset } from '../../src/shared/audio.js';
import { applyCommand } from '../../src/shared/commands.js';
import type { MediaAsset } from '../../src/shared/media.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { upgradeProject } from '../../src/shared/project-migrations.js';
import { removeProjectMedia, withVideoRates } from '../../src/shared/projects.js';
import { trimByOutputFrames, trimOnTimeline } from '../../src/shared/source-range.js';
import { compileRetiming, type SpeedSettings } from '../../src/shared/speed.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import {
  PROJECT_FPS,
  SOURCE_FRAME_RATES,
  sourceFrameRate,
  sourceFramesPerProjectFrame,
  videoRate,
  type FrameRate,
} from '../../src/shared/timing.js';

const SIXTY: FrameRate = { numerator: 60, denominator: 1 };
const THIRTY: FrameRate = { numerator: 30, denominator: 1 };
const FILM: FrameRate = { numerator: 24_000, denominator: 1_001 };
const curve: SpeedSettings = {
  mode: 'curve',
  keyframes: [
    { frame: 0, rate: 0.5, interpolation: 'smooth' },
    { frame: 60, rate: 2, interpolation: 'linear' },
    { frame: 120, rate: 1, interpolation: 'hold' },
  ],
};

function rated(rates: Record<string, FrameRate>): ProjectDocument {
  const project = createProject('rates', 'Recording rates');
  project.media.videoIds = Object.keys(rates);
  project.videoRates = rates;
  project.clips = [createClip('clip', Object.keys(rates)[0]!, 0, 120)];
  return projectSchema.parse(project);
}

describe('recordings at other constant frame rates', () => {
  it('accepts the listed constant rates only, in their stored form', () => {
    expect(SOURCE_FRAME_RATES.map((rate) => rate.numerator / rate.denominator).every((fps) => fps <= 60)).toBe(true);
    expect(sourceFrameRate({ numerator: 60_000, denominator: 2_000 })).toEqual(THIRTY);
    expect(sourceFrameRate({ numerator: 120, denominator: 1 })).toBeUndefined();
    expect(sourceFramesPerProjectFrame(PROJECT_FPS)).toBe(1);
    expect(sourceFramesPerProjectFrame(THIRTY)).toBeCloseTo(1.001, 12);
    expect(sourceFramesPerProjectFrame(FILM)).toBeCloseTo(0.8, 12);
  });

  it('names the rate it rejects, and variable rates', () => {
    expect(constantRate('30/1', '30/1')).toEqual(THIRTY);
    expect(constantRate('60000/1001', '60000/1001')).toEqual({ numerator: 60_000, denominator: 1_001 });
    expect(() => constantRate('120/1', '120/1')).toThrow('120 fps recordings are not supported');
    expect(() => constantRate('8350000/278333', '30/1')).toThrow('The frame rate varies');
    expect(() => constantRate('0/0', '30/1')).toThrow('The frame rate is unknown');
  });

  it('plays recording frames in real time, whatever their rate', () => {
    const clip = createClip('clip', 'video', 0, 1200);
    expect(compileRetiming(clip, PROJECT_FPS).duration).toBe(1200);
    const thirty = compileRetiming(clip, THIRTY);
    expect(thirty.duration).toBe(Math.round(1200 / 1.001));
    // One recording frame in about 1001 is skipped, none repeated.
    const shown = new Set(Array.from({ length: thirty.duration }, (_, frame) => thirty.sourceAt(frame)));
    expect(shown.size).toBe(thirty.duration);
    const sixty = compileRetiming(clip, SIXTY);
    expect(sixty.duration).toBe(Math.round(1200 / 2.002));
    expect([0, 1, 2, 3].map(sixty.sourceAt)).toEqual([0, 2, 4, 6]);
    const film = compileRetiming(clip, FILM);
    expect(film.duration).toBe(1500);
    expect([0, 1, 2, 3, 4, 5].map(film.sourceAt)).toEqual([0, 0, 1, 2, 3, 4]);
    // Speed stays relative to real time: half speed plays every 60 fps frame.
    const slow = compileRetiming({ ...clip, speed: { mode: 'constant', rate: 0.5 } }, SIXTY);
    expect(slow.duration).toBe(Math.round(1200 / 1.001));
    expect(() => compileRetiming(clip, { numerator: 120, denominator: 1 })).toThrow('accepted recording frame rate');
  });

  it('scales speed curves and reversed clips by the same factor, keeping their source anchors', () => {
    const clip = { ...createClip('clip', 'video', 0, 120), speed: curve };
    const base = compileRetiming(clip, PROJECT_FPS);
    const sixty = compileRetiming(clip, SIXTY);
    expect(Math.abs(sixty.duration - base.duration / sourceFramesPerProjectFrame(SIXTY))).toBeLessThan(1);
    for (let frame = 0; frame <= sixty.duration; frame++) {
      const fraction = frame / sixty.duration;
      expect(sixty.sourcePositionAt(frame)).toBeCloseTo(base.sourcePositionAt(fraction * base.duration), 6);
    }
    const reversed = compileRetiming({ ...clip, reverse: true }, SIXTY);
    expect(reversed.duration).toBe(sixty.duration);
    expect(reversed.sourceAt(0)).toBe(119);
    expect(reversed.sourceAt(sixty.duration - 1)).toBeLessThan(4);
  });

  it('places clips with the rate the project records for their recording', () => {
    const project = rated({ sixty: SIXTY });
    expect(videoRate(project, 'sixty')).toEqual(SIXTY);
    expect(videoRate(project, 'other')).toEqual(PROJECT_FPS);
    expect(calculateLayout(project).clips[0]!.duration).toBe(Math.round(120 / 2.002));
    expect(calculateLayout({ ...project, videoRates: {} }).clips[0]!.duration).toBe(120);
  });

  it('records only accepted non-project rates of recordings in the bin', () => {
    const project = rated({ sixty: SIXTY });
    expect(() => projectSchema.parse({ ...project, videoRates: { other: SIXTY } })).toThrow('not in the project');
    expect(() => projectSchema.parse({ ...project, videoRates: { sixty: { ...PROJECT_FPS } } })).toThrow(
      'other than the project rate',
    );
    expect(() =>
      projectSchema.parse({ ...project, videoRates: { sixty: { numerator: 120, denominator: 1 } } }),
    ).toThrow('accepted rate');
  });

  it('upgrades schema-29 projects without recording rates: their recordings were all at the project rate', () => {
    const project = rated({ sixty: SIXTY });
    const older: Record<string, unknown> = { ...project, schemaVersion: 29, clips: [] };
    delete older['videoRates'];
    expect(projectSchema.parse(upgradeProject(older))).toEqual({ ...project, clips: [], videoRates: {} });
  });

  it('records the registered rate of each recording in the bin, and forgets removed recordings', () => {
    const project = projectSchema.parse({
      ...createProject('bin', 'Bin'),
      media: { videoIds: ['sixty', 'drone', 'gone'], audioIds: [] },
      videoRates: { gone: FILM },
    });
    const registry: Record<string, FrameRate> = { sixty: SIXTY, drone: PROJECT_FPS };
    const recorded = projectSchema.parse(withVideoRates(project, (id) => registry[id]));
    expect(recorded.videoRates).toEqual({ sixty: SIXTY, gone: FILM });
    expect(removeProjectMedia(recorded, { videoIds: ['sixty'], audioIds: [] }).videoRates).toEqual({ gone: FILM });
  });

  it('refuses to save a project whose recording rate differs from the registered one', () => {
    const project = rated({ sixty: SIXTY });
    const library = (rate: FrameRate) => ({
      get: (id: string) => ({ id, name: 'DJI_0001.MP4', metadata: { frameCount: 120, frameRate: rate } }) as MediaAsset,
    });
    const audio = { get: () => ({}) as AudioAsset };
    expect(() => assertSourceRanges(project, library(SIXTY), audio)).not.toThrow();
    expect(() => assertSourceRanges(project, library(PROJECT_FPS), audio)).toThrow(
      'DJI_0001.MP4 is recorded at 29.97 fps, but the project plays it at 60 fps.',
    );
    expect(() => assertSourceRanges({ ...project, videoRates: {} }, library(SIXTY), audio)).toThrow(
      'recorded at 60 fps, but the project plays it at 29.97 fps',
    );
  });

  it('trims and splits in recording frames at the recording rate', () => {
    const project = rated({ sixty: SIXTY });
    const clip = project.clips[0]!;
    // Ten more project frames need about twenty 60 fps frames.
    expect(trimByOutputFrames(clip, 'out', -10, 120, SIXTY)).toMatchObject({ sourceIn: 0, sourceOut: 100 });
    const trimmed = applyCommand(project, trimOnTimeline(project, 'clip', 'out', -10, 120, 'output'));
    expect(calculateLayout(trimmed).clips[0]!.duration).toBe(calculateLayout(project).clips[0]!.duration - 10);
    const split = applyCommand(project, { type: 'split', clipId: 'clip', sourceFrame: 60, newClipId: 'right' });
    const placed = calculateLayout(split).clips;
    expect(placed.map((item) => item.duration)).toEqual([30, 30]);
    expect(placed[1]!.start).toBe(placed[0]!.end);
  });
});
