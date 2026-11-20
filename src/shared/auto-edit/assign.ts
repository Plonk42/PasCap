import type { ShotKind } from '../recording-shots.js';
import { AUTO_EDIT } from './constants.js';
import type { Slot } from './music.js';

/** What the assignment needs of a candidate. */
export interface AssignedCandidate {
  quality: number;
  energy: number;
  kind: ShotKind;
  establishing: boolean;
  /** Project frames it lasts at normal speed. */
  frames: number;
  /** False for a take that is not the best of its cluster. */
  best: boolean;
}

export interface Assignment {
  /** The candidate index of each filled slot, from the first slot on. */
  picks: number[];
  score: number;
}

const INVALID = Number.NEGATIVE_INFINITY;
const FRAGMENTED: ReadonlySet<ShotKind> = new Set(['reveal', 'approach']);

/**
 * How well a candidate fills a slot: 0 (invalid) when shorter, 1 when it holds about the slot, less when the slot
 * shows only a fragment of a much longer reveal or approach, whose payoff a window may miss.
 */
export function slotFit(candidate: Pick<AssignedCandidate, 'frames' | 'kind'>, slotFrames: number): number {
  if (candidate.frames < slotFrames) return 0;
  const fragment = Math.min(1, Math.max(0, (candidate.frames / slotFrames - 2) / 4));
  const share = FRAGMENTED.has(candidate.kind) ? AUTO_EDIT.score.fragment : AUTO_EDIT.score.fragment / 2;
  return 1 - share * fragment;
}

/** A candidate's score in a slot, without the repeated-kind penalty; −∞ when it cannot fill it. */
export function slotScore(candidate: AssignedCandidate, slot: Slot, first: boolean): number {
  const fit = slotFit(candidate, slot.end - slot.start);
  if (fit === 0) return INVALID;
  const { score } = AUTO_EDIT;
  const opening = first ? 1.5 : 1;
  const establishing = candidate.establishing && slot.opens ? score.establishing * opening : 0;
  return (
    candidate.quality * fit * (candidate.best ? 1 : score.duplicate) -
    score.energy * Math.abs(candidate.energy - slot.energy) +
    establishing
  );
}

interface Row {
  values: Float64Array;
  parents: Int32Array;
}

/** The best total over earlier candidates for candidate `i`, a repeated kind penalized. */
function bestBefore(best: readonly { value: number; index: number }[], kind: number): { value: number; index: number } {
  let from = { value: INVALID, index: -1 };
  best.forEach((entry, k) => {
    const value = entry.value - (k === kind ? AUTO_EDIT.score.repeatKind : 0);
    if (entry.index >= 0 && value > from.value) from = { value, index: entry.index };
  });
  return from;
}

/** One slot's best totals per candidate, from the previous slot's row: candidates only follow earlier ones. */
function orderedRow(
  candidates: readonly AssignedCandidate[],
  kindOf: readonly number[],
  kinds: number,
  slot: Slot,
  previous: Float64Array | null,
): Row {
  const values = new Float64Array(candidates.length).fill(INVALID);
  const parents = new Int32Array(candidates.length).fill(-1);
  const best = Array.from({ length: kinds }, () => ({ value: INVALID, index: -1 }));
  candidates.forEach((candidate, i) => {
    const own = slotScore(candidate, slot, previous === null);
    if (previous === null) {
      values[i] = own;
      return;
    }
    const from = own > INVALID ? bestBefore(best, kindOf[i]!) : null;
    if (from && from.index >= 0) {
      values[i] = own + from.value;
      parents[i] = from.index;
    }
    if (previous[i]! > best[kindOf[i]!]!.value) best[kindOf[i]!] = { value: previous[i]!, index: i };
  });
  return { values, parents };
}

/**
 * Candidates in flight order assigned to slots in time order, each used once and in increasing order, by dynamic
 * programming; a repeated kind costs AUTO_EDIT.score.repeatKind. When the slots cannot all be filled, the longest
 * prefix that can is.
 */
export function assignInOrder(candidates: readonly AssignedCandidate[], slots: readonly Slot[]): Assignment {
  const kinds = [...new Set(candidates.map((candidate) => candidate.kind))];
  const kindOf = candidates.map((candidate) => kinds.indexOf(candidate.kind));
  const rows: Row[] = [];
  for (const slot of slots) {
    const row = orderedRow(candidates, kindOf, kinds.length, slot, rows.at(-1)?.values ?? null);
    if (!row.values.some((value) => value > INVALID)) break;
    rows.push(row);
  }
  if (!rows.length) return { picks: [], score: 0 };
  const last = rows.at(-1)!.values;
  const score = Math.max(...last);
  let index = last.indexOf(score);
  const picks: number[] = [];
  for (let j = rows.length - 1; j >= 0; j--) {
    picks.unshift(index);
    index = rows[j]!.parents[index]!;
  }
  return { picks, score };
}

const UNFILLED = 1e6;

/** Kuhn–Munkres state over rows ≤ columns, 1-indexed with column 0 as the root. */
class Munkres {
  readonly owner: Int32Array;
  readonly #u: Float64Array;
  readonly #v: Float64Array;
  readonly #way: Int32Array;
  constructor(
    private readonly cost: readonly (readonly number[])[],
    private readonly columns: number,
  ) {
    this.#u = new Float64Array(cost.length + 1);
    this.#v = new Float64Array(columns + 1);
    this.owner = new Int32Array(columns + 1);
    this.#way = new Int32Array(columns + 1);
  }

