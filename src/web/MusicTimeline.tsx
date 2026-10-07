import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { musicSourceFrame } from '../shared/audio.js';
import type { EditCommand } from '../shared/commands.js';
import type { MusicTrack, ProjectDocument } from '../shared/model.js';
import { snapFrame } from '../shared/snap.js';
import { formatTimecode } from '../shared/timing.js';
import './music-ui.css';
import { planMusicGesture, type MusicGestureKind } from './music-ui.js';
import { placementSnapPoints, snapPlacement } from './timeline-placement.js';
import type { DraftPreview } from './Timeline.js';

export interface MusicTimelineGesture {
  id: string;
  document: ProjectDocument;
  leading: number;
  width: number;
  start: number;
  duration: number;
  guide: number | null;
  error: string;
}
interface Props {
  project: ProjectDocument;
  music: MusicTrack;
  index: number;
  selected: boolean;
  asset: AudioAsset | undefined;
  leading: number;
  scale: number;
  width: number;
  viewport: RefObject<HTMLDivElement | null>;
  frame: number;
  snapping: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onPause: () => void;
  onEdit: (command: EditCommand) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onGesture: (gesture: MusicTimelineGesture | null) => void;
  onError: (message: string) => void;
}
interface MusicDrag {
  pointerId: number;
  element: HTMLButtonElement;
  base: ProjectDocument;
  music: MusicTrack;
  kind: MusicGestureKind;
  x: number;
  scroll: number;
  scale: number;
  leading: number;
  width: number;
  frame: number;
  pointerX: number;
  alt: boolean;
  moved: boolean;
  targets: number[];
  plan: ReturnType<typeof planMusicGesture>;
}

