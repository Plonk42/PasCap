import { describe, expect, it } from 'vitest';
import {
  assignByEnergy,
  assignInOrder,
  hungarian,
  slotFit,
  type AssignedCandidate,
} from '../../src/shared/auto-edit/assign.js';
import {
  findCandidates,
  flightOrder,
  measurePictures,
  percentiles,
  pictureFrames,
  scoreCandidates,
  type Candidate,
} from '../../src/shared/auto-edit/candidates.js';
import { clusterCandidates } from '../../src/shared/auto-edit/cluster.js';
import { buildCut, laneEndingAt, unusedId } from '../../src/shared/auto-edit/commands.js';
import { AUTO_EDIT } from '../../src/shared/auto-edit/constants.js';
import {
  cutSpan,
  followMusic,
  mergeSlots,
  musicTimeline,
  planSlots,
  type MusicTimeline,
  type Slot,
} from '../../src/shared/auto-edit/music.js';
import { DEFAULT_AUTO_EDIT_CHOICES } from '../../src/shared/auto-edit/options.js';
import { planAutoEdit, shotWindow, sourceLengthFor } from '../../src/shared/auto-edit/plan.js';
import { alignmentOf } from '../../src/shared/auto-edit/report.js';
import { boundaries } from '../../src/shared/beat-alignment.js';
import { createAdjustment } from '../../src/shared/grade.js';
import {
  createClip,
  createLayer,
  createProject,
  projectSchema,
  type MusicLane,
  type ProjectDocument,
} from '../../src/shared/model.js';
import { steadyLimits } from '../../src/shared/motion-analysis.js';
import { MUSIC_SAMPLE_RATE, MUSIC_SAMPLES_PER_FRAME } from '../../src/shared/music-format.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { PROJECT_FPS } from '../../src/shared/timing.js';
import { flight, motion, scene, song } from './auto-edit-fixtures.js';

const FPS = PROJECT_FPS.numerator / PROJECT_FPS.denominator;
const SONG = song(120, [
  { seconds: 16, kind: 'quiet', loudnessDb: -24 },
  { seconds: 16, kind: 'build', loudnessDb: -16 },
  { seconds: 16, kind: 'peak', loudnessDb: -8 },
  { seconds: 12, kind: 'release', loudnessDb: -18 },
]);
const SONG_FRAMES = Math.floor(SONG.samples / MUSIC_SAMPLES_PER_FRAME);

function lane(frames = SONG_FRAMES, start = 0): MusicLane {
  return {
    id: 'music-1',
    gainDb: 0,
    ripple: false,
    openingFade: 0,
    closingFade: 0,
    clips: [
      { id: 'song-clip', mediaId: 'song', sourceIn: 0, sourceOut: SONG_FRAMES, start, duration: frames, loop: false },
    ],
    transitions: [],
  };
}

const timeline = (): MusicTimeline => musicTimeline(lane(), () => SONG);

function candidate(overrides: Partial<Candidate> & { id: string }): Candidate {
  return {
    mediaId: 'rec',
    name: 'DJI_0001.MP4',
    recording: 0,
    sourceIn: 0,
    sourceOut: 300,
    rate: PROJECT_FPS,
    frames: 300,
    seconds: 300 / FPS,
    kind: 'orbit',
    motion: 'rotate clockwise',
    rank: 1,
    speed: 2,
    jolts: 0.5,
    flight: null,
    iso: null,
    active: { sourceIn: 0, sourceOut: 300 },
    completeness: 1,
    pictures: null,
    energy: 0.5,
    establishing: false,
    quality: 1,
    ...overrides,
  };
}

function slot(start: number, end: number, overrides: Partial<Slot> = {}): Slot {
  return { start, end, kind: null, section: -1, opens: start === 0, energy: 0.5, ...overrides };
}

const beatFrames = (music: MusicTimeline) => music.beats.map((beat) => beat.frame);
const nearAny = (frames: readonly number[], frame: number) => frames.some((item) => Math.abs(item - frame) <= 1);

