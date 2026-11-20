import type { MusicLane, ProjectDocument } from '../model.js';
import {
  musicBeatFrames,
  musicHitFrames,
  musicSpans,
  type MusicAnalysis,
  type PlacedBeat,
  type PlacedSpan,
  type sectionKinds,
} from '../music-analysis.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../music-format.js';
import { musicTracks } from '../music-lanes.js';
import { unusedId } from './commands.js';
import { AUTO_EDIT } from './constants.js';

export type SectionKind = (typeof sectionKinds)[number];

export interface MusicSection extends PlacedSpan {
  kind: SectionKind;
}

/** A music track at project frames, as auto edit cuts on it. */
export interface MusicTimeline {
  /** The track's first frame and the frame after its last. */
  start: number;
  end: number;
  beats: PlacedBeat[];
  downbeats: number[];
  strongHits: number[];
  sections: MusicSection[];
  silences: PlacedSpan[];
  /** Where a sudden swell starts, and which of them drop. */
  swells: number[];
  drops: number[];
  /** Mean dBFS over project frames [from, to). */
  loudness: (from: number, to: number) => number;
  /** Mean tempo, or null without a steady beat. */
  bpm: number | null;
}

const byFrame = (a: number, b: number) => a - b;
const unique = (frames: readonly number[]) => [...new Set(frames)].sort(byFrame);

/** What auto edit needs to know of a music recording to place it. */
export interface MusicSource {
  frameCount: number;
  analysis: Pick<MusicAnalysis, 'silences'> | null;
}

/**
 * The music a cut follows: the chosen music track; else the track already playing the chosen recording, or a new
 * track placing that recording from frame 0 (its leading silence left out); else the project's first music track;
 * else none. Throws when the chosen track or recording is not in the project.
 */
export function followMusic(
  project: Pick<ProjectDocument, 'music' | 'media'>,
  choice: { musicTrackId: string | null; musicId: string | null },
  source: (mediaId: string) => MusicSource,
): { lane: MusicLane; placed: boolean } | null {
  if (choice.musicTrackId !== null) {
    const lane = project.music.find((item) => item.id === choice.musicTrackId);
    if (!lane) throw new Error(`The project has no music track ${choice.musicTrackId}.`);
    return { lane, placed: true };
  }
  if (choice.musicId === null) return project.music[0] ? { lane: project.music[0], placed: true } : null;
  const playing = project.music.find((lane) => lane.clips.some((clip) => clip.mediaId === choice.musicId));
  if (playing) return { lane: playing, placed: true };
  if (!project.media.audioIds.includes(choice.musicId))
    throw new Error(`Music recording ${choice.musicId} is not in the project; import it first.`);
  const { frameCount, analysis } = source(choice.musicId);
  const leading = analysis?.silences.find((silence) => silence.fromSample === 0);
  const lead = leading ? Math.floor(leading.toSample / MUSIC_SAMPLES_PER_FRAME) : 0;
  const sourceIn = lead < frameCount - 1 ? lead : 0;
  const taken = new Set(project.music.flatMap((lane) => [lane.id, ...lane.clips.map((clip) => clip.id)]));
  const laneId = unusedId('auto-music', taken);
  taken.add(laneId);
  return {
    lane: {
      id: laneId,
      gainDb: 0,
      ripple: false,
      openingFade: 0,
      closingFade: 0,
      clips: [
        {
          id: unusedId(`${laneId}-clip`, taken),
          mediaId: choice.musicId,
          sourceIn,
          sourceOut: frameCount,
          start: 0,
          duration: frameCount - sourceIn,
          loop: false,
        },
      ],
      transitions: [],
    },
    placed: false,
  };
}

