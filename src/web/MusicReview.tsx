import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from 'react';
import { MusicPlayback } from '../preview/music.js';
import type { AudioAsset } from '../shared/audio.js';
import {
  markMediaSelection,
  moveMediaSelectionEdge,
  type MediaSelection,
  type MediaSelectionEdge,
} from '../shared/media-selection.js';
import type { MusicTrack } from '../shared/model.js';
import { formatTimecode } from '../shared/timing.js';
import { sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import './media-review.css';
import { MusicAnalysisStatus } from './MusicAnalysis.js';
import { MusicGraphics } from './music-graphics.js';
import { MusicReviewTransport, type MusicReviewState } from './music-review-transport.js';
import './music-ui.css';
import type { MusicAddTarget } from './music-ui.js';
import { readPreference, SOURCE_PLAY_SCOPE_PREFERENCE, writePreference } from './preferences.js';
import './rush-source.css';

/** Lets the editor's Space shortcut play or pause the music shown in Source preview. */
export interface MusicReviewPlayback {
  toggle: () => void;
  pause: () => void;
}

interface Props {
  asset: AudioAsset;
  /** The original is missing: its music cache cannot be played until it is relinked. */
  missing: boolean;
  /** The range to add, kept by the editor for this session only. */
  range: MediaSelection;
  visible: boolean;
  disabled: boolean;
  target: MusicAddTarget;
  onRange: (range: MediaSelection) => void;
  /** Adds the range as a new music clip in one Undo step; false when the project refused it. */
  onAdd: (range: MediaSelection) => boolean;
  /** Playback is about to start: the timeline must not play at the same time. */
  onPlay: () => void;
  onClose: () => void;
  ref?: Ref<MusicReviewPlayback>;
}

interface Drag {
  pointerId: number;
  element: HTMLElement;
  edge: MediaSelectionEdge;
  base: MediaSelection;
  startX: number;
  width: number;
}

/** Why the recording cannot play, or '' when it can. */
function unavailable(asset: AudioAsset, missing: boolean): string {
  if (missing) return `The original is missing at ${asset.sourcePath}. Relink it in Media to listen to it.`;
  if (asset.status === 'registered') return 'Prepare this music recording in Media to listen to it.';
  if (asset.status === 'queued' || asset.status === 'preparing')
    return 'This music recording is being prepared. It plays once it is ready.';
  if (asset.status === 'error') {
    const detail = asset.error ? ': ' + asset.error : '';
    return `Preparation failed${detail}. Prepare it again in Media to listen to it.`;
  }
  return '';
}

/** One prepared music recording, played on its own output; never placed, saved or added to history. */
export function MusicReview({
  asset,
  missing,
  range,
  visible,
  disabled,
  target,
  onRange,
  onAdd,
  onPlay,
  onClose,
  ref,
}: Readonly<Props>) {
  const count = asset.metadata.frameCount;
  const reason = unavailable(asset, missing);
  const strip = useRef<HTMLDivElement>(null);
  const transport = useRef<MusicReviewTransport | null>(null);
  const drag = useRef<Drag | null>(null);
  const [state, setState] = useState<MusicReviewState>({ status: 'paused', frame: range.sourceIn, error: '' });
  const [width, setWidth] = useState(0);
  const [added, setAdded] = useState('');
  const [wholeRecording, setWholeRecording] = useState(
    () => readPreference(SOURCE_PLAY_SCOPE_PREFERENCE) === 'recording',
  );
  const frame = Math.min(count - 1, state.frame);
  const whole = useMemo<MusicTrack>(
    () => ({
      id: 'music-review',
      mediaId: asset.id,
      sourceIn: 0,
      sourceOut: count,
      start: 0,
      duration: count,
      gainDb: 0,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
    }),
    [asset.id, count],
  );
  const resourceKey = reason ? '' : `${asset.id}/${asset.content?.digest ?? ''}/${count}`;

  useLayoutEffect(() => {
    if (!resourceKey) return;
    const owner = new MusicReviewTransport(new MusicPlayback(), asset.id, count, state.frame, setState);
    transport.current = owner;
    setState(owner.state);
    return () => {
      owner.dispose();
      if (transport.current === owner) transport.current = null;
    };
  }, [resourceKey]);

  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || disabled) transport.current?.pause();
  }, [visible, disabled]);

  useEffect(() => setAdded(''), [range.sourceIn, range.sourceOut]);

  const playing = state.status === 'playing' || state.status === 'starting';
  const playDisabled = !!reason || !visible || disabled;
  const pause = (): void => transport.current?.pause();
  const play = (): void => {
    if (playDisabled || !transport.current) return;
    onPlay();
    if (wholeRecording) transport.current.play(0, count);
    else transport.current.play(range.sourceIn, range.sourceOut);
  };
  const togglePlayback = (): void => {
    if (playing) pause();
    else play();
  };
  useImperativeHandle(ref, () => ({ toggle: togglePlayback, pause }));
  const seek = (next: number): void => transport.current?.seek(next);

  const mark = (edge: MediaSelectionEdge): void => {
    if (reason || drag.current) return;
    onRange(markMediaSelection(range, edge, frame, count));
  };
  const resetRange = (): void => {
    if (!reason && !drag.current) onRange({ mediaId: asset.id, sourceIn: 0, sourceOut: count });
  };
  const cancelDrag = (): boolean => {
    const active = drag.current;
    if (!active) return false;
    drag.current = null;
    if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    onRange(active.base);
    return true;
  };
  const moveEdge = (base: MediaSelection, edge: MediaSelectionEdge, boundary: number): void => {
    const next = moveMediaSelectionEdge(base, edge, boundary, count);
    onRange(next);
    seek(edge === 'in' ? next.sourceIn : next.sourceOut - 1);
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, edge: MediaSelectionEdge): void => {
    if (event.button !== 0 || !strip.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      edge,
      base: { ...range },
      startX: event.clientX,
      width: strip.current.getBoundingClientRect().width,
    };
    seek(edge === 'in' ? range.sourceIn : range.sourceOut - 1);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId || active.width <= 0) return;
    event.preventDefault();
    const initial = active.edge === 'in' ? active.base.sourceIn : active.base.sourceOut;
    moveEdge(active.base, active.edge, initial + Math.round(((event.clientX - active.startX) * count) / active.width));
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    move(event);
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleKeyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: MediaSelectionEdge): void => {
    if (drag.current) return;
    const value = edge === 'in' ? range.sourceIn : range.sourceOut;
    const step = event.shiftKey ? 10 : 1;
    const positions: Readonly<Record<string, number>> = {
      ArrowLeft: value - step,
      ArrowRight: value + step,
      Home: edge === 'in' ? 0 : range.sourceIn + 1,
      End: edge === 'out' ? count : range.sourceOut - 1,
    };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    moveEdge(range, edge, next);
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    // Space reaches the editor shortcut, which plays this preview while it is displayed.
    if (event.code === 'Space') return;
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!cancelDrag()) onClose();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key === 'i' || key === 'o') {
      event.preventDefault();
      mark(key === 'i' ? 'in' : 'out');
    }
  };

  const length = range.sourceOut - range.sourceIn;
  const addBlocked = disabled || !!reason || !!target.reason;
  const add = (): void => {
    setAdded('');
    if (!addBlocked && onAdd(range)) setAdded(`Music clip added to ${target.name}`);
  };
  const percent = (value: number): string => `${(value / count) * 100}%`;
  const statusLabel = { paused: 'Paused', starting: 'Starting', playing: 'Playing', error: 'Error' }[state.status];

  return (
    <section
      className="source-review rush-source music-review"
      aria-label="Music review"
      data-media-id={asset.id}
      data-music-status={state.status}
      data-music-frame={frame}
    >
      <div className="source-review-heading">
        <div>
          <div className="source-review-title">
            <strong title={asset.sourcePath}>{asset.name}</strong>
          </div>
        </div>
        <button
          className="primary-button small"
          type="button"
          aria-label={`Add music clip ${sourceSeconds(length)} to timeline`}
          title={target.reason || `Add this range to ${target.name} as a new music clip`}
          disabled={addBlocked}
          onKeyDown={keyboard}
          onClick={add}
        >
          <Icon name="plus" size={15} />
          Add music clip {sourceSeconds(length)}
        </button>
        <button
          className="icon-button"
          aria-label="Close source review"
          title="Close source review"
          onKeyDown={keyboard}
          onClick={onClose}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="source-range-editor">
        <div className="source-track">
          <div className="source-transport">
            <button
              className="play-button source-play-button"
              aria-label={playing ? 'Pause music preview' : 'Play music preview'}
              title={
                wholeRecording
                  ? 'Play the whole recording from the play position; stop at its end'
                  : 'Play the IN–OUT range from the play position; stop at OUT'
              }
              disabled={playDisabled && !playing}
              onKeyDown={keyboard}
              onClick={togglePlayback}
            >
              <Icon name={playing ? 'pause' : 'play'} size={19} />
            </button>
            <button
              className="source-play-scope"
              type="button"
              aria-label="Play whole recording"
              aria-pressed={wholeRecording}
              onKeyDown={keyboard}
              title={
                wholeRecording
                  ? 'Play and Space play the whole recording. Click to play only the IN–OUT range'
                  : 'Play and Space play only the IN–OUT range. Click to play the whole recording'
              }
              onClick={() => {
                setWholeRecording(!wholeRecording);
                writePreference(SOURCE_PLAY_SCOPE_PREFERENCE, wholeRecording ? 'range' : 'recording');
              }}
            >
              {wholeRecording ? 'Whole' : 'Range'}
            </button>
          </div>
          <div className="source-track-stack">
            <div
              className="source-range-strip music-review-strip"
              ref={strip}
              data-source-in={range.sourceIn}
              data-source-out={range.sourceOut}
            >
              {reason ? (
                <output className="source-filmstrip-missing music-review-unavailable">{reason}</output>
              ) : (
                width > 0 && (
                  <div className="music-body music-review-body">
                    <MusicGraphics music={whole} asset={asset} scale={width / count} label={asset.name} />
                  </div>
                )
              )}
              <span
                className="source-range-omitted before"
                style={{ width: percent(range.sourceIn) }}
                aria-hidden="true"
              />
              <span
                className="source-range-omitted after"
                style={{ left: percent(range.sourceOut), width: percent(count - range.sourceOut) }}
                aria-hidden="true"
              />
              <span
                className="source-range-selection"
                style={{ left: percent(range.sourceIn), width: percent(length) }}
                aria-hidden="true"
              />
              {!reason && (
                <>
                  <input
                    className="source-playhead-input"
                    type="range"
                    aria-label="Music playhead"
                    title="Click or drag to move the play position; I marks IN, O marks OUT"
                    min={0}
                    max={count - 1}
                    step={1}
                    value={frame}
                    aria-valuetext={`Music frame ${frame}, ${formatTimecode(frame)}`}
                    onKeyDown={keyboard}
                    onChange={(event) => seek(Number(event.target.value))}
                  />
                  {(['in', 'out'] as const).map((edge) => {
                    const value = edge === 'in' ? range.sourceIn : range.sourceOut;
                    return (
                      <button
                        key={edge}
                        className={`source-trim-handle ${edge}`}
                        role="slider"
                        aria-label={`Trim music ${edge === 'in' ? 'start' : 'end'}`}
                        style={{ left: percent(value) }}
                        aria-valuemin={edge === 'in' ? 0 : range.sourceIn + 1}
                        aria-valuemax={edge === 'in' ? range.sourceOut - 1 : count}
                        aria-valuenow={value}
                        aria-valuetext={`${value}, ${formatTimecode(value)}${edge === 'out' ? ', OUT exclusive' : ''}`}
                        title={`Music ${edge === 'in' ? 'IN' : 'OUT (exclusive)'}. Drag to trim or restore; arrows: 1 frame, Shift: 10.`}
                        onPointerDown={(event) => begin(event, edge)}
                        onPointerMove={move}
                        onPointerUp={finish}
                        onPointerCancel={cancelDrag}
                        onLostPointerCapture={cancelDrag}
                        onKeyDown={(event) => {
                          handleKeyboard(event, edge);
                          keyboard(event);
                        }}
                      >
                        <span />
                      </button>
                    );
                  })}
                </>
              )}
            </div>
            <span
              className="source-range-head"
              style={{ left: `${count === 1 ? 0 : (frame / (count - 1)) * 100}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
        <div className="source-range-row">
          <div className="source-review-readout">
            <span title={`Frame ${frame} of ${count - 1}`}>{formatTimecode(frame)}</span>
            <small>{statusLabel}</small>
          </div>
          <div className="music-review-range">
            <span title="Music IN → OUT, OUT exclusive">
              IN {formatTimecode(range.sourceIn)} → OUT {formatTimecode(range.sourceOut)}
            </span>
            <button
              type="button"
              className="icon-button source-range-reset"
              aria-label="Reset music range"
              aria-disabled={length === count}
              tabIndex={length === count ? -1 : 0}
              title={
                length === count
                  ? 'The range already covers the whole recording.'
                  : 'Reset IN and OUT to the whole recording'
              }
              onKeyDown={keyboard}
              onClick={resetRange}
            >
              <Icon name="reset" size={13} />
            </button>
          </div>
        </div>
      </div>
      {state.error && (
        <div className="music-review-error" role="alert">
          {state.error}
        </div>
      )}
      {!reason && <MusicAnalysisStatus asset={asset} music={whole} onSeek={seek} />}
      <output className="source-add-feedback" aria-live="polite" aria-atomic="true">
        {added}
      </output>
    </section>
  );
}
