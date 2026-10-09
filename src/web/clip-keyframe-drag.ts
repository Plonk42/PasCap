import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout, type PlacedClip } from '../shared/timeline.js';
import { clipKeyframeMarkers, type ClipKeyframeMarker } from './clip-keyframe-markers.js';
import { replaceSpatialKey } from './spatial-editor.js';
import { keyframeFrameAtPointer } from './timeline-keyframes.js';
import type { DraftPreview } from './Timeline.js';

type SpatialCommand = Extract<EditCommand, { type: 'spatial' }>;
export interface ClipKeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: SpatialCommand | null;
  error: string;
}
export interface ClipKeyframeDraft extends ClipKeyframeDragPlan {
  clipId: string;
  origin: number;
}

/** Moves one Transform key to another original source frame, keeping its easing and enabled settings. */
export function planClipKeyframeMove(
  project: ProjectDocument,
  clipId: string,
  origin: number,
  nextFrame: number,
  frameCount: number,
): ClipKeyframeDragPlan {
  const fail = (error: string): ClipKeyframeDragPlan => ({ frame: nextFrame, document: project, command: null, error });
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) return fail('This clip no longer exists.');
  if (nextFrame < 0 || nextFrame > frameCount)
    return fail(`A Transform keyframe must stay within source frames 0–${frameCount}.`);
  try {
    const command: SpatialCommand = {
      type: 'spatial',
      clipId,
      spatial: replaceSpatialKey(clip.spatial, origin, { frame: nextFrame }),
    };
    return {
      frame: nextFrame,
      document: applyCommand(project, command),
      command: nextFrame === origin ? null : command,
      error: '',
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'Cannot move this Transform keyframe.');
  }
}

/** Pointer travel is in output frames; zero travel keeps the stored frame, whatever frames speed skips. */
export function clipKeyframeTarget(
  placed: PlacedClip,
  marker: Pick<ClipKeyframeMarker, 'sourceFrame' | 'outputFrame'>,
  delta: number,
): number {
  if (delta === 0) return marker.sourceFrame;
  return placed.retiming.sourceAt(Math.max(0, Math.min(placed.duration - 1, marker.outputFrame + delta)));
}

interface Options {
  project: ProjectDocument;
  frame: number;
  scale: number;
  disabled: boolean;
  viewport: RefObject<HTMLDivElement | null>;
  frameCountOf: (mediaId: string) => number;
  onPause: () => void;
  onSelect: (clipId: string) => void;
  onSeek: (frame: number) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onEdit: (command: EditCommand) => void;
  onOpenTransform: () => void;
  onError: (error: string) => void;
}
interface Session {
  pointerId: number;
  element: HTMLButtonElement;
  project: ProjectDocument;
  placed: PlacedClip;
  marker: ClipKeyframeMarker;
  frameCount: number;
  startX: number;
  startScroll: number;
  scale: number;
  moved: boolean;
  pointerX: number;
  plan: ClipKeyframeDragPlan;
}

function seekFrameFor(document: ProjectDocument, clipId: string, sourceFrame: number): number | null {
  const placed = calculateLayout(document).clips.find((item) => item.clip.id === clipId);
  const layer = document.layers.find((item) => item.id === placed?.clip.layerId);
  if (!placed || !layer) return null;
  return (
    clipKeyframeMarkers(placed, layer).find((m) => m.type === 'transform' && m.sourceFrame === sourceFrame)
      ?.seekFrame ?? null
  );
}

function releaseSeekFrame(active: Session): number | null {
  if (active.plan.error) return null;
  if (!active.plan.command) return active.marker.seekFrame;
  return seekFrameFor(active.plan.document, active.placed.clip.id, active.plan.frame);
}

/** Pointer capture owns one Transform-key transaction. Only a valid release enters history/autosave. */
export function useClipKeyframeDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null);
  const [draft, setDraft] = useState<ClipKeyframeDraft | null>(null);

  const clear = useCallback((restoreFrame?: number): Session | null => {
    const active = session.current;
    if (!active) return null;
    session.current = null;
    setDraft(null);
    latest.current.onPreview(null, restoreFrame);
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback((): void => {
    clear();
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !session.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);
  useEffect(() => {
    if (session.current && session.current.project !== options.project) cancel();
  }, [options.project, cancel]);

  const focusMarker = (clipId: string, sourceFrame: number): void => {
    requestAnimationFrame(() => {
      const selector = `[data-clip-id="${CSS.escape(clipId)}"] [data-clip-keyframe="transform"][data-source-frame="${sourceFrame}"]`;
      latest.current.viewport.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    });
  };
  const update = (): void => {
    const active = session.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    if (!active.moved && Math.abs(active.pointerX - active.startX + viewport.scrollLeft - active.startScroll) < 3)
      return;
    active.moved = true;
    const output = keyframeFrameAtPointer(
      active.marker.outputFrame,
      active.startX,
      active.pointerX,
      active.startScroll,
      viewport.scrollLeft,
      active.scale,
    );
    const target = clipKeyframeTarget(active.placed, active.marker, output - active.marker.outputFrame);
    const plan = planClipKeyframeMove(
      active.project,
      active.placed.clip.id,
      active.marker.sourceFrame,
      target,
      active.frameCount,
    );
    if (plan.frame === active.plan.frame && plan.error === active.plan.error) return;
    active.plan = plan;
    setDraft({ ...plan, clipId: active.placed.clip.id, origin: active.marker.sourceFrame });
    latest.current.onPreview({ document: plan.document, frame: latest.current.frame });
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, placed: PlacedClip, marker: ClipKeyframeMarker): void => {
    const { viewport, disabled, project, scale, frameCountOf, onPause, onSelect, onPreview, frame } = latest.current;
    if (disabled || session.current || event.button !== 0 || !viewport.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const plan: ClipKeyframeDragPlan = { frame: marker.sourceFrame, document: project, command: null, error: '' };
    session.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      project,
      placed,
      marker,
      frameCount: frameCountOf(placed.clip.mediaId),
      startX: event.clientX,
      pointerX: event.clientX,
      startScroll: viewport.current.scrollLeft,
      scale,
      moved: false,
      plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    onPause();
    onSelect(placed.clip.id);
    setDraft({ ...plan, clipId: placed.clip.id, origin: marker.sourceFrame });
    onPreview({ document: project, frame });
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    update();
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = session.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    update();
    const clipId = active.placed.clip.id;
    const seek = releaseSeekFrame(active);
    clear(seek ?? undefined);
    if (active.plan.error) {
      latest.current.onError(active.plan.error);
      focusMarker(clipId, active.marker.sourceFrame);
      return;
    }
    if (active.plan.command) latest.current.onEdit(active.plan.command);
    if (seek !== null) latest.current.onSeek(seek);
    latest.current.onOpenTransform();
    focusMarker(clipId, active.plan.frame);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, placed: PlacedClip, marker: ClipKeyframeMarker): void => {
    event.stopPropagation();
    if (latest.current.disabled || session.current || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1);
    const plan = planClipKeyframeMove(
      latest.current.project,
      placed.clip.id,
      marker.sourceFrame,
      marker.sourceFrame + delta,
      latest.current.frameCountOf(placed.clip.mediaId),
    );
    if (plan.error) {
      latest.current.onError(plan.error);
      return;
    }
    if (plan.command) latest.current.onEdit(plan.command);
    const seek = seekFrameFor(plan.document, placed.clip.id, plan.frame);
    if (seek !== null) latest.current.onSeek(seek);
    focusMarker(placed.clip.id, plan.frame);
  };

  return { draft, active: session.current !== null, begin, move, finish, cancel, keyboard };
}
