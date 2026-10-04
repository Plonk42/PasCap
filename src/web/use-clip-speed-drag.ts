import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import type { EditCommand } from '../shared/commands.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import type { SpeedCurveKeyframe } from '../shared/speed.js';
import { clipSpeedPointer, planClipSpeedDrag, previewClipSource, type ClipSpeedPlan } from './clip-speed-geometry.js';
import type { DraftPreview } from './Timeline.js';

interface Options {
  project: ProjectDocument; clip: VideoClip; frame: number; sourceFrame: number | null; disabled: boolean;
  onPause: () => void; onSeek: (frame: number) => void;
  onEdit: (command: EditCommand) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
}
interface Drag {
  pointer: number; element: HTMLButtonElement; project: ProjectDocument; clipId: string;
  origin: SpeedCurveKeyframe; x: number; y: number; width: number; height: number;
  sourceIn: number; sourceOut: number; restoreFrame: number; previewSource: number;
  moved: boolean; frame: number; rate: number; plan: ClipSpeedPlan;
}
export interface ClipSpeedDrag { origin: number; frame: number; rate: number; plan: ClipSpeedPlan }

/** One captured graph gesture; only valid release can create history/autosave. */
export function useClipSpeedDrag(options: Options) {
  const latest = useRef(options); latest.current = options;
  const session = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<ClipSpeedDrag | null>(null);
  const [error, setError] = useState('');
  const clear = useCallback((frame?: number): Drag | null => {
    const active = session.current;
    if (!active) return null;
    session.current = null; setDraft(null);
    latest.current.onPreview(null, frame ?? active.restoreFrame);
    if (active.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    return active;
  }, []);
  const cancel = useCallback(() => {
    if (!session.current) return;
    clear(); setError('');
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !session.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    };
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel);
    return () => {
      clear(); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancel);
    };
  }, [cancel, clear]);

  const begin = (event: PointerEvent<HTMLButtonElement>, point: SpeedCurveKeyframe): void => {
    const current = latest.current;
    if (current.disabled || session.current || event.button !== 0 || current.clip.speed.mode !== 'curve') return;
    const plot = event.currentTarget.closest('.clip-speed-plot')?.getBoundingClientRect();
    if (!plot || plot.width <= 0 || plot.height <= 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    const previewSource = current.sourceFrame ?? Math.min(current.clip.sourceOut - 1, point.frame);
    const plan = planClipSpeedDrag(current.project, current.clip.id, point.frame, point.frame, point.rate, previewSource, current.frame);
    session.current = {
      pointer: event.pointerId, element: event.currentTarget, project: current.project, clipId: current.clip.id, origin: { ...point },
      x: event.clientX, y: event.clientY, width: plot.width, height: plot.height, sourceIn: current.clip.sourceIn, sourceOut: current.clip.sourceOut,
      restoreFrame: current.frame, previewSource, moved: false, frame: point.frame, rate: point.rate, plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId); current.onPause(); setError('');
    setDraft({ origin: point.frame, frame: point.frame, rate: point.rate, plan });
    current.onPreview({ document: current.project, frame: current.frame });
  };
  const update = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (active?.pointer !== event.pointerId) return;
    const dx = event.clientX - active.x; const dy = event.clientY - active.y;
    if (!active.moved && Math.hypot(dx, dy) < 3) return;
    active.moved = true;
    const next = clipSpeedPointer({ originFrame: active.origin.frame, originRate: active.origin.rate, deltaX: dx, deltaY: dy, width: active.width, height: active.height, sourceIn: active.sourceIn, sourceOut: active.sourceOut });
    if (active.frame === next.frame && active.rate === next.rate) return;
    active.frame = next.frame; active.rate = next.rate;
    active.plan = planClipSpeedDrag(active.project, active.clipId, active.origin.frame, next.frame, next.rate, active.previewSource, active.restoreFrame);
    setDraft({ origin: active.origin.frame, ...next, plan: active.plan });
    latest.current.onPreview({ document: active.plan.document, frame: active.plan.previewFrame });
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    event.stopPropagation(); update(event);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (session.current?.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); update(event);
    const active = session.current!;
    let destination = active.restoreFrame;
    if (!active.plan.error) destination = active.moved ? active.plan.previewFrame : previewClipSource(active.project, active.clipId, active.origin.frame);
    clear(destination);
    if (active.plan.error) { setError(active.plan.error); return; }
    if (active.moved && active.plan.command) latest.current.onEdit(active.plan.command);
    else latest.current.onSeek(destination);
  };
  return { draft, error, active: session.current !== null, begin, move, finish, cancel, clearError: () => setError('') };
}