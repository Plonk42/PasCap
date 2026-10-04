import { updateClipSpeedKey } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { sourceRateAt, type SpeedCurve } from '../shared/speed.js';
import { calculateLayout } from '../shared/timeline.js';

const MIN_RATE = 0.1; const MAX_RATE = 8;
const LOG_RANGE = Math.log(MAX_RATE / MIN_RATE);
export const speedRatePosition = (rate: number): number => 1 - Math.log(rate / MIN_RATE) / LOG_RANGE;

export function clipSpeedPointer({ originFrame, originRate, deltaX, deltaY, width, height, sourceIn, sourceOut }: Readonly<{ originFrame: number; originRate: number; deltaX: number; deltaY: number; width: number; height: number; sourceIn: number; sourceOut: number }>): { frame: number; rate: number } {
  if (![originFrame, originRate, deltaX, deltaY, width, height, sourceIn, sourceOut].every(Number.isFinite) || width <= 0 || height <= 0 || sourceOut <= sourceIn) throw new Error('Clip curve movement needs valid graph geometry.');
  const frame = Math.max(sourceIn, Math.min(sourceOut, originFrame + Math.round(deltaX / width * (sourceOut - sourceIn))));
  const rawRate = originRate * Math.exp(-deltaY / height * LOG_RANGE);
  const rate = Math.max(MIN_RATE, Math.min(MAX_RATE, Math.round(rawRate * 1000) / 1000));
  return { frame, rate };
}

export function clipCurvePoints(speed: SpeedCurve, sourceIn: number, sourceOut: number): string {
  const length = sourceOut - sourceIn;
  const frames = new Set(Array.from({ length: 129 }, (_, index) => sourceIn + index / 128 * length));
  for (const [index, key] of speed.keyframes.entries()) {
    if (key.frame < sourceIn || key.frame > sourceOut) continue;
    frames.add(key.frame);
    if (index > 0 && speed.keyframes[index - 1]!.interpolation === 'hold' && key.frame > sourceIn) frames.add(key.frame - Math.min(0.001, length / 100_000));
  }
  return [...frames].sort((a, b) => a - b).map((frame) => `${(frame - sourceIn) / length * 100},${speedRatePosition(sourceRateAt(speed, frame)) * 100}`).join(' ');
}

export function previewClipSource(project: ProjectDocument, clipId: string, sourceFrame: number): number {
  const placed = calculateLayout(project).clips.find((item) => item.clip.id === clipId);
  if (!placed) throw new Error('The selected clip no longer exists.');
  return placed.start + placed.retiming.outputAt(Math.max(placed.clip.sourceIn, Math.min(placed.clip.sourceOut - 1, sourceFrame)));
}

export interface ClipSpeedPlan {
  command: Extract<EditCommand, { type: 'speed' }> | null;
  document: ProjectDocument;
  speed: SpeedCurve;
  previewFrame: number;
  error: string;
}

/** Full-project validation precedes preview and commit; collisions never merge. */
export function planClipSpeedDrag(project: ProjectDocument, clipId: string, origin: number, nextFrame: number, rate: number, previewSource: number, restoreFrame: number): ClipSpeedPlan {
  const clip = project.clips.find((item) => item.id === clipId);
  if (clip?.speed.mode !== 'curve') throw new Error('The selected clip curve no longer exists.');
  try {
    if (clip.speed.keyframes.some((key) => key.frame !== origin && key.frame === nextFrame)) throw new Error('A clip speed key already exists at this source frame. Choose another frame.');
    const speed = updateClipSpeedKey(clip.speed, origin, { frame: nextFrame, rate });
    const command: Extract<EditCommand, { type: 'speed' }> = { type: 'speed', clipId, speed };
    const document = applyCommand(project, command);
    return { command, document, speed, previewFrame: previewClipSource(document, clipId, previewSource), error: '' };
  } catch (cause) {
    return { command: null, document: project, speed: clip.speed, previewFrame: restoreFrame, error: cause instanceof Error ? cause.message : 'This curve conflicts with the clip timing.' };
  }
}