describe('auto edit music grid', () => {
  it('places the music at project frames: beats, downbeats, hits, sections and loudness', () => {
    const music = timeline();
    expect(music.start).toBe(0);
    expect(music.end).toBe(SONG_FRAMES);
    expect(music.beats).toHaveLength(120);
    expect(music.downbeats).toHaveLength(30);
    expect(music.strongHits).toHaveLength(15);
    expect(music.sections.map((section) => section.kind)).toEqual(['quiet', 'build', 'peak', 'release']);
    expect(music.loudness(0, 300)).toBeCloseTo(-24, 5);
    expect(music.loudness(1000, 1200)).toBeCloseTo(-8, 5);
    expect(music.bpm).toBe(120);
  });

  it('ends the cut on a section end or downbeat before the target, never after the music', () => {
    const music = timeline();
    expect(cutSpan(music, null, FPS)).toEqual({ start: 0, end: music.sections.at(-1)!.end });
    const target = cutSpan(music, Math.round(30 * FPS), FPS);
    expect(target.end).toBeLessThanOrEqual(Math.round(30 * FPS));
    expect(target.end).toBeGreaterThan(Math.round(26 * FPS));
    expect(nearAny([...music.downbeats, ...music.sections.map((section) => section.end)], target.end)).toBe(true);
    expect(cutSpan(music, Math.round(500 * FPS), FPS).end).toBe(music.sections.at(-1)!.end);
  });

  it('cuts on downbeats and hits, at section changes, longer on quiet music than at the peak', () => {
    const music = timeline();
    const span = cutSpan(music, null, FPS);
    const slots = planSlots(music, span, { pace: 1, fps: FPS, maxClips: null });
    expect(slots[0]!.start).toBe(span.start);
    expect(slots.at(-1)!.end).toBe(span.end);
    slots.slice(1).forEach((item, index) => expect(item.start).toBe(slots[index]!.end));
    const cuts = slots.slice(1).map((item) => item.start);
    for (const frame of cuts) expect(nearAny(beatFrames(music), frame)).toBe(true);
    const onDownbeatOrHit = cuts.filter((frame) => nearAny([...music.downbeats, ...music.strongHits], frame));
    expect(onDownbeatOrHit.length).toBeGreaterThanOrEqual(cuts.length - 1);
    for (const section of music.sections.slice(1)) expect(nearAny(cuts, section.start)).toBe(true);
    const mean = (kind: string) => {
      const lengths = slots.filter((item) => item.kind === kind).map((item) => item.end - item.start);
      return lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    };
    expect(mean('quiet')).toBeGreaterThan(1.2 * mean('peak'));
    expect(slots.filter((item) => item.opens).map((item) => item.kind)).toEqual(['quiet', 'build', 'peak', 'release']);
    const energies = Object.fromEntries(slots.map((item) => [item.kind, item.energy]));
    expect(energies.peak).toBeGreaterThan(energies.quiet!);
    for (const item of slots) {
      expect(item.end - item.start).toBeGreaterThanOrEqual(Math.round(AUTO_EDIT.minimumSeconds * FPS));
      expect(item.end - item.start).toBeLessThanOrEqual(Math.round(AUTO_EDIT.maximumSeconds * FPS));
    }
    const calm = planSlots(music, span, { pace: AUTO_EDIT.pace.calm, fps: FPS, maxClips: null });
    const energetic = planSlots(music, span, { pace: AUTO_EDIT.pace.energetic, fps: FPS, maxClips: null });
    expect(calm.length).toBeLessThan(slots.length);
    expect(energetic.length).toBeGreaterThan(slots.length);
  });

  it('keeps at most the clips asked for, merging the shortest slots', () => {
    const music = timeline();
    const slots = planSlots(music, cutSpan(music, null, FPS), { pace: 1, fps: FPS, maxClips: 5 });
    expect(slots).toHaveLength(5);
    expect(
      mergeSlots(
        [
          { start: 0, end: 10 },
          { start: 10, end: 50 },
          { start: 50, end: 60 },
        ],
        2,
      ),
    ).toEqual([
      { start: 0, end: 50 },
      { start: 50, end: 60 },
    ]);
  });

  it('cuts even lengths without music', () => {
    const slots = planSlots(null, { start: 0, end: 600 }, { pace: 1, fps: FPS, maxClips: null });
    expect(slots).toHaveLength(5);
    expect(slots.every((item) => item.kind === null && item.energy === 0.5)).toBe(true);
  });
});

