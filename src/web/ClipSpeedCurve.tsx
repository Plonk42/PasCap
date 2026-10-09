import { useId, useState, type KeyboardEvent } from 'react';
import { CLIP_SPEED_PRESETS, clipSpeedPreset, removeClipSpeedKey, updateClipSpeedKey } from '../shared/clip-speed.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { Interpolation } from '../shared/keyframes.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import type { SpeedCurve, SpeedSettings } from '../shared/speed.js';
import { formatTimecode } from '../shared/timing.js';
import { clipCurvePoints, previewClipSource, speedRatePosition, stepClipSpeedRate } from './clip-speed-geometry.js';
import './clip-speed.css';
import { EasingSelect } from './EasingSelect.js';
import { Icon } from './icons.js';
import { useKeyframeNavigation } from './keyframe-navigation.js';
import { NumberField } from './NumberField.js';
import { RateValueControl } from './SettingValueControl.js';
import type { DraftPreview } from './Timeline.js';
import { useClipSpeedDrag } from './use-clip-speed-drag.js';

interface Props {
  project: ProjectDocument;
  clip: VideoClip;
  speed: SpeedCurve;
  sourceFrameCount: number;
  frame: number;
  sourceFrame: number | null;
  disabled: boolean;
  onEdit: (command: EditCommand) => void;
  onPause: () => void;
  onSeek: (frame: number) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  inspectedFrame?: number | null;
  onSelectStored?: (frame: number) => void;
}
interface PointIdentity {
  frame: number;
  id: number;
}
interface Identity {
  rows: PointIdentity[];
  next: number;
  selected: number;
}

/** Time edits and their Undo retain the selected point's DOM/input identity. */
function usePointIdentity(speed: SpeedCurve) {
  const [state, setState] = useState<Identity>(() => ({
    rows: speed.keyframes.map((point, id) => ({ frame: point.frame, id })),
    next: speed.keyframes.length,
    selected: 0,
  }));
  let identity = state;
  if (
    state.rows.length !== speed.keyframes.length ||
    state.rows.some((row, index) => row.frame !== speed.keyframes[index]!.frame)
  ) {
    const old = new Map(state.rows.map((row) => [row.frame, row]));
    const frames = new Set(speed.keyframes.map((point) => point.frame));
    const removed = state.rows.filter((row) => !frames.has(row.frame));
    const added = speed.keyframes.filter((point) => !old.has(point.frame));
    let next = state.next;
    const rows = speed.keyframes.map(
      (point) =>
        old.get(point.frame) ?? {
          frame: point.frame,
          id: removed.length === 1 && added.length === 1 ? removed[0]!.id : next++,
        },
    );
    let selected = state.selected;
    if (added.length === 1 && removed.length === 0) selected = rows.find((row) => row.frame === added[0]!.frame)!.id;
    else if (!rows.some((row) => row.id === selected))
      selected = rows[Math.max(0, state.rows.findIndex((row) => row.id === selected) - 1)]!.id;
    identity = { rows, next, selected };
    setState(identity);
  }
  return { ...identity, select: (id: number) => setState((current) => ({ ...current, selected: id })) };
}