export function MusicTimeline(props: Readonly<Props>) {
  const { project, asset, leading, scale, disabled, selected, index } = props;
  const latest = useRef(props);
  latest.current = props;
  const [candidate, setCandidate] = useState<ReturnType<typeof planMusicGesture> | null>(null);
  const drag = useRef<MusicDrag | null>(null);
  const animation = useRef(0);
  const clear = useCallback((restoreScroll: boolean): MusicDrag | null => {
    const active = drag.current;
    if (!active) return null;
    drag.current = null;
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    if (restoreScroll && latest.current.viewport.current) latest.current.viewport.current.scrollLeft = active.scroll;
    setCandidate(null);
    latest.current.onGesture(null);
    if (active.moved) latest.current.onPreview(null, active.frame);
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  const cancel = useCallback((): void => {
    clear(true);
  }, [clear]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    return () => {
      clear(true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel, clear]);
  useEffect(() => {
    if (drag.current && drag.current.base !== project) cancel();
  }, [project, cancel]);
  const music = candidate?.track ?? props.music;
  const name = `music track ${index + 1}: ${asset?.name ?? 'Unavailable recording'}`;
  const peaks = asset
    ? Array.from({ length: 128 }, (_, index) => {
        const source = musicSourceFrame(
          music,
          music.start + Math.min(music.duration - 1, Math.floor((index / 128) * music.duration)),
        )!;
        return {
          x: index * 4 + 1,
          peak:
            asset.waveform[
              Math.min(
                asset.waveform.length - 1,
                Math.floor((source / asset.metadata.frameCount) * asset.waveform.length),
              )
            ] ?? 0,
        };
      })
    : [];
  const update = (): void => {
    const active = drag.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    const travel = active.pointerX - active.x + viewport.scrollLeft - active.scroll;
    if (!active.moved && Math.abs(travel) < 3) return;
    active.moved = true;
    let delta = Math.round(travel / active.scale);
    let guide: number | null = null;
    if (latest.current.snapping && !active.alt) {
      if (active.kind === 'move') {
        const snapped = snapPlacement(
          active.music.start + delta,
          active.music.duration,
          active.targets,
          8 / active.scale,
        );
        delta = snapped.start - active.music.start;
        guide = snapped.guide;
      } else {
        const edge = active.kind === 'out' ? active.music.start + active.music.duration : active.music.start;
        const snapped = snapFrame(edge + delta, active.targets, 8 / active.scale);
        if (snapped !== edge + delta) guide = snapped;
        delta = snapped - edge;
      }
    }
    active.plan = planMusicGesture(active.base, active.music.id, active.kind, delta);
    const plan = active.plan;
    setCandidate(plan);
    latest.current.onGesture({
      id: active.music.id,
      document: plan.document,
      leading: active.leading,
      width: active.width,
      start: plan.track.start,
      duration: plan.track.duration,
      guide: plan.error ? null : guide,
      error: plan.error,
    });
    latest.current.onPreview({ document: plan.document, frame: active.frame });
  };
  const latestUpdate = useRef(update);
  latestUpdate.current = update;
  const autoScroll = (): void => {
    const active = drag.current;
    const viewport = latest.current.viewport.current;
    if (!active || !viewport) return;
    if (active.moved) {
      const bounds = viewport.getBoundingClientRect();
      let velocity = 0;
      if (active.pointerX < bounds.left + 28) velocity = -Math.min(14, (bounds.left + 28 - active.pointerX) / 3);
      else if (active.pointerX > bounds.right - 28) velocity = Math.min(14, (active.pointerX - bounds.right + 28) / 3);
      const previous = viewport.scrollLeft;
      viewport.scrollLeft += velocity;
      if (viewport.scrollLeft !== previous) latestUpdate.current();
    }
    animation.current = requestAnimationFrame(autoScroll);
  };
  const start = (event: PointerEvent<HTMLButtonElement>, kind: MusicGestureKind): void => {
    if (event.button !== 0 || latest.current.disabled || drag.current || !latest.current.viewport.current) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelect(props.music.id);
    props.onPause();
    const plan = planMusicGesture(project, props.music.id, kind, 0);
    drag.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      x: event.clientX,
      pointerX: event.clientX,
      base: project,
      music: props.music,
      kind,
      scroll: props.viewport.current!.scrollLeft,
      scale,
      leading,
      width: props.width,
      frame: props.frame,
      alt: event.altKey,
      moved: false,
      targets: placementSnapPoints(
        { ...project, music: project.music.filter((track) => track.id !== props.music.id) },
        null,
        props.frame,
      ),
      plan,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    setCandidate(plan);
    props.onGesture({
      id: props.music.id,
      document: project,
      leading,
      width: props.width,
      start: props.music.start,
      duration: props.music.duration,
      guide: null,
      error: '',
    });
    // A simple pointer selection must not reload preview or reset another instance's numeric draft.
    // Start document preview only after actual capture-relative movement crosses the drag threshold.
    animation.current = requestAnimationFrame(autoScroll);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    active.pointerX = event.clientX;
    active.alt = event.altKey;
    update();
    clear(false);
    if (active.plan.error) props.onError(active.plan.error);
    else if (active.plan.command) props.onEdit(active.plan.command);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, kind: MusicGestureKind): void => {
    // These buttons own their shortcuts, never the selected video's Delete/nudge/playback actions.
    event.stopPropagation();
    if (disabled || drag.current || event.nativeEvent.isComposing) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      props.onEdit({ type: 'music', music: project.music.filter((track) => track.id !== music.id) });
      requestAnimationFrame(() => {
        latest.current.viewport.current?.querySelector<HTMLButtonElement>('.music-lane-select:not(:disabled)')?.focus();
      });
      return;
    }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    props.onSelect(music.id);
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1);
    const plan = planMusicGesture(project, music.id, kind, delta);
    if (plan.error) props.onError(plan.error);
    else if (plan.command) props.onEdit(plan.command);
  };
  const handlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel };
  return (
    <>
      <button
        type="button"
        className="music-lane-select"
        aria-label={`Select ${name}`}
        aria-pressed={selected}
        disabled={disabled}
        title={`${name} · select to edit in Audio`}
        onClick={() => props.onSelect(music.id)}
        onKeyDown={(event) => event.stopPropagation()}
      >
        Music {index + 1} · {asset?.name ?? 'Unavailable recording'}
      </button>
      <div
        className={`music-timeline-clip ${selected ? 'selected' : ''} ${candidate?.error ? 'invalid' : ''}`}
        data-music-id={music.id}
        data-music-start={music.start}
        data-music-duration={music.duration}
        data-music-valid={!candidate?.error}
        title={candidate?.error || `${name} · ${formatTimecode(music.start)} · ${music.duration} frames`}
        style={{
          left: (drag.current?.leading ?? leading) + music.start * (drag.current?.scale ?? scale),
          width: music.duration * (drag.current?.scale ?? scale),
        }}
      >
        <button
          className="music-body"
          aria-label={`Move ${name}`}
          aria-pressed={selected}
          disabled={disabled && !drag.current}
          onPointerDown={(event) => start(event, 'move')}
          onClick={() => props.onSelect(music.id)}
          onKeyDown={(event) => keyboard(event, 'move')}
          {...handlers}
        >
          <svg viewBox="0 0 512 45" preserveAspectRatio="none" aria-label={`Waveform for ${name}`} role="img">
            {peaks.map(({ x, peak }) => (
              <path
                key={x}
                d={`M${x} ${22 - Math.max(1, peak * 20)}v${Math.max(2, peak * 40)}`}
                stroke="#acb8ee"
                strokeWidth="2"
              />
            ))}
          </svg>
          <span>
            {asset?.name ?? 'Unavailable recording'}
            {music.loop ? ' · loop' : ''}
          </span>
        </button>
        <button
          className="trim-handle in"
          aria-label={`Trim music start, track ${index + 1}: ${asset?.name ?? 'Unavailable recording'}`}
          title="Trim source IN and timeline start; Arrow keys: one frame, Shift: ten"
          disabled={disabled && !drag.current}
          onPointerDown={(event) => start(event, 'in')}
          onClick={() => props.onSelect(music.id)}
          onKeyDown={(event) => keyboard(event, 'in')}
          {...handlers}
        >
          <span />
        </button>
        <button
          className="trim-handle out"
          aria-label={`Trim music duration, track ${index + 1}: ${asset?.name ?? 'Unavailable recording'}`}
          title="Trim timeline duration; Arrow keys: one frame, Shift: ten"
          disabled={disabled && !drag.current}
          onPointerDown={(event) => start(event, 'out')}
          onClick={() => props.onSelect(music.id)}
          onKeyDown={(event) => keyboard(event, 'out')}
          {...handlers}
        >
          <span />
        </button>
      </div>
    </>
  );
}