  /** Grows the matching by `row` along the cheapest augmenting path. */
  add(row: number): void {
    this.owner[0] = row;
    let column = 0;
    const least = new Float64Array(this.columns + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(this.columns + 1);
    do {
      used[column] = 1;
      const { delta, next } = this.#scan(this.owner[column]!, column, least, used);
      this.#shift(delta, least, used);
      column = next;
    } while (this.owner[column] !== 0);
    do {
      const previous = this.#way[column]!;
      this.owner[column] = this.owner[previous]!;
      column = previous;
    } while (column);
  }

  #scan(current: number, column: number, least: Float64Array, used: Uint8Array) {
    let delta = Number.POSITIVE_INFINITY;
    let next = 0;
    for (let j = 1; j <= this.columns; j++) {
      if (used[j]) continue;
      const reduced = this.cost[current - 1]![j - 1]! - this.#u[current]! - this.#v[j]!;
      if (reduced < least[j]!) {
        least[j] = reduced;
        this.#way[j] = column;
      }
      if (least[j]! < delta) {
        delta = least[j]!;
        next = j;
      }
    }
    return { delta, next };
  }

  #shift(delta: number, least: Float64Array, used: Uint8Array): void {
    for (let j = 0; j <= this.columns; j++) {
      if (used[j]) {
        const row = this.owner[j]!;
        this.#u[row] = this.#u[row]! + delta;
        this.#v[j] = this.#v[j]! - delta;
      } else least[j] = least[j]! - delta;
    }
  }
}

/** Minimum-cost assignment of every row to a distinct column (rows ≤ columns): the column of each row. */
export function hungarian(cost: readonly (readonly number[])[], columns: number): number[] {
  const solver = new Munkres(cost, columns);
  for (let row = 1; row <= cost.length; row++) solver.add(row);
  const assigned = new Array<number>(cost.length).fill(-1);
  for (let j = 1; j <= columns; j++) if (solver.owner[j]) assigned[solver.owner[j]! - 1] = j - 1;
  return assigned;
}

/** The cheapest swap moving slot j's pick away from a neighbor of its kind, or null. */
function cheapestSwap(
  candidates: readonly AssignedCandidate[],
  slots: readonly Slot[],
  picks: readonly number[],
  j: number,
): number | null {
  const value = (i: number, k: number) => slotScore(candidates[i]!, slots[k]!, k === 0);
  const kind = candidates[picks[j]!]!.kind;
  let best: { k: number; loss: number } | null = null;
  for (let k = 0; k < picks.length; k++) {
    if (Math.abs(k - j) <= 1 || candidates[picks[k]!]!.kind === kind) continue;
    const swapped = value(picks[k]!, j) + value(picks[j]!, k);
    const loss = value(picks[j]!, j) + value(picks[k]!, k) - swapped;
    if (swapped > INVALID && loss < AUTO_EDIT.score.repeatKind && (!best || loss < best.loss)) best = { k, loss };
  }
  return best?.k ?? null;
}

/** Swaps picks of adjacent slots showing the same kind when another slot's pick fits both places. */
function diversify(candidates: readonly AssignedCandidate[], slots: readonly Slot[], picks: number[]): void {
  const kind = (j: number) => candidates[picks[j]!]!.kind;
  const repeats = (j: number) =>
    (j > 0 && kind(j) === kind(j - 1)) || (j < picks.length - 1 && kind(j) === kind(j + 1));
  for (let j = 1; j < picks.length; j++) {
    if (kind(j) !== kind(j - 1)) continue;
    const k = cheapestSwap(candidates, slots, picks, j);
    if (k === null) continue;
    [picks[j], picks[k]] = [picks[k]!, picks[j]!];
    if (repeats(k)) [picks[j], picks[k]] = [picks[k]!, picks[j]!];
  }
}

/**
 * Candidates in any order: the assignment of slots to distinct candidates with the highest total score, then
 * adjacent repeated kinds swapped apart where it costs little. When the slots cannot all be filled, the longest
 * prefix that can is.
 */
export function assignByEnergy(candidates: readonly AssignedCandidate[], slots: readonly Slot[]): Assignment {
  let length = Math.min(slots.length, candidates.length);
  while (length > 0) {
    const used = slots.slice(0, length);
    const cost = used.map((slot, j) =>
      candidates.map((candidate) => {
        const value = slotScore(candidate, slot, j === 0);
        return value === INVALID ? UNFILLED : -value;
      }),
    );
    const picks = hungarian(cost, candidates.length);
    const unfilled = picks.findIndex((i, j) => i < 0 || cost[j]![i]! >= UNFILLED);
    if (unfilled < 0) {
      diversify(candidates, used, picks);
      const score = picks.reduce((sum, i, j) => sum + slotScore(candidates[i]!, used[j]!, j === 0), 0);
      return { picks, score };
    }
    length = Math.min(length - 1, unfilled);
  }
  return { picks: [], score: 0 };
}