/** The music of a track: beats, strong hits, sections, silences, swells and loudness, at project frames. */
export function musicTimeline(lane: MusicLane, analysisOf: (mediaId: string) => MusicAnalysis | null): MusicTimeline {
  const tracks = musicTracks([lane]);
  const placed = tracks.flatMap((track) => {
    const analysis = analysisOf(track.mediaId);
    return analysis ? [{ track, analysis }] : [];
  });
  const beats = new Map<number, PlacedBeat>();
  for (const { track, analysis } of placed)
    for (const beat of musicBeatFrames(track, analysis.beats))
      if (!beats.get(beat.frame)?.downbeat) beats.set(beat.frame, beat);
  const spans = <T extends { fromSample: number; toSample: number }>(pick: (analysis: MusicAnalysis) => readonly T[]) =>
    placed.flatMap(({ track, analysis }) =>
      pick(analysis).flatMap((item) =>
        musicSpans(track, item.fromSample, item.toSample).map((span) => ({ ...span, item })),
      ),
    );
  const sortedBeats = [...beats.values()].sort((a, b) => a.frame - b.frame);
  const tempos = placed.flatMap(({ analysis }) => (analysis.tempo ? [analysis.tempo.bpm] : []));
  return {
    start: Math.min(...tracks.map((track) => track.start)),
    end: Math.max(...tracks.map((track) => track.start + track.duration)),
    beats: sortedBeats,
    downbeats: sortedBeats.filter((beat) => beat.downbeat).map((beat) => beat.frame),
    strongHits: unique(
      placed.flatMap(({ track, analysis }) =>
        musicHitFrames(track, analysis.hits)
          .filter((hit) => hit.strong)
          .map((hit) => hit.frame),
      ),
    ),
    sections: spans((analysis) => analysis.sections)
      .map(({ start, end, item }) => ({ start, end, kind: item.kind }))
      .sort((a, b) => a.start - b.start),
    silences: spans((analysis) => analysis.silences)
      .map(({ start, end }) => ({ start, end }))
      .sort((a, b) => a.start - b.start),
    swells: unique(spans((analysis) => analysis.swells.filter((swell) => swell.sudden)).map((span) => span.start)),
    drops: unique(
      spans((analysis) => analysis.swells.filter((swell) => swell.sudden && swell.kind === 'decrescendo')).map(
        (span) => span.start,
      ),
    ),
    loudness: (from, to) => meanLoudness(placed, from, to),
    bpm: tempos.length ? tempos.reduce((sum, value) => sum + value, 0) / tempos.length : null,
  };
}

function meanLoudness(
  placed: readonly { track: ReturnType<typeof musicTracks>[number]; analysis: MusicAnalysis }[],
  from: number,
  to: number,
): number {
  let sum = 0;
  let count = 0;
  for (let frame = from; frame < to; frame += 3) {
    const entry = placed.find(({ track }) => frame >= track.start && frame < track.start + track.duration);
    if (!entry) continue;
    const { track, analysis } = entry;
    const length = track.sourceOut - track.sourceIn;
    const sample = (track.sourceIn + ((frame - track.start) % length)) * MUSIC_SAMPLES_PER_FRAME;
    const value = analysis.loudness[Math.floor(sample / (analysis.sampleRate / 10))];
    if (value === undefined) continue;
    sum += value;
    count++;
  }
  return count ? sum / count : -120;
}

/** Frames between beats around `frame`, or the tempo's, or half a second. */
export function beatLength(music: MusicTimeline | null, frame: number, fps: number): number {
  if (music && music.beats.length >= 2) {
    const index = music.beats.findIndex((beat) => beat.frame >= frame);
    const at = index < 0 ? music.beats.length - 1 : index;
    const from = Math.max(0, at - 4);
    const to = Math.min(music.beats.length - 1, at + 4);
    if (to > from) return (music.beats[to]!.frame - music.beats[from]!.frame) / (to - from);
  }
  return music?.bpm ? (60 * fps) / music.bpm : fps / 2;
}

/** Beats per bar: the downbeats' spacing, else 4. */
export function barBeats(music: MusicTimeline | null): number {
  if (!music || music.downbeats.length < 2 || music.beats.length < 2) return 4;
  const between = music.beats.filter(
    (beat) => beat.frame >= music.downbeats[0]! && beat.frame < music.downbeats.at(-1)!,
  ).length;
  return Math.max(2, Math.round(between / (music.downbeats.length - 1)));
}

export interface CutSpan {
  start: number;
  end: number;
}

/**
 * Where the cut lies on the music: from its start to the target length, ending on a section end or downbeat at
 * most AUTO_EDIT.endBars bars before the target (never after the music ends).
 */
