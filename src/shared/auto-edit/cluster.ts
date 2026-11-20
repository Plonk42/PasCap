import { layoutSimilarity } from '../look-match.js';
import { AUTO_EDIT } from './constants.js';
import type { Candidate } from './candidates.js';

/** The best similarity of any frame of one candidate to any frame of the other, −1 to 1; 0 without pictures. */
export function candidateSimilarity(left: Candidate, right: Candidate): number {
  if (!left.pictures || !right.pictures) return 0;
  let best = -1;
  for (const a of left.pictures.layouts)
    for (const b of right.pictures.layouts) best = Math.max(best, layoutSimilarity(a, b));
  return best;
}

/** Whether flight data and flight order put two candidates near each other. */
function near(left: Candidate, right: Candidate): boolean {
  const { height, distance, order } = AUTO_EDIT.cluster.near;
  if (Math.abs(left.recording - right.recording) > order) return false;
  const a = left.flight;
  const b = right.flight;
  if (typeof a?.height !== 'number' || typeof b?.height !== 'number') return left.mediaId === right.mediaId;
  const far = a.distance !== null && b.distance !== null && Math.abs(a.distance - b.distance) > distance;
  return Math.abs(a.height - b.height) <= height && !far;
}

/** Whether two candidates show the same subject: alike pictures, more readily when filmed near each other. */
export function alike(left: Candidate, right: Candidate, similarity = candidateSimilarity(left, right)): boolean {
  return similarity >= (near(left, right) ? AUTO_EDIT.cluster.nearSimilar : AUTO_EDIT.cluster.similar);
}

/**
 * Takes of one subject grouped: single-link clustering of alike candidates, most alike first, a cluster spanning at
 * most AUTO_EDIT.cluster.span recordings of flight order. Returns each candidate's cluster, numbered from 0 in the
 * order of their first candidate.
 */
export function clusterCandidates(candidates: readonly Candidate[]): number[] {
  const parent = candidates.map((_, index) => index);
  const span = candidates.map((candidate) => ({ low: candidate.recording, high: candidate.recording }));
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index] = parent[parent[index]!]!;
    return index;
  };
  const edges: { a: number; b: number; similarity: number }[] = [];
  for (let a = 0; a < candidates.length; a++)
    for (let b = a + 1; b < candidates.length; b++) {
      const similarity = candidateSimilarity(candidates[a]!, candidates[b]!);
      if (alike(candidates[a]!, candidates[b]!, similarity)) edges.push({ a, b, similarity });
    }
  edges.sort((left, right) => right.similarity - left.similarity);
  for (const { a, b } of edges) {
    const ra = root(a);
    const rb = root(b);
    if (ra === rb) continue;
    const low = Math.min(span[ra]!.low, span[rb]!.low);
    const high = Math.max(span[ra]!.high, span[rb]!.high);
    if (high - low > AUTO_EDIT.cluster.span) continue;
    parent[rb] = ra;
    span[ra] = { low, high };
  }
  const numbers = new Map<number, number>();
  return candidates.map((_, index) => {
    const key = root(index);
    if (!numbers.has(key)) numbers.set(key, numbers.size);
    return numbers.get(key)!;
  });
}