describe('auto edit music choice', () => {
  const base = createProject('music', 'Music');
  const withLane = { ...base, media: { ...base.media, audioIds: ['song', 'other'] }, music: [lane()] };
  const source = () => ({
    frameCount: 900,
    analysis: { silences: [{ fromSample: 0, toSample: Math.round(2 * MUSIC_SAMPLE_RATE) }] },
  });

  it('follows the chosen track, the track playing the chosen recording, or the first track', () => {
    expect(followMusic(withLane, { musicTrackId: 'music-1', musicId: null }, source)).toEqual({
      lane: lane(),
      placed: true,
    });
    expect(followMusic(withLane, { musicTrackId: null, musicId: 'song' }, source)?.lane.id).toBe('music-1');
    expect(followMusic(withLane, { musicTrackId: null, musicId: null }, source)?.lane.id).toBe('music-1');
    expect(followMusic(base, { musicTrackId: null, musicId: null }, source)).toBeNull();
    expect(() => followMusic(withLane, { musicTrackId: 'nope', musicId: null }, source)).toThrow(/no music track nope/);
    expect(() => followMusic(withLane, { musicTrackId: null, musicId: 'missing' }, source)).toThrow(
      /not in the project/,
    );
  });

  it('places a recording that no track plays from frame 0, after its leading silence', () => {
    const placed = followMusic(withLane, { musicTrackId: null, musicId: 'other' }, source)!;
    expect(placed.placed).toBe(false);
    expect(placed.lane.id).toBe('auto-music');
    const lead = Math.floor((2 * MUSIC_SAMPLE_RATE) / MUSIC_SAMPLES_PER_FRAME);
    expect(placed.lane.clips).toEqual([
      {
        id: 'auto-music-clip',
        mediaId: 'other',
        sourceIn: lead,
        sourceOut: 900,
        start: 0,
        duration: 900 - lead,
        loop: false,
      },
    ]);
  });

  it('ends a longer track with the cut, with a closing fade, and leaves a shorter one', () => {
    const trimmed = laneEndingAt(lane(), 600, 45);
    expect(trimmed.clips[0]!.duration).toBe(600);
    expect(trimmed.closingFade).toBe(45);
    expect(laneEndingAt(lane(500), 600, 45)).toEqual(lane(500));
    expect(unusedId('auto-1', new Set(['auto-1', 'auto-1-2']))).toBe('auto-1-3');
  });
});

describe('auto edit assignment', () => {
  const assigned = (overrides: Partial<AssignedCandidate>): AssignedCandidate => ({
    quality: 1,
    energy: 0.5,
    kind: 'orbit',
    establishing: false,
    frames: 300,
    best: true,
    ...overrides,
  });

  it('fills slots with candidates in flight order, skipping those too short, the longest prefix when it must', () => {
    const slots = [slot(0, 100), slot(100, 250), slot(250, 300)];
    const candidates = [
      assigned({ frames: 120 }),
      assigned({ frames: 90, quality: 5 }),
      assigned({ frames: 200, kind: 'reveal' }),
      assigned({ frames: 60 }),
    ];
    expect(assignInOrder(candidates, slots).picks).toEqual([0, 2, 3]);
    expect(assignInOrder(candidates, [slot(0, 150), slot(150, 300), slot(300, 400)]).picks).toEqual([2]);
    expect(assignInOrder([assigned({ frames: 10 })], slots).picks).toEqual([]);
    expect(slotFit({ frames: 99, kind: 'orbit' }, 100)).toBe(0);
    expect(slotFit({ frames: 100, kind: 'orbit' }, 100)).toBe(1);
    expect(slotFit({ frames: 1000, kind: 'reveal' }, 100)).toBeLessThan(slotFit({ frames: 1000, kind: 'orbit' }, 100));
  });

  it('opens with an establishing shot, avoids repeating a kind and prefers the best take of a cluster', () => {
    const slots = [slot(0, 100, { opens: true }), slot(100, 200)];
    const establishing = [assigned({ quality: 1 }), assigned({ quality: 0.9, establishing: true }), assigned({})];
    expect(assignInOrder(establishing, slots).picks[0]).toBe(1);
    const kinds = [assigned({}), assigned({}), assigned({ kind: 'move', quality: 0.95 })];
    expect(assignInOrder(kinds, slots).picks).toEqual([0, 2]);
    const takes = [assigned({}), assigned({ best: false, quality: 1.2 }), assigned({ quality: 0.8 })];
    expect(assignInOrder(takes, slots).picks).toEqual([0, 2]);
  });

  it('puts lively shots on loud music when the order is free', () => {
    const slots = [slot(0, 100, { energy: 0.1 }), slot(100, 200, { energy: 0.9 })];
    const candidates = [assigned({ energy: 0.9, kind: 'orbit' }), assigned({ energy: 0.1, kind: 'move' })];
    expect(assignByEnergy(candidates, slots).picks).toEqual([1, 0]);
    expect(assignInOrder(candidates, slots).picks).toEqual([0, 1]);
    expect(assignByEnergy([assigned({ frames: 150 })], [slot(0, 100), slot(100, 300)]).picks).toEqual([0]);
  });

  it('finds the minimum-cost assignment', () => {
    const cost = [
      [4, 1, 3, 9],
      [2, 0, 5, 9],
      [3, 2, 2, 1],
    ];
    const assignment = hungarian(cost, 4);
    const total = assignment.reduce((sum, column, row) => sum + cost[row]![column]!, 0);
    let best = Number.POSITIVE_INFINITY;
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++)
        for (let c = 0; c < 4; c++)
          if (new Set([a, b, c]).size === 3) best = Math.min(best, cost[0]![a]! + cost[1]![b]! + cost[2]![c]!);
    expect(total).toBe(best);
    expect(new Set(assignment).size).toBe(3);
  });
});

