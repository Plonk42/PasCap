import type { EditCommand } from './commands.js';
import { compileLayerRetiming } from './layer-retiming.js';
import type { ProjectDocument, VideoClip, VideoLayer } from './model.js';
import { clipDuration } from './speed.js';
import { calculateLayout } from './timeline.js';

export type TrimEdge = 'in' | 'out';

/** A trim selects frames in the unchanged recording; it never changes source bounds. */
export function trimByFrames(clip: VideoClip, edge: TrimEdge, delta: number, sourceFrameCount: number): Extract<EditCommand, { type: 'trim' }> {
  if ((edge !== 'in' && edge !== 'out') || !Number.isSafeInteger(delta) || !Number.isSafeInteger(sourceFrameCount) || sourceFrameCount < clip.sourceOut || sourceFrameCount > 2_147_483_647) {
    throw new Error('Trim needs integer frames and the complete registered source duration.');
  }
  const sourceIn = edge === 'in' ? Math.max(0, Math.min(clip.sourceOut - 1, clip.sourceIn + delta)) : clip.sourceIn;
  const sourceOut = edge === 'out' ? Math.max(clip.sourceIn + 1, Math.min(sourceFrameCount, clip.sourceOut + delta)) : clip.sourceOut;
  return { type: 'trim', clipId: clip.id, sourceIn, sourceOut };
}

export function validateSourceRanges(project: ProjectDocument, frameCounts: ReadonlyMap<string, number>): void {
  for (const clip of project.clips) {
    const count = frameCounts.get(clip.mediaId);
    if (count === undefined || !Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(clip.sourceIn) || !Number.isSafeInteger(clip.sourceOut) || clip.sourceIn < 0 || clip.sourceOut <= clip.sourceIn || clip.sourceOut > count) {
      throw new Error('Source range exceeds the registered recording. The edit was not committed.');
    }
  }
}

/** Find an original endpoint whose retimed duration matches a pointer delta. */
export function trimByOutputFrames(clip: VideoClip, edge: TrimEdge, delta: number, sourceFrameCount: number): Extract<EditCommand, { type: 'trim' }> {
  trimByFrames(clip, edge, 0, sourceFrameCount);
  if (!Number.isSafeInteger(delta)) throw new Error('Trim needs integer output frames.');
  if (delta === 0) return trimByFrames(clip, edge, 0, sourceFrameCount);
  if (clip.speed.mode === 'constant') return trimByFrames(clip, edge, Math.round(delta * clip.speed.rate), sourceFrameCount);
  const target = Math.max(1, clipDuration(clip) + (edge === 'in' ? -delta : delta));
  return trimToDuration(clip, edge, sourceFrameCount, target, (candidate) => durationOrInfinity(() => clipDuration(candidate)));
}

function durationOrInfinity(compile: () => number): number {
  try { return compile(); }
  catch (error) {
    // An over-long candidate is the high end of a monotonic search, not a
    // reason to default malformed speed/key data or allocate a frame array.
    if (error instanceof RangeError) return Infinity;
    throw error;
  }
}
function contextualDuration(clip: VideoClip, layer: VideoLayer, start: number): number {
  return durationOrInfinity(() => compileLayerRetiming(clip, layer, start).duration);
}

/** Rounding creates duration plateaus. Select the endpoint nearest the current
 * source range across the whole plateau, not an arbitrary binary-search hit.
 */
function closestDurationEndpoint(minimum: number, maximum: number, current: number, duration: number, increasing: boolean, durationAt: (endpoint: number) => number): number {
  const direction = increasing ? 1 : -1;
  const target = duration * direction;
  let low = minimum; let high = maximum;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (durationAt(middle) * direction < target) low = middle + 1;
    else high = middle;
  }
  const first = low;
  high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (durationAt(middle) * direction > target) high = middle - 1;
    else low = middle;
  }
  return Math.max(first, Math.min(low, current));
}

function nearestEndpoint(low: number, high: number, current: number, target: number, increasing: boolean, durationAt: (endpoint: number) => number): number {
  const minimum = low; const maximum = high;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const duration = durationAt(middle);
    if (increasing ? duration < target : duration > target) low = middle + 1;
    else high = middle - 1;
  }
  let best = increasing ? minimum : maximum;
  let bestError = Infinity;
  const candidates = new Set([Math.max(minimum, Math.min(maximum, low)), Math.max(minimum, Math.min(maximum, high))]);
  for (const endpoint of candidates) {
    const duration = durationAt(endpoint);
    if (!Number.isFinite(duration)) continue;
    const closest = closestDurationEndpoint(minimum, maximum, current, duration, increasing, durationAt);
    const error = Math.abs(duration - target);
    if (error < bestError || (error === bestError && Math.abs(closest - current) < Math.abs(best - current))) {
      best = closest; bestError = error;
    }
  }
  return best;
}

function trimToDuration(clip: VideoClip, edge: TrimEdge, sourceFrameCount: number, target: number, durationAt: (candidate: VideoClip) => number): Extract<EditCommand, { type: 'trim' }> {
  const range = edge === 'in' ? { minimum: 0, maximum: clip.sourceOut - 1, current: clip.sourceIn } : { minimum: clip.sourceIn + 1, maximum: sourceFrameCount, current: clip.sourceOut };
  const endpoint = nearestEndpoint(range.minimum, range.maximum, range.current, target, edge === 'out', (value) => durationAt(edge === 'in' ? { ...clip, sourceIn: value } : { ...clip, sourceOut: value }));
  return { type: 'trim', clipId: clip.id, sourceIn: edge === 'in' ? endpoint : clip.sourceIn, sourceOut: edge === 'out' ? endpoint : clip.sourceOut };
}

