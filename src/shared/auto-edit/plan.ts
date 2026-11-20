import { NORMAL_SPEED, clipDuration } from '../speed.js';
import { sourceFramesPerProjectFrame } from '../timing.js';
import { assignByEnergy, assignInOrder, type Assignment } from './assign.js';
import type { Candidate } from './candidates.js';
import { clusterCandidates } from './cluster.js';
import { AUTO_EDIT } from './constants.js';
import { barBeats, beatLength, cutSpan, planSlots, type CutSpan, type MusicTimeline, type Slot } from './music.js';
import type { AutoEditChoices } from './options.js';

export interface PlannedClip {
  candidate: Candidate;
  cluster: number;
  slot: Slot;
  sourceIn: number;
  sourceOut: number;
  reasons: string[];
}

export type PlannedTransition =
  { type: 'cut' } | { type: 'cross-dissolve'; duration: number } | { type: 'fade-through-black'; duration: number };

export interface AutoEditPlan {
  /** Where the clips lie: from the music's (or frame 0) to the last clip's end. */
  span: CutSpan;
  clips: PlannedClip[];
  /** One per pair of adjacent clips. */
  transitions: PlannedTransition[];
  openingFade: number;
  closingFade: number;
  /** Each candidate's cluster of alike takes. */
  clusters: number[];
  /** Why the cut is shorter than the music or target, or null. */
  shortfall: string | null;
}

export interface PlanInput {
  /** Scored candidates in flight order. */
  candidates: readonly Candidate[];
  music: MusicTimeline | null;
  /** Wanted length in project frames; null follows the music, or the footage without music. */
  targetFrames: number | null;
  choices: AutoEditChoices;
  maxClips: number | null;
  /** Project frames per second. */
  fps: number;
}

/** The source frames of a recording that last exactly `frames` project frames at normal speed, or the nearest. */
export function sourceLengthFor(frames: number, candidate: Pick<Candidate, 'rate'>): number {
  const guess = Math.max(1, Math.round(frames * sourceFramesPerProjectFrame(candidate.rate)));
  for (const offset of [0, -1, 1, -2, 2]) {
    const length = guess + offset;
    if (
      length > 0 &&
      clipDuration({ sourceIn: 0, sourceOut: length, speed: NORMAL_SPEED, reverse: false }, candidate.rate) === frames
    )
      return length;
  }
  return guess;
}

/**
 * The part of a candidate a slot shows: all of it when it fits; else the end of a reveal (its payoff), the start of
 * an approach, the middle of other movements, inside the movement's ramps where it can.
 */
export function shotWindow(candidate: Candidate, frames: number): { sourceIn: number; sourceOut: number } {
  const { sourceIn: a, sourceOut: b, active } = candidate;
  const length = Math.min(b - a, sourceLengthFor(frames, candidate));
  const clamp = (start: number) => Math.min(b - length, Math.max(a, start));
  let start: number;
  if (candidate.kind === 'reveal') start = clamp(Math.max(a + length, active.sourceOut) - length);
  else if (candidate.kind === 'approach') start = clamp(active.sourceIn);
  else start = clamp(Math.round((active.sourceIn + active.sourceOut - length) / 2));
  return { sourceIn: start, sourceOut: start + length };
}

/** The best quality of each cluster, by candidate. */
function bestOfClusters(candidates: readonly Candidate[], clusters: readonly number[]): boolean[] {
  const best = new Map<number, number>();
  candidates.forEach((candidate, index) => {
    const known = best.get(clusters[index]!);
    if (known === undefined || candidate.quality > candidates[known]!.quality) best.set(clusters[index]!, index);
  });
  return candidates.map((_, index) => best.get(clusters[index]!) === index);
}

/** Assignment of the `variant`-th alternative: candidates chosen by earlier variants keep less of their quality. */
function assignVariant(
  candidates: readonly Candidate[],
  best: readonly boolean[],
  slots: readonly Slot[],
  choices: AutoEditChoices,
): Assignment {
  const uses = candidates.map(() => 0);
  let result: Assignment = { picks: [], score: 0 };
  for (let variant = 0; variant <= choices.variant; variant++) {
    const assigned = candidates.map((candidate, index) => ({
      ...candidate,
      quality: candidate.quality * AUTO_EDIT.variantShare ** uses[index]!,
      best: best[index]!,
    }));
    result = choices.order === 'flight' ? assignInOrder(assigned, slots) : assignByEnergy(assigned, slots);
    for (const index of result.picks) uses[index]!++;
  }
  return result;
}