export function cutSpan(music: MusicTimeline, targetFrames: number | null, fps: number): CutSpan {
  const start = music.start;
  const wanted = Math.min(music.end, targetFrames === null ? music.end : start + targetFrames);
  const bar = barBeats(music) * beatLength(music, wanted, fps);
  const earliest = wanted - AUTO_EDIT.endBars * bar;
  const sectionEnds = music.sections.map((section) => section.end).filter((end) => end >= earliest && end <= wanted);
  const downbeats = music.downbeats.filter((frame) => frame >= earliest && frame <= wanted);
  const end = sectionEnds.at(-1) ?? downbeats.at(-1) ?? wanted;
  return { start, end: end - start >= fps * AUTO_EDIT.minimumSeconds ? end : wanted };
}

/** A stretch of the music one clip fills. */
export interface Slot {
  start: number;
  end: number;
  /** The music section it lies in, null without sections. */
  kind: SectionKind | null;
  section: number;
  /** First slot of the cut or of its section. */
  opens: boolean;
  /** 0 calm to 1 loud and dense. */
  energy: number;
}

interface Grid {
  music: MusicTimeline | null;
  fps: number;
  pace: number;
  minimum: number;
  maximum: number;
}

/** Clip length wanted at `frame` of a section: its kind's seconds (shortening through a build or peak) at the pace. */
function wantedLength(grid: Grid, frame: number, section: MusicSection | null): number {
  const { fps, pace } = grid;
  let seconds = AUTO_EDIT.beatlessSeconds;
  if (section) {
    const [first, last] = AUTO_EDIT.seconds[section.kind];
    const share = Math.min(1, Math.max(0, (frame - section.start) / (section.end - section.start)));
    seconds = first + (last - first) * share;
  }
  return Math.round(Math.min(grid.maximum, Math.max(grid.minimum, seconds * pace * fps)));
}

function nearestWithin(frames: readonly number[], target: number, low: number, high: number): number | undefined {
  let best: number | undefined;
  for (const frame of frames)
    if (frame >= low && frame <= high && (best === undefined || Math.abs(frame - target) < Math.abs(best - target)))
      best = frame;
  return best;
}

/** The boundary after `position`: the downbeat nearest the wanted length (a strong hit within a beat of it wins), else a beat, else a strong hit. */
function nextBoundary(grid: Grid, position: number, wanted: number, limit: number): number {
  const low = position + Math.max(grid.minimum, Math.round(AUTO_EDIT.reach[0] * wanted));
  const high = Math.min(limit - grid.minimum, position + Math.round(AUTO_EDIT.reach[1] * wanted));
  const target = position + wanted;
  if (high < low) return Math.min(limit, Math.max(low, target));
  const music = grid.music;
  if (!music) return Math.min(high, Math.max(low, target));
  const beat = beatLength(music, target, grid.fps);
  const downbeat = nearestWithin(music.downbeats, target, low, high);
  if (downbeat !== undefined) {
    const hit = nearestWithin(
      music.strongHits,
      downbeat,
      Math.max(low, downbeat - beat),
      Math.min(high, downbeat + beat),
    );
    return hit ?? downbeat;
  }
  const beats = music.beats.map((item) => item.frame);
  return (
    nearestWithin(beats, target, low, high) ??
    nearestWithin(music.strongHits, target, low, high) ??
    Math.min(high, Math.max(low, target))
  );
}

/** Section starts, sudden swells and silence edges inside the span, each on its nearest beat. */
function forcedBoundaries(music: MusicTimeline | null, span: CutSpan, minimum: number, fps: number): number[] {
  if (!music) return [];
  const beats = music.beats.map((beat) => beat.frame);
  const onBeat = (frame: number) => {
    const reach = beatLength(music, frame, fps);
    return nearestWithin(beats, frame, frame - reach, frame + reach) ?? frame;
  };
  const frames = [
    ...music.sections.map((section) => section.start),
    ...music.swells,
    ...music.silences.flatMap((silence) => [silence.start, silence.end]),
  ]
    .map(onBeat)
    .filter((frame) => frame - span.start >= minimum && span.end - frame >= minimum);
  const sorted = unique(frames);
  return sorted.filter((frame, index) => index === 0 || frame - sorted[index - 1]! >= minimum);
}