describe('auto edit candidates', () => {
  const recordings = [
    {
      mediaId: 'b',
      name: 'DJI_0010.MP4',
      frameCount: 0,
      rate: PROJECT_FPS,
      analysis: motion(
        [
          { frames: 400, rotation: 0.003 },
          { frames: 300, tx: 3 },
        ],
        flight(30, 80, 200),
      ),
      damage: [],
      kept: undefined,
    },
    {
      mediaId: 'a',
      name: 'DJI_0002.MP4',
      frameCount: 0,
      rate: PROJECT_FPS,
      analysis: motion([{ frames: 500, zoom: -0.004 }], flight(30, 30, 50)),
      damage: [],
      kept: [{ sourceIn: 50, sourceOut: 400 }],
    },
  ];

  it('orders recordings as filmed and finds their steady ranges inside the kept ranges', () => {
    expect(flightOrder(recordings).map((item) => item.name)).toEqual(['DJI_0002.MP4', 'DJI_0010.MP4']);
    const { candidates, leftOut } = findCandidates(recordings, steadyLimits(), 45);
    expect(leftOut).toEqual([]);
    expect(candidates.map((item) => [item.mediaId, item.recording, item.kind])).toEqual([
      ['a', 0, 'reveal'],
      ['b', 1, 'orbit'],
      ['b', 1, 'orbit'],
    ]);
    const kept = candidates[0]!;
    expect(kept.sourceIn).toBeGreaterThanOrEqual(50);
    expect(kept.sourceOut).toBeLessThanOrEqual(400);
    expect(kept.frames).toBe(kept.sourceOut - kept.sourceIn);
    expect(pictureFrames(kept)).toHaveLength(3);
    expect(findCandidates(recordings, steadyLimits(), 1000).leftOut).toHaveLength(3);
  });

  it('scores quality, energy and establishing shots relative to the others', () => {
    const { candidates } = findCandidates(recordings, steadyLimits(), 45);
    const scored = scoreCandidates(candidates, 2);
    expect(scored[0]!.establishing).toBe(true);
    expect(scored.every((item) => item.quality > 0 && item.energy >= 0 && item.energy <= 1)).toBe(true);
    expect(percentiles([1, 2, 2, 3])).toEqual([0, 0.5, 0.5, 1]);
    const dark = measurePictures([scene(1)], []);
    expect(dark.layouts).toHaveLength(1);
    expect(dark.contrast).toBeGreaterThan(0.3);
    expect(dark.blur).toBeNull();
  });

  it('groups takes of one subject, within a span of recordings', () => {
    const pictured = (id: string, recording: number, subject: number) =>
      candidate({ id, recording, mediaId: id, pictures: measurePictures([scene(subject, 0), scene(subject, 1)], []) });
    const candidates = [pictured('a', 0, 1), pictured('b', 1, 2), pictured('c', 2, 1), pictured('d', 12, 1)];
    expect(clusterCandidates(candidates)).toEqual([0, 1, 0, 2]);
  });
});