/** Without music: the target, else as long as the best take of each cluster fills a clip at the pace. */
function beatlessSpan(candidates: readonly Candidate[], best: readonly boolean[], input: PlanInput): CutSpan {
  if (input.targetFrames !== null) return { start: 0, end: input.targetFrames };
  const length = Math.round(AUTO_EDIT.beatlessSeconds * AUTO_EDIT.pace[input.choices.pace] * input.fps);
  const clips = candidates.filter((candidate, index) => best[index] && candidate.frames >= length).length;
  const count = input.maxClips === null ? clips : Math.min(clips, input.maxClips);
  return { start: 0, end: Math.max(1, count) * length };
}

interface Attempt {
  slots: Slot[];
  assignment: Assignment;
  covered: number;
  pool: number[];
}

/** Slots at the pace times `multiplier`, filled from the candidates of `pool` (indices). */
function attempt(
  candidates: readonly Candidate[],
  clusters: readonly number[],
  pool: number[],
  multiplier: number,
  span: CutSpan,
  input: PlanInput,
): Attempt {
  const members = pool.map((index) => candidates[index]!);
  const best = bestOfClusters(
    members,
    pool.map((index) => clusters[index]!),
  );
  const slots = planSlots(input.music, span, {
    pace: AUTO_EDIT.pace[input.choices.pace] * multiplier,
    fps: input.fps,
    maxClips: input.maxClips,
  });
  const assignment = assignVariant(members, best, slots, input.choices);
  const filled = slots.slice(0, assignment.picks.length);
  return { slots, assignment, covered: filled.length ? filled.at(-1)!.end - span.start : 0, pool };
}

/** Candidates worth using first: at least AUTO_EDIT.weakShare of the median quality. */
function strongPool(candidates: readonly Candidate[]): number[] {
  const qualities = candidates.map((candidate) => candidate.quality).sort((a, b) => a - b);
  const floor = AUTO_EDIT.weakShare * (qualities[qualities.length >> 1] ?? 0);
  return candidates.flatMap((candidate, index) => (candidate.quality >= floor ? [index] : []));
}

/**
 * The shots filling the cut, as indices into `candidates` with their slots: the strong candidates at a pace near the
 * one asked, else every candidate at the nearest pace that fills the cut, else the attempt that fills most of it.
 */
function chooseShots(
  candidates: readonly Candidate[],
  clusters: readonly number[],
  span: CutSpan,
  input: PlanInput,
): { slots: Slot[]; picks: number[] } {
  const all = candidates.map((_, index) => index);
  const strong = strongPool(candidates);
  const plans: [number[], number][] = [
    ...(strong.length < all.length ? AUTO_EDIT.strongPaces.map((pace): [number[], number] => [strong, pace]) : []),
    ...AUTO_EDIT.paceFallbacks.map((pace): [number[], number] => [all, pace]),
  ];
  let chosen: Attempt | null = null;
  for (const [pool, multiplier] of plans) {
    const tried = attempt(candidates, clusters, pool, multiplier, span, input);
    if (!chosen || tried.covered > chosen.covered) chosen = tried;
    if (tried.covered >= span.end - span.start) break;
  }
  return { slots: chosen!.slots, picks: chosen!.assignment.picks.map((index) => chosen!.pool[index]!) };
}

function sectionName(slot: Slot): string {
  return slot.kind ? `the ${slot.kind} section` : 'the cut';
}

/** Why a clip was chosen, in a few words each. */
function reasonsFor(candidate: Candidate, slot: Slot, index: number, alike: number, bestOfCluster: boolean): string[] {
  const reasons = [`${candidate.kind} (${candidate.motion})`];
  if (candidate.establishing && slot.opens)
    reasons.push(index === 0 ? 'establishing shot, opens the cut' : `establishing shot, opens ${sectionName(slot)}`);
  else if (slot.opens && index > 0) reasons.push(`opens ${sectionName(slot)}`);
  if (slot.kind === 'peak' && candidate.energy >= 0.6) reasons.push('lively shot on the peak');
  if (slot.kind === 'quiet' && candidate.energy <= 0.4) reasons.push('calm shot on quiet music');
  if (alike > 1)
    reasons.push(bestOfCluster ? `best of ${alike} alike takes` : `another take of a subject (${alike} alike takes)`);
  if (candidate.completeness === 1) reasons.push('whole camera movement');
  return reasons;
}

function inSilence(music: MusicTimeline, frame: number, reach: number): boolean {
  return (
    music.silences.some((silence) => frame >= silence.start - reach && frame <= silence.end + reach) ||
    music.drops.some((drop) => Math.abs(drop - frame) <= reach)
  );
}