/** Find a nonnegative integer start with exactly the retained OUT. With row
 * keys, end(start) is monotonic even when the rate changes at the new start.
 * Integer-source quantisation can skip an end; never silently move that OUT.
 */
function startForRightEdge(clip: VideoClip, layer: VideoLayer, right: number, preferred: number): number | null {
  const endAt = (start: number): number => start + contextualDuration(clip, layer, start);
  let low = 0; let high = right - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (endAt(middle) < right) low = middle + 1;
    else high = middle;
  }
  const first = low;
  if (endAt(first) !== right) return null;
  high = right - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (endAt(middle) > right) high = middle - 1;
    else low = middle;
  }
  return Math.max(first, Math.min(low, preferred));
}

function minimumOverlayIn(clip: VideoClip, layer: VideoLayer, right: number): number {
  // Clamp restoration at project frame zero, taking the absolute row-rate
  // curve into account rather than subtracting a duration compiled at old IN.
  let low = 0; let high = clip.sourceOut - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (contextualDuration({ ...clip, sourceIn: middle }, layer, 0) > right) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sourceOverlayTrim(clip: VideoClip, layer: VideoLayer, right: number, sourceIn: number, preferred: number): Extract<EditCommand, { type: 'trim-place' }> {
  sourceIn = Math.max(minimumOverlayIn(clip, layer, right), sourceIn);
  const start = startForRightEdge({ ...clip, sourceIn }, layer, right, preferred);
  if (start === null) throw new Error('This source-frame trim cannot keep the overlay OUT at an integer project frame.');
  return { type: 'trim-place', clipId: clip.id, sourceIn, sourceOut: clip.sourceOut, start };
}

interface LeftTrim { sourceIn: number; start: number }
function betterLeftTrim(candidate: LeftTrim, best: LeftTrim | null, preferred: number, currentIn: number): boolean {
  if (!best) return true;
  const error = Math.abs(candidate.start - preferred); const bestError = Math.abs(best.start - preferred);
  return error < bestError || (error === bestError && Math.abs(candidate.sourceIn - currentIn) < Math.abs(best.sourceIn - currentIn));
}

function outputOverlayTrim(clip: VideoClip, layer: VideoLayer, right: number, delta: number): Extract<EditCommand, { type: 'trim-place' }> {
  const minimumIn = minimumOverlayIn(clip, layer, right);
  const preferred = Math.max(0, Math.min(right - 1, clip.start + delta));
  const target = right - preferred;
  const endpoint = nearestEndpoint(minimumIn, clip.sourceOut - 1, clip.sourceIn, target, false, (sourceIn) => contextualDuration({ ...clip, sourceIn }, layer, preferred));
  let best: LeftTrim | null = null;
  for (const sourceIn of new Set([endpoint, endpoint - 1, endpoint + 1])) {
    if (sourceIn < minimumIn || sourceIn >= clip.sourceOut) continue;
    const start = startForRightEdge({ ...clip, sourceIn }, layer, right, preferred);
    if (start !== null && betterLeftTrim({ sourceIn, start }, best, preferred, clip.sourceIn)) best = { sourceIn, start };
  }
  if (!best) throw new Error('This output-frame trim cannot keep the overlay OUT at an integer project frame.');
  return { type: 'trim-place', clipId: clip.id, sourceIn: best.sourceIn, sourceOut: clip.sourceOut, start: best.start };
}

/** Timeline handle/keyboard trim. Overlay IN retains the old right edge;
 * primary IN retains its ripple start. Numeric IN/OUT edits continue to use
 * the ordinary trim command, which never changes stored placement.
 * Region/overlap validation and history are left to applyCommand by the caller.
 */
export function trimOnTimeline(project: ProjectDocument, clipId: string, edge: TrimEdge, delta: number, sourceFrameCount: number, unit: 'output' | 'source'): EditCommand {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId);
  if (!placed) throw new Error('Clip no longer exists.');
  const clip = placed.clip;
  const layer = project.layers.find((item) => item.id === clip.layerId)!;
  const sourceCommand = trimByFrames(clip, edge, delta, sourceFrameCount);
  if (unit !== 'output' && unit !== 'source') throw new Error('Trim unit must be output or source frames.');
  if (edge !== 'in' || clip.layerId === project.layers[0]!.id) {
    if (unit === 'source') return sourceCommand;
    const target = Math.max(1, placed.duration + (edge === 'in' ? -delta : delta));
    return trimToDuration(clip, edge, sourceFrameCount, target, (candidate) => contextualDuration(candidate, layer, placed.start));
  }
  if (delta === 0) return { ...sourceCommand, type: 'trim-place', start: placed.start };
  if (unit === 'source') return sourceOverlayTrim(clip, layer, placed.end, sourceCommand.sourceIn, placed.start);
  return outputOverlayTrim(clip, layer, placed.end, delta);
}