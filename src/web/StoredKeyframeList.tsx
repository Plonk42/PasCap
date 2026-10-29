import { useId, useState, type ReactNode } from 'react';
import type { Interpolation } from '../shared/keyframes.js';
import { formatTimecode } from '../shared/timing.js';
import { ChannelSteps } from './AnimationControls.js';
import './editor-panels.css';
import { Icon } from './icons.js';
import { KeyframeEasing } from './KeyframeEasing.js';
import { keySeekHint } from './keyframe-navigation.js';
import './layer-keyframes.css';
import { NumberField } from './NumberField.js';

export interface StoredKeyframe<S extends string> {
  frame: number;
  reset: boolean;
  easing: Readonly<Record<S, Interpolation | null>>;
}

/**
 * What one keyframe type (a grade's Colour, track Transform) supplies to the shared stored keyframe list.
 * Layout, selection, chips, navigation and the Edit fields are common, so both lists behave alike.
 */
const FRAME_LABELS = { timeline: 'Timeline frame', source: 'Source frame', adjustment: 'Frame in adjustment' } as const;

export interface StoredKeyframeKind<S extends string, K extends StoredKeyframe<S>> {
  /** As in "Go to track keyframe 10" or "Go to Transform keyframe 10". */
  noun: string;
  /** Group name, followed by the track name. */
  title: string;
  /** What `frame` counts: timeline frames, source frames of a clip's recording, or frames from an adjustment's start. */
  frameNoun?: 'timeline' | 'source' | 'adjustment';
  tone?: string;
  /** Every setting, in control order. */
  settings: readonly { key: S; label: string }[];
  enabled: (key: K) => readonly S[];
  /** Enabled settings keyed again later; Easing only matters for them. */
  continuing: (key: K) => readonly S[];
  /** The nearest earlier/later keyframe frames enabling this setting, seen from this row. */
  neighbours: (key: K, setting: S) => { previous: number | undefined; next: number | undefined };
  seek: (frame: number) => void;
  validateFrame: (key: K, frame: number) => string | null;
  moveFrame: (key: K, frame: number) => void;
  setEasing: (key: K, setting: S | null, easing: Interpolation) => void;
  remove: (key: K) => void;
  removeTitle: string;
  /** The enabled settings' value editors inside Edit. */
  renderValues: (key: K, row: number) => ReactNode;
}

export interface StoredRow {
  frame: number;
  id: number;
}
interface RowIdentity {
  context: string;
  rows: StoredRow[];
  nextId: number;
}

function reconcileRows(identity: RowIdentity, context: string, keys: readonly { frame: number }[]) {
  if (identity.context !== context)
    return { rows: keys.map((key, id) => ({ frame: key.frame, id })), nextId: keys.length };
  const previous = new Map(identity.rows.map((row) => [row.frame, row]));
  const frames = new Set(keys.map((key) => key.frame));
  const removed = identity.rows.filter((row) => !frames.has(row.frame));
  const added = keys.filter((key) => !previous.has(key.frame));
  let nextId = identity.nextId;
  // A single time edit and its undo keep DOM identity, including after reordering.
  const rows = keys.map(
    (key) =>
      previous.get(key.frame) ?? {
        frame: key.frame,
        id: removed.length === 1 && added.length === 1 ? removed[0]!.id : nextId++,
      },
  );
  return { rows, nextId };
}