/** The transition between two adjacent planned clips, by the transitions choice. */
function transitionBetween(
  left: PlannedClip,
  right: PlannedClip,
  music: MusicTimeline | null,
  choices: AutoEditChoices,
  fps: number,
): PlannedTransition {
  if (choices.transitions === 'cuts') return { type: 'cut' };
  const frame = right.slot.start;
  const beat = beatLength(music, frame, fps);
  const shortest = Math.min(left.slot.end - left.slot.start, right.slot.end - right.slot.start);
  if (music && inSilence(music, frame, beat)) {
    const { beats, minimum, maximum } = AUTO_EDIT.fadeThroughBlack;
    const duration = Math.min(shortest, Math.max(minimum, Math.min(maximum, Math.round(beats * beat))));
    if (duration >= 2) return { type: 'fade-through-black', duration: duration - (duration % 2) };
  }
  const { beats, minimum, maximum } = AUTO_EDIT.dissolve;
  const dissolve = {
    type: 'cross-dissolve' as const,
    duration: Math.min(Math.floor(shortest / 3), Math.max(minimum, Math.min(maximum, Math.round(beats * beat)))),
  };
  if (dissolve.duration < 1) return { type: 'cut' };
  const peak = left.slot.kind === 'peak' || right.slot.kind === 'peak';
  if (peak) return { type: 'cut' };
  if (choices.transitions === 'soft') return dissolve;
  const calm = left.slot.section === right.slot.section && (left.slot.kind === 'quiet' || left.slot.kind === 'release');
  const alike = left.cluster === right.cluster || left.candidate.mediaId === right.candidate.mediaId;
  return calm || alike ? dissolve : { type: 'cut' };
}

/** Opening fade up to the music's first beat, closing fade over its last bar, within AUTO_EDIT bounds. */
function fadesOf(music: MusicTimeline | null, span: CutSpan, clips: readonly PlannedClip[], fps: number) {
  const first = clips[0]!;
  const last = clips.at(-1)!;
  const firstBeat = music?.beats.find((beat) => beat.frame >= span.start)?.frame ?? span.start + 12;
  const opening = Math.min(
    Math.round(AUTO_EDIT.openingFade.maximumSeconds * fps),
    Math.max(AUTO_EDIT.openingFade.minimum, firstBeat - span.start),
  );
  const bar = music ? barBeats(music) * beatLength(music, span.end, fps) : fps;
  const closing = Math.min(
    Math.round(AUTO_EDIT.closingFade.maximumSeconds * fps),
    Math.max(Math.round(AUTO_EDIT.closingFade.minimumSeconds * fps), Math.round(bar)),
  );
  const length = (clip: PlannedClip) => clip.slot.end - clip.slot.start;
  return {
    openingFade: Math.min(opening, Math.floor(length(first) / 2)),
    closingFade: Math.min(closing, Math.floor(length(last) / 2)),
  };
}

/**
 * The cut: candidates clustered into takes of one subject, the music's slots built and filled by the assignment
 * (flight order or energy), a window of each shot, the transitions and fades. Throws when no candidate can fill a
 * clip.
 */
export function planAutoEdit(input: PlanInput): AutoEditPlan {
  const { candidates, music, fps } = input;
  if (!candidates.length)
    throw new Error(
      'No steady range inside the kept ranges is long enough for a clip: analyze camera motion or keep more footage.',
    );
  const clusters = clusterCandidates(candidates);
  const best = bestOfClusters(candidates, clusters);
  const span = music ? cutSpan(music, input.targetFrames, fps) : beatlessSpan(candidates, best, input);
  const { slots, picks } = chooseShots(candidates, clusters, span, input);
  if (!picks.length)
    throw new Error(
      'No steady range is long enough for the first clip on the music: keep longer ranges or choose a faster pace.',
    );
  const strong = new Set(strongPool(candidates));
  const sizes = new Map<number, number>();
  for (const cluster of clusters) sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
  const clips = picks.map((index, j) => {
    const candidate = candidates[index]!;
    const slot = slots[j]!;
    const reasons = reasonsFor(candidate, slot, j, sizes.get(clusters[index]!)!, best[index]!);
    if (!strong.has(index)) reasons.push('a weaker shot, used to fill the music: replace it if you can');
    return {
      candidate,
      cluster: clusters[index]!,
      slot,
      ...shotWindow(candidate, slot.end - slot.start),
      reasons,
    };
  });
  const end = clips.at(-1)!.slot.end;
  const wanted = span.end - span.start;
  const shortfall =
    end < span.end
      ? `The steady footage fills ${Math.round((end - span.start) / fps)} of the ${Math.round(wanted / fps)} seconds wanted: keep more or longer ranges for a longer cut.`
      : null;
  const covered = { start: span.start, end };
  return {
    span: covered,
    clips,
    transitions: clips
      .slice(1)
      .map((right, index) => transitionBetween(clips[index]!, right, music, input.choices, fps)),
    ...fadesOf(music, covered, clips, fps),
    clusters,
    shortfall,
  };
}