function sectionAt(music: MusicTimeline | null, frame: number): { section: MusicSection | null; index: number } {
  const index = music?.sections.findIndex((section) => frame >= section.start && frame < section.end) ?? -1;
  return { section: index >= 0 ? music!.sections[index]! : null, index };
}

/** Slots of one stretch between forced boundaries. */
function stretchSlots(grid: Grid, from: number, to: number): { start: number; end: number }[] {
  const slots: { start: number; end: number }[] = [];
  let position = from;
  while (position < to) {
    const wanted = wantedLength(grid, position, sectionAt(grid.music, position).section);
    const remaining = to - position;
    if (remaining <= AUTO_EDIT.lastPiece * wanted || remaining < 2 * grid.minimum) {
      if (remaining < grid.minimum && slots.length) slots.at(-1)!.end = to;
      else slots.push({ start: position, end: to });
      break;
    }
    const boundary = nextBoundary(grid, position, wanted, to);
    slots.push({ start: position, end: boundary });
    position = boundary;
  }
  return slots;
}

/** Splits slots longer than the longest clip at their downbeat nearest the middle. */
function splitLong(grid: Grid, slots: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  return slots.flatMap((slot) => {
    if (slot.end - slot.start <= grid.maximum) return [slot];
    const middle = Math.round((slot.start + slot.end) / 2);
    const candidates = grid.music ? [...grid.music.downbeats, ...grid.music.beats.map((beat) => beat.frame)] : [];
    const split = nearestWithin(candidates, middle, slot.start + grid.minimum, slot.end - grid.minimum) ?? middle;
    return splitLong(grid, [
      { start: slot.start, end: split },
      { start: split, end: slot.end },
    ]);
  });
}

/** Merges the shortest slot into its shorter neighbor until at most `count` remain. */
export function mergeSlots<T extends { start: number; end: number }>(slots: readonly T[], count: number): T[] {
  const merged = slots.map((slot) => ({ ...slot }));
  while (merged.length > Math.max(1, count)) {
    let shortest = 0;
    merged.forEach((slot, index) => {
      if (slot.end - slot.start < merged[shortest]!.end - merged[shortest]!.start) shortest = index;
    });
    const before = merged[shortest - 1];
    const after = merged[shortest + 1];
    const intoBefore = before && (!after || before.end - before.start <= after.end - after.start);
    if (intoBefore) before.end = merged[shortest]!.end;
    else after!.start = merged[shortest]!.start;
    merged.splice(shortest, 1);
  }
  return merged;
}

/**
 * The music's time grid for the cut: slots between section changes, swells and silences, each as long as its
 * section wants at the pace and ending on a downbeat (a strong hit near it wins), else a beat or a hit; without
 * music, even slots. At most `maxClips` slots, merging the shortest.
 */
export function planSlots(
  music: MusicTimeline | null,
  span: CutSpan,
  options: { pace: number; fps: number; maxClips: number | null },
): Slot[] {
  const { fps, pace } = options;
  const grid: Grid = {
    music,
    fps,
    pace,
    minimum: Math.round(AUTO_EDIT.minimumSeconds * fps),
    maximum: Math.round(AUTO_EDIT.maximumSeconds * fps),
  };
  const bounds = [span.start, ...forcedBoundaries(music, span, grid.minimum, fps), span.end];
  let slots = splitLong(
    grid,
    bounds.slice(1).flatMap((end, index) => stretchSlots(grid, bounds[index]!, end)),
  );
  if (options.maxClips !== null) slots = mergeSlots(slots, options.maxClips);
  const loudness = slots.map((slot) => music?.loudness(slot.start, slot.end) ?? 0);
  const ranked = loudness.map((value) =>
    slots.length < 2 ? 0.5 : loudness.filter((other) => other < value).length / (slots.length - 1),
  );
  return slots.map((slot, index) => {
    const { section, index: sectionIndex } = sectionAt(music, slot.start);
    const kind = section?.kind ?? null;
    const base = kind ? AUTO_EDIT.energy.sections[kind] : 0.5;
    return {
      ...slot,
      kind,
      section: sectionIndex,
      opens: index === 0 || sectionAt(music, slots[index - 1]!.start).index !== sectionIndex,
      energy: music ? 0.5 * base + 0.5 * ranked[index]! : 0.5,
    };
  });
}