function useStoredKeyframeRows(context: string, keys: readonly { frame: number }[]): StoredRow[] {
  const [state, setState] = useState<RowIdentity>(() => ({
    context,
    rows: keys.map((key, id) => ({ frame: key.frame, id })),
    nextId: keys.length,
  }));
  let current = state;
  const changed =
    keys.length !== state.rows.length || keys.some((key, index) => key.frame !== state.rows[index]?.frame);
  if (state.context !== context || changed) {
    current = { context, ...reconcileRows(state, context, keys) };
    setState(current);
  }
  return current.rows;
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function enabledSettings<S extends string, K extends StoredKeyframe<S>>(kind: StoredKeyframeKind<S, K>, key: K) {
  const enabled = kind.enabled(key);
  return kind.settings.filter((setting) => enabled.includes(setting.key));
}

interface RowProps<S extends string, K extends StoredKeyframe<S>> {
  kind: StoredKeyframeKind<S, K>;
  point: K;
  row: StoredRow;
  listId: string;
  context: string;
  duration: number;
  current: boolean;
  disabled: boolean;
  describedBy: string | undefined;
}

function StoredKeyframeRow<S extends string, K extends StoredKeyframe<S>>({
  kind,
  point,
  row,
  listId,
  context,
  duration,
  current,
  disabled,
  describedBy,
}: Readonly<RowProps<S, K>>) {
  const settings = enabledSettings(kind, point);
  const frameId = `${listId}-${row.id}-frame`;
  return (
    <li
      className={`keyframe-row stored-keyframe-row${current ? ' current' : ''}`}
      data-keyframe-frame={point.frame}
      aria-current={current ? 'true' : undefined}
    >
      <div className="keyframe-row-header">
        {/* Stretched over the whole row: a click anywhere outside its controls selects the keyframe. */}
        <button
          type="button"
          className="text-button stored-keyframe-select"
          aria-label={`Go to ${kind.noun} keyframe ${point.frame}`}
          title={keySeekHint(point.frame, duration, FRAME_LABELS[kind.frameNoun ?? 'timeline'].toLowerCase())}
          disabled={disabled}
          onClick={() => kind.seek(point.frame)}
        >
          {formatTimecode(point.frame)}
        </button>
        {point.reset && (
          <span
            className="keyframe-row-default"
            title="Default keyframe: its settings return to their defaults here and hold until their next keyframes; earlier frames keep their own values."
          >
            <Icon name="default-key" size={14} />
            Default
          </span>
        )}
        {point.frame >= duration && (
          <span
            className="keyframe-row-skipped"
            title="Outside the current timeline; this stored keyframe remains editable."
          >
            Outside duration
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={`Delete ${kind.noun} keyframe ${point.frame}`}
          title={kind.removeTitle}
          disabled={disabled}
          onClick={() => kind.remove(point)}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      {/* A complete default keyframe's badge already says every setting is enabled. */}
      {!(point.reset && settings.length === kind.settings.length) && (
        <div
          className="layer-keyframe-dependencies"
          title="Moving this keyframe moves all these settings together; each keeps its own Easing."
        >
          <div className="layer-keyframe-chips" aria-label="Animated settings">
            {settings.map((setting) => {
              const { previous, next } = kind.neighbours(point, setting.key);
              return (
                <span className="layer-keyframe-chip" key={setting.key}>
                  {setting.label}
                  <ChannelSteps
                    label={setting.label}
                    previous={previous}
                    next={next}
                    duration={duration}
                    frameNoun={FRAME_LABELS[kind.frameNoun ?? 'timeline'].toLowerCase()}
                    disabled={disabled}
                    onSeek={kind.seek}
                  />
                </span>
              );
            })}
          </div>
        </div>
      )}
      <details className="layer-keyframe-point-details">
        <summary aria-label={`Edit ${kind.noun} keyframe ${point.frame}`}>Edit</summary>
        <div className="layer-keyframe-point-fields">
          <label htmlFor={frameId}>
            {FRAME_LABELS[kind.frameNoun ?? 'timeline']}
            <NumberField
              id={frameId}
              aria-label={`${capitalised(kind.noun)} keyframe frame ${point.frame}`}
              {...(describedBy ? { 'aria-describedby': describedBy } : {})}
              min={0}
              max={2_147_483_647}
              integer
              step={1}
              value={point.frame}
              disabled={disabled}
              resetKey={`${context}:${row.id}:frame`}
              validate={(value) => kind.validateFrame(point, value)}
              onCommit={(value) => kind.moveFrame(point, value)}
            />
          </label>
          <KeyframeEasing
            label={`${capitalised(kind.noun)} keyframe easing ${point.frame}`}
            settingLabel={(setting) => `${setting} easing at ${kind.noun} keyframe ${point.frame}`}
            {...(describedBy ? { describedBy } : {})}
            title="Applies to every setting of this keyframe, toward each setting's next keyframe"
            settings={settings}
            continuing={kind.continuing(point)}
            easing={point.easing}
            disabled={disabled}
            onChange={(setting, easing) => kind.setEasing(point, setting, easing)}
          />
          <div className="layer-keyframe-point-values">{kind.renderValues(point, row.id)}</div>
        </div>
      </details>
    </li>
  );
}

interface ListProps<S extends string, K extends StoredKeyframe<S>> {
  kind: StoredKeyframeKind<S, K>;
  trackName: string;
  keys: readonly K[];
  context: string;
  /** The real playhead. */
  frame: number;
  duration: number;
  /** The stored keyframe the list cursor inspects, if any. */
  inspected: K | undefined;
  /** The row marked current: the inspected keyframe, else the one at the playhead. */
  current: number | null;
  disabled: boolean;
  help?: ReactNode;
  describedBy?: string;
  onFollowPlayhead?: () => void;
}

/** A section's stored keyframes: one row per keyframe, the same for every keyframe type. */
export function StoredKeyframeList<S extends string, K extends StoredKeyframe<S>>({
  kind,
  trackName,
  keys,
  context,
  frame,
  duration,
  inspected,
  current,
  disabled,
  help,
  describedBy,
  onFollowPlayhead,
}: Readonly<ListProps<S, K>>) {
  const listId = useId();
  const rows = useStoredKeyframeRows(context, keys);
  if (!keys.length && !help) return null;
  const previewAvailable = Number.isInteger(frame) && frame >= 0 && frame < duration;
  const atHead = previewAvailable ? keys.find((key) => key.frame === frame) : undefined;
  // Only a keyframe the preview cannot show needs explaining; one in range is simply at the playhead.
  const unshown = inspected && (!previewAvailable || inspected.frame >= duration) ? inspected : undefined;
  const noun = kind.frameNoun ?? 'timeline';
  let position = 'Empty timeline · no preview frame';
  if (previewAvailable)
    position = `${FRAME_LABELS[noun]} ${frame} · ${atHead ? 'keyframe at playhead' : 'no keyframe here'}`;
  else if (noun !== 'timeline') position = `The playhead is outside this ${noun === 'source' ? 'clip' : 'adjustment'}`;
  else if (duration > 0) position = `Frame ${frame} is outside the current timeline`;
  const labels = (key: K): string =>
    enabledSettings(kind, key)
      .map((setting) => setting.label)
      .join(' · ');
  return (
    <fieldset
      className={`keyframe-controls editor-keyframes layer-keyframe-controls section-keyframes ${kind.tone ?? ''}`.trim()}
      aria-label={`${kind.title} ${trackName}`}
    >
      <legend className="sr-only">{kind.title}</legend>
      <div className="keyframe-toolbar stored-keyframes-heading">
        <span className="keyframe-panel-title">Keyframes</span>
        {help}
      </div>
      <div className="layer-keyframe-current">
        <span className="layer-keyframe-position sr-only">{position}</span>
      </div>
      {unshown && (
        <div className="layer-keyframe-inspected">
          <span className="layer-keyframe-position">
            Stored keyframe · timeline frame {unshown.frame}
            {unshown.frame >= duration ? ' · outside current duration' : ''}
          </span>
          <span>{labels(unshown)}</span>
          <span className="layer-setting-hint">
            {duration === 0
              ? 'No preview frame is available. This keyframe remains editable below.'
              : `Preview is at frame ${frame}, not at this stored keyframe.`}
          </span>
          <div className="layer-keyframe-inspected-actions">
            {onFollowPlayhead && (
              <button type="button" className="text-button" onClick={onFollowPlayhead}>
                Follow playhead
              </button>
            )}
            <button
              type="button"
              className="text-button"
              aria-label={`Delete stored ${kind.noun} keyframe ${unshown.frame}`}
              title={kind.removeTitle}
              disabled={disabled}
              onClick={() => kind.remove(unshown)}
            >
              <Icon name="trash" size={13} />
              Delete
            </button>
          </div>
        </div>
      )}
      {keys.length > 0 && (
        <ol className="keyframe-list keyframe-entries" aria-label={`Edit ${kind.noun} keyframes`}>
          {keys.map((key, index) => (
            <StoredKeyframeRow
              key={rows[index]!.id}
              kind={kind}
              point={key}
              row={rows[index]!}
              listId={listId}
              context={context}
              duration={duration}
              current={key.frame === current}
              disabled={disabled}
              describedBy={describedBy}
            />
          ))}
        </ol>
      )}
    </fieldset>
  );
}