function CurvePresets({
  clip,
  speed,
  disabled,
  onChange,
}: Readonly<{ clip: VideoClip; speed: SpeedCurve; disabled: boolean; onChange: (speed: SpeedCurve) => void }>) {
  return (
    <fieldset className="clip-curve-presets">
      <legend className="declutter-sr-only">Clip speed curve presets</legend>
      <div>
        {CLIP_SPEED_PRESETS.map((preset) => {
          const template = clipSpeedPreset(clip, preset.id);
          const active = JSON.stringify(template) === JSON.stringify(speed);
          return (
            <button
              type="button"
              key={preset.id}
              aria-label={`Clip speed preset ${preset.label}`}
              title={`Replace this clip's speed keyframes with ${preset.label.toLowerCase()}; every keyframe stays editable`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(template)}
            >
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polyline
                  points={clipCurvePoints(template, clip.sourceIn, clip.sourceOut)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span>{preset.label}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ClipSpeedCurve({
  project,
  clip,
  speed,
  sourceFrameCount,
  frame,
  sourceFrame,
  disabled,
  onEdit,
  onPause,
  onSeek,
  onPreview,
  inspectedFrame,
  onSelectStored,
}: Readonly<Props>) {
  const helpId = useId();
  const context = `${project.id}:${clip.id}`;
  const navigation = useKeyframeNavigation();
  const drag = useClipSpeedDrag({
    project,
    clip,
    frame,
    sourceFrame,
    disabled: disabled || navigation.disabled,
    onEdit,
    onPause,
    onSeek,
    onPreview,
  });
  const current = drag.draft?.plan.speed ?? speed;
  const identity = usePointIdentity(current);
  const [lastInspected, setLastInspected] = useState<number | null | undefined>(inspectedFrame);
  if (lastInspected !== inspectedFrame) {
    setLastInspected(inspectedFrame);
    const row = identity.rows.find((row) => row.frame === inspectedFrame);
    if (row) identity.select(row.id);
  }
  const selectedIndex = identity.rows.findIndex((row) => row.id === identity.selected);
  const selected = current.keyframes[selectedIndex]!;
  const selectedRow = identity.rows[selectedIndex]!;
  const unavailable = disabled || navigation.disabled || drag.active;
  const [error, setError] = useState('');
  const change = (next: SpeedSettings): void => {
    if (unavailable) return;
    try {
      applyCommand(project, { type: 'speed', clipId: clip.id, speed: next });
      onEdit({ type: 'speed', clipId: clip.id, speed: next });
      setError('');
      drag.clearError();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This clip curve conflicts with the timeline.');
    }
  };
  const validation = (nextFrame: number, rate: number, interpolation: Interpolation): string | null => {
    if (current.keyframes.some((point) => point.frame !== selected.frame && point.frame === nextFrame))
      return 'A clip speed keyframe already exists at this source frame. Choose another frame.';
    try {
      applyCommand(project, {
        type: 'speed',
        clipId: clip.id,
        speed: updateClipSpeedKey(current, selected.frame, { frame: nextFrame, rate, interpolation }),
      });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This speed conflicts with the timeline.';
    }
  };
  const seekPoint = (index: number): void => {
    identity.select(identity.rows[index]!.id);
    onSelectStored?.(current.keyframes[index]!.frame);
    onSeek(previewClipSource(project, clip.id, current.keyframes[index]!.frame));
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (unavailable || event.ctrlKey || event.metaKey || event.altKey) return;
    const point = current.keyframes[index]!;
    let changes: { frame?: number; rate?: number };
    switch (event.key) {
      case 'ArrowLeft':
        changes = { frame: Math.max(0, point.frame - (event.shiftKey ? 10 : 1)) };
        break;
      case 'ArrowRight':
        changes = { frame: Math.min(sourceFrameCount, point.frame + (event.shiftKey ? 10 : 1)) };
        break;
      case 'ArrowUp':
        changes = { rate: stepClipSpeedRate(point.rate, event.shiftKey ? 0.1 : 0.01) };
        break;
      case 'ArrowDown':
        changes = { rate: stepClipSpeedRate(point.rate, event.shiftKey ? -0.1 : -0.01) };
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        event.stopPropagation();
        change(removeClipSpeedKey(current, point.frame));
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      change(updateClipSpeedKey(current, point.frame, changes));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Choose an unoccupied source frame.');
    }
    const focusFrame = changes.frame ?? point.frame;
    requestAnimationFrame(() => {
      const editor = globalThis.document.querySelector<HTMLElement>(`[data-clip-speed-id="${CSS.escape(clip.id)}"]`);
      const target = editor?.querySelector<HTMLButtonElement>(`[data-speed-key="${focusFrame}"]`);
      if (target) target.focus({ preventScroll: true });
      else
        editor
          ?.querySelector<HTMLInputElement>('[aria-label="Clip speed keyframe source frame"]')
          ?.focus({ preventScroll: true });
    });
  };
  const outside = selected.frame < clip.sourceIn || selected.frame >= clip.sourceOut;
  const status = error || drag.error || drag.draft?.plan.error;

  return (
    <section
      className="clip-speed-curve-editor"
      aria-label="Clip speed curve editor"
      data-clip-speed-id={clip.id}
      data-drafting={drag.active}
    >
      <CurvePresets clip={clip} speed={current} disabled={unavailable} onChange={change} />
      <div className="clip-speed-chart">
        <div className="clip-speed-axis" aria-hidden="true">
          <span>8×</span>
          <span style={{ top: `${speedRatePosition(1) * 100}%` }}>1×</span>
          <span>0.1×</span>
        </div>
        <div className={`clip-speed-plot${drag.draft?.plan.error ? ' invalid' : ''}`}>
          <svg
            className="clip-speed-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label="Clip speed curve"
          >
            <path
              d={`M0 ${speedRatePosition(1) * 100}H100M25 0V100M50 0V100M75 0V100`}
              className="clip-speed-grid"
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={clipCurvePoints(current, clip.sourceIn, clip.sourceOut)}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <button
            type="button"
            className="clip-speed-seek"
            aria-label="Seek within clip speed curve"
            aria-describedby={helpId}
            title="Click the curve background to seek, then keyframe Speed ◇"
            disabled={unavailable}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              const progress = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
              onSeek(
                previewClipSource(
                  project,
                  clip.id,
                  clip.sourceIn + Math.round(progress * (clip.sourceOut - clip.sourceIn)),
                ),
              );
            }}
          />
          {sourceFrame !== null && (
            <span
              className="clip-speed-playhead"
              aria-hidden="true"
              style={{ left: `${((sourceFrame - clip.sourceIn) / (clip.sourceOut - clip.sourceIn)) * 100}%` }}
            />
          )}
          {current.keyframes.map((point, index) => {
            const activePoint = drag.active && identity.rows[index]!.id === identity.selected;
            const shownFrame = activePoint ? drag.draft!.frame : point.frame;
            const shownRate = activePoint ? drag.draft!.rate : point.rate;
            if (shownFrame < clip.sourceIn || shownFrame > clip.sourceOut) return null;
            return (
              <button
                type="button"
                key={identity.rows[index]!.id}
                className={`clip-speed-point${identity.selected === identity.rows[index]!.id ? ' selected' : ''}${activePoint ? ' moving' : ''}${activePoint && drag.draft!.plan.error ? ' invalid' : ''}`}
                aria-label={`Clip speed keyframe ${point.frame}`}
                aria-pressed={identity.selected === identity.rows[index]!.id}
                aria-describedby={helpId}
                title={`Source frame ${shownFrame} · ${shownRate}× · drag or use arrows; Shift for larger steps`}
                data-speed-key={point.frame}
                disabled={!activePoint && unavailable}
                style={{
                  left: `${((shownFrame - clip.sourceIn) / (clip.sourceOut - clip.sourceIn)) * 100}%`,
                  top: `${speedRatePosition(shownRate) * 100}%`,
                }}
                onFocus={() => identity.select(identity.rows[index]!.id)}
                onPointerDown={(event) => {
                  identity.select(identity.rows[index]!.id);
                  drag.begin(event, point);
                }}
                onPointerMove={drag.move}
                onPointerUp={drag.finish}
                onPointerCancel={drag.cancel}
                onLostPointerCapture={drag.cancel}
                onKeyDown={(event) => keyboard(event, index)}
                onClick={(event) => {
                  if (event.detail === 0 && !unavailable) seekPoint(index);
                }}
              >
                <span aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
      <div className="clip-speed-axis-times">
        <span>{formatTimecode(clip.sourceIn)}</span>
        <span>{formatTimecode(clip.sourceOut)}</span>
      </div>
      <div className="clip-speed-selection">
        <select
          aria-label="Selected clip speed keyframe"
          value={identity.selected}
          disabled={unavailable}
          onChange={(event) =>
            seekPoint(identity.rows.findIndex((row) => row.id === Number(event.currentTarget.value)))
          }
        >
          {current.keyframes.map((point, index) => (
            <option key={identity.rows[index]!.id} value={identity.rows[index]!.id}>
              Keyframe {index + 1} · source {point.frame}
              {point.frame < clip.sourceIn || point.frame >= clip.sourceOut ? ' · outside clip' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete clip speed keyframe"
          title="Delete the selected keyframe; deleting the last one keeps its rate as constant speed"
          disabled={unavailable}
          onClick={() => change(removeClipSpeedKey(current, selected.frame))}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="clip-speed-point-fields">
        <label>
          Source frame
          <NumberField
            aria-label="Clip speed keyframe source frame"
            value={selected.frame}
            integer
            min={0}
            max={sourceFrameCount}
            step={1}
            disabled={unavailable}
            resetKey={`${context}:${selectedRow.id}:frame`}
            validate={(value) => validation(value, selected.rate, selected.interpolation)}
            onCommit={(value) => change(updateClipSpeedKey(current, selected.frame, { frame: value }))}
          />
        </label>
        <div className="clip-speed-rate-field">
          <label htmlFor={`${helpId}-rate`}>Speed ×</label>
          <RateValueControl
            id={`${helpId}-rate`}
            aria-label="Clip speed keyframe rate"
            value={selected.rate}
            disabled={unavailable}
            resetKey={`${context}:${selectedRow.id}:rate`}
            validate={(value) => validation(selected.frame, value, selected.interpolation)}
            onCommit={(value) => change(updateClipSpeedKey(current, selected.frame, { rate: value }))}
          />
        </div>
        <label className="clip-speed-easing">
          Easing
          <EasingSelect
            aria-label="Clip speed keyframe easing"
            disabled={unavailable || selectedIndex === current.keyframes.length - 1}
            value={selected.interpolation}
            onChange={(interpolation) =>
              change(
                updateClipSpeedKey(current, selected.frame, {
                  interpolation,
                }),
              )
            }
          />
        </label>
      </div>
      {outside && (
        <p className="clip-speed-outside">
          Stored source keyframe outside this clip; preview uses its nearest available frame.
        </p>
      )}
      {status && (
        <p className="clip-speed-error" role="alert">
          {status}
        </p>
      )}
      <span id={helpId} className="declutter-sr-only">
        Keyframes belong only to this clip. Horizontal dragging changes the original source frame; vertical dragging
        changes speed on a logarithmic axis. Arrows move one source frame or 0.01×; Shift uses ten frames or 0.1×. Enter
        seeks, Delete removes a keyframe; removing the last one keeps its rate as constant speed. Escape cancels a drag.
        Trims and splits keep original source anchors.
      </span>
    </section>
  );
}