describe('auto edit windows', () => {
  it('shows the end of a reveal, the start of an approach and the middle of an orbit', () => {
    const base = { sourceIn: 100, sourceOut: 400, active: { sourceIn: 130, sourceOut: 370 } };
    expect(shotWindow(candidate({ id: 'r', kind: 'reveal', ...base }), 90)).toEqual({ sourceIn: 280, sourceOut: 370 });
    expect(shotWindow(candidate({ id: 'p', kind: 'approach', ...base }), 90)).toEqual({
      sourceIn: 130,
      sourceOut: 220,
    });
    expect(shotWindow(candidate({ id: 'o', kind: 'orbit', ...base }), 90)).toEqual({ sourceIn: 205, sourceOut: 295 });
    expect(shotWindow(candidate({ id: 'w', ...base }), 300)).toEqual({ sourceIn: 100, sourceOut: 400 });
    const fast = { numerator: 60, denominator: 1 };
    expect(sourceLengthFor(90, { rate: fast })).toBe(180);
  });
});

describe('auto edit plan and cut', () => {
  const recordings = Array.from({ length: 8 }, (_, index) => `DJI_000${index + 1}.MP4`);
  function project(): ProjectDocument {
    const base = createProject('auto', 'Flight');
    const old = createClip('old', 'rec-0', 0, 60);
    return projectSchema.parse({
      ...base,
      media: { videoIds: recordings.map((_, index) => `rec-${index}`), audioIds: ['song'], imageIds: [] },
      layers: [base.layers[0]!, createLayer('second', 'Track 2', false)],
      clips: [old],
      music: [lane()],
      adjustments: [createAdjustment('look', 0, 60)],
    });
  }
  function candidates(): Candidate[] {
    const found = findCandidates(
      recordings.map((name, index) => ({
        mediaId: `rec-${index}`,
        name,
        frameCount: 2000,
        rate: PROJECT_FPS,
        analysis: motion(
          [
            { frames: 420, rotation: 0.003 },
            { frames: 360, tx: 3 },
            { frames: 300, zoom: -0.004 },
          ],
          flight(40, 40 + 20 * index, 100 + 100 * index),
        ),
        damage: [],
        kept: undefined,
      })),
      steadyLimits(),
      45,
    );
    const pictured = found.candidates.map((item, index) => ({
      ...item,
      pictures: measurePictures([scene(index), scene(index, 1), scene(index, 2)], []),
    }));
    return scoreCandidates(pictured, 2);
  }
  const input = (overrides: Partial<Parameters<typeof planAutoEdit>[0]> = {}) => ({
    candidates: candidates(),
    music: timeline(),
    targetFrames: null,
    choices: DEFAULT_AUTO_EDIT_CHOICES,
    maxClips: null,
    fps: FPS,
    ...overrides,
  });

  it('fills the music with distinct shots in flight order, each a window inside its steady range', () => {
    const plan = planAutoEdit(input());
    expect(plan.span).toEqual({ start: 0, end: timeline().sections.at(-1)!.end });
    expect(plan.shortfall).toBeNull();
    expect(new Set(plan.clips.map((clip) => clip.candidate.id)).size).toBe(plan.clips.length);
    const orders = plan.clips.map((clip) => [clip.candidate.recording, clip.candidate.sourceIn]);
    expect(orders).toEqual([...orders].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    for (const clip of plan.clips) {
      expect(clip.sourceIn).toBeGreaterThanOrEqual(clip.candidate.sourceIn);
      expect(clip.sourceOut).toBeLessThanOrEqual(clip.candidate.sourceOut);
      expect(clip.sourceOut - clip.sourceIn).toBe(clip.slot.end - clip.slot.start);
      expect(clip.reasons[0]).toMatch(/^(orbit|reveal|move|approach|static) \(/);
    }
    expect(plan.transitions).toHaveLength(plan.clips.length - 1);
    expect(plan.openingFade).toBeGreaterThanOrEqual(AUTO_EDIT.openingFade.minimum);
    expect(plan.closingFade).toBeGreaterThan(0);
  });

  it('gives other shots for another variant, cuts only or dissolves when asked, and a shorter cut when footage runs out', () => {
    const short = { targetFrames: Math.round(30 * FPS) };
    const first = planAutoEdit(input(short));
    const second = planAutoEdit(input({ ...short, choices: { ...DEFAULT_AUTO_EDIT_CHOICES, variant: 1 } }));
    expect(second.clips.map((clip) => clip.candidate.id)).not.toEqual(first.clips.map((clip) => clip.candidate.id));
    const cuts = planAutoEdit(input({ choices: { ...DEFAULT_AUTO_EDIT_CHOICES, transitions: 'cuts' } }));
    expect(cuts.transitions.every((transition) => transition.type === 'cut')).toBe(true);
    const soft = planAutoEdit(input({ choices: { ...DEFAULT_AUTO_EDIT_CHOICES, transitions: 'soft' } }));
    const auto = planAutoEdit(input());
    expect(soft.transitions.filter((transition) => transition.type === 'cross-dissolve').length).toBeGreaterThan(
      auto.transitions.filter((transition) => transition.type === 'cross-dissolve').length,
    );
    const few = planAutoEdit(input({ candidates: candidates().slice(0, 2) }));
    expect(few.shortfall).toMatch(/steady footage fills/);
    expect(few.span.end).toBeLessThan(auto.span.end);
    expect(() => planAutoEdit(input({ candidates: [] }))).toThrow(/No steady range/);
  });

  it('builds a copy of the project as the cut, with every boundary on the music', () => {
    const plan = planAutoEdit(input());
    const music = timeline();
    const built = buildCut(project(), plan, { lane: lane(), placed: true }, 'replace', () => 2000);
    const document = projectSchema.parse(built.document);
    expect(document.layers).toEqual([expect.objectContaining({ id: built.layerId, name: 'Auto edit', ripple: true })]);
    expect(document.adjustments).toEqual([]);
    expect(document.clips.map((clip) => clip.id)).toEqual(built.clipIds);
    expect(calculateLayout(document).duration).toBe(plan.span.end);
    const cuts = boundaries(document, built.layerId).map((boundary) => boundary.frame);
    expect(cuts).toHaveLength(plan.clips.length - 1);
    cuts.forEach((frame, index) => expect(Math.abs(frame - plan.clips[index + 1]!.slot.start)).toBeLessThanOrEqual(1));
    const alignment = alignmentOf(document, built.layerId, music)!;
    expect(alignment.onBeat).toBe(alignment.boundaries);
    const layer = document.layers[0]!;
    expect(layer.openingFade).toBe(plan.openingFade);
    expect(layer.closingFade).toBe(plan.closingFade);
    expect(layer.transitions.some((transition) => transition.type === 'cross-dissolve')).toBe(true);
    expect(built.notes).toEqual([]);
    expect(document.music).toEqual([lane()]);
  });

  it('adds the cut on a new track of the project, hiding the others and turning adjustments off', () => {
    const plan = planAutoEdit(input({ targetFrames: Math.round(30 * FPS) }));
    const built = buildCut(project(), plan, { lane: lane(), placed: true }, 'track', () => 2000);
    const document = built.document;
    expect(document.layers.map((layer) => [layer.id, layer.enabled])).toEqual([
      ['video-1', false],
      ['second', false],
      [built.layerId, true],
    ]);
    expect(document.clips.find((clip) => clip.id === 'old')).toBeDefined();
    expect(document.adjustments[0]!.enabled).toBe(false);
    const musicClip = document.music[0]!.clips[0]!;
    expect(musicClip.duration).toBe(plan.span.end);
    expect(document.music[0]!.closingFade).toBe(plan.closingFade);
    const full = projectSchema.parse({
      ...document,
      layers: [...document.layers, ...['a', 'b', 'c', 'd', 'e'].map((id) => createLayer(id, id))],
    });
    expect(() => buildCut(full, plan, null, 'track', () => 2000)).toThrow(/8 video tracks/);
  });

  it('keeps a cut where a dissolve would need footage the recording or kept ranges lack', () => {
    const plan = planAutoEdit(input());
    const dissolves = plan.transitions.filter((transition) => transition.type === 'cross-dissolve').length;
    // Each recording ends where its last clip ends: no frame after it for a dissolve.
    const tight = (mediaId: string) =>
      Math.max(...plan.clips.filter((clip) => clip.candidate.mediaId === mediaId).map((clip) => clip.sourceOut));
    const built = buildCut(project(), plan, { lane: lane(), placed: true }, 'replace', tight);
    const kept = built.document.layers[0]!.transitions.filter((transition) => transition.type === 'cross-dissolve');
    expect(kept.length).toBeLessThan(dissolves);
    expect(built.notes.some((note) => /(stays a cut|stay cuts).*beyond the recording/.test(note))).toBe(true);
  });
});
