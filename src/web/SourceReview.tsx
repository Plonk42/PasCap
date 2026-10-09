import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { VideoDecoderSlot } from '../preview/decoder.js';
import {
  markMediaSelection,
  moveMediaSelectionEdge,
  validateMediaSelection,
  type MediaSelection,
  type MediaSelectionEdge,
} from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import { formatTimecode } from '../shared/timing.js';
import { mediaReady, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import { Popover } from './Popover.js';
import { SourceTransport, type SourceTransportState } from './source-transport.js';
import './rush-source.css';

export interface RushExcerpt {
  id: string;
  index: number;
  sourceIn: number;
  sourceOut: number;
  layerName: string;
}

interface Props {
  asset: MediaAsset;
  frame: number;
  range: MediaSelection;
  excerpts: readonly RushExcerpt[];
  disabled: boolean;
  onFrame: (frame: number) => void;
  onRange: (range: MediaSelection) => void;
  onClose: () => void;
  pinned: boolean;
  onPin: () => void;
  onInsert: () => string | null;
  onRevealClip: (id: string) => void;
  targetLayer: string;
}

interface Observation {
  key: string;
  state: SourceTransportState;
}
interface RangeCommands {
  mark: (edge: MediaSelectionEdge) => void;
  cancel: () => boolean;
}
interface RangeProps {
  asset: MediaAsset;
  range: MediaSelection;
  frame: number;
  observedFrame: number | null;
  disabled: boolean;
  onFrame: (frame: number) => void;
  onRange: (range: MediaSelection) => void;
  onPause: () => void;
  onDraft: (active: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  transport: ReactNode;
  readout: ReactNode;
  ref: Ref<RangeCommands>;
}
interface RangeDrag {
  pointerId: number;
  element: HTMLButtonElement;
  edge: MediaSelectionEdge;
  base: MediaSelection;
  candidate: MediaSelection;
  startX: number;
  width: number;
  headBefore: number;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Cannot review this recording.';
}

/** One muted proxy decoder, independent of the project preview and transport. */
export function SourceReview({
  asset,
  frame,
  range,
  excerpts,
  disabled,
  onFrame,
  onRange,
  onClose,
  pinned,
  onPin,
  onInsert,
  onRevealClip,
  targetLayer,
}: Readonly<Props>) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const transport = useRef<SourceTransport | null>(null);
  const commands = useRef<RangeCommands | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [decoderError, setDecoderError] = useState('');
  const [visible, setVisible] = useState(true);
  const [retry, setRetry] = useState(0);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const [rangeDraft, setRangeDraft] = useState(false);
  const requestedFrame = Math.max(0, Math.min(asset.metadata.frameCount - 1, Math.round(frame)));
  const rate = asset.metadata.frameRate;
  const resourceKey = `${asset.id}/${asset.prepared?.verification.verifiedAt}/${asset.metadata.frameCount}/${rate.numerator}/${rate.denominator}/${retry}`;
  const latest = useRef({ frame: requestedFrame, range, onFrame });
  latest.current = { frame: requestedFrame, range, onFrame };

  useEffect(() => {
    setLastAddedId(null);
  }, [asset.id]);

  useEffect(() => {
    let inView = true;
    let wasVisible = true;
    const change = (): void => {
      const next = inView && !document.hidden;
      if (next === wasVisible) return;
      wasVisible = next;
      setObservation(null);
      setVisible(next);
    };
    const observer = new IntersectionObserver((entries) => {
      inView = entries.some(
        (entry) => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0,
      );
      change();
    });
    const reviewPanel = preview.current?.closest('.source-review');
    if (reviewPanel) observer.observe(reviewPanel);
    change();
    document.addEventListener('visibilitychange', change);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', change);
    };
  }, []);

  useLayoutEffect(() => {
    if (!visible || !host.current) return;
    if (!HTMLVideoElement.prototype.requestVideoFrameCallback) {
      setDecoderError('Source review requires requestVideoFrameCallback in a current browser.');
      return;
    }
    let owner: SourceTransport | null = null;
    const decoder = new VideoDecoderSlot(host.current, 2, () => owner?.observed());
    // This is the visible source viewer, not another project-preview slot.
    delete decoder.video.dataset['pascapDecoder'];
    decoder.video.dataset['sourceDecoder'] = 'true';
    decoder.video.style.cssText = '';
    decoder.video.preload = 'metadata';
    decoder.video.defaultMuted = true;
    decoder.video.muted = true;
    decoder.video.volume = 0;
    decoder.video.disableRemotePlayback = true;
    setDecoderError('');
    if (!mediaReady(asset) || asset.prepared?.verification.frameCount !== asset.metadata.frameCount) {
      setDecoderError('Prepare a complete, verified recording proxy before reviewing it.');
      return () => decoder.dispose();
    }
    owner = new SourceTransport(
      decoder,
      rate,
      asset.metadata.frameCount,
      latest.current.range,
      latest.current.frame,
      (state) => {
        // Hide an obsolete/overshot image before the next paint, including while
        // the exact final included frame is being reacquired after playback.
        if (host.current) host.current.style.opacity = state.frame === null ? '0' : '1';
        setObservation({ key: resourceKey, state });
        if (state.frame !== null) latest.current.onFrame(state.frame);
      },
    );
    transport.current = owner;
    setObservation({ key: resourceKey, state: owner.state });
    // Registered, identity-guarded proxy only. Never play an original or prepare implicitly.
    void owner.load(`/api/media/${encodeURIComponent(asset.id)}/proxy`);
    return () => {
      owner?.dispose();
      if (transport.current === owner) transport.current = null;
    };
  }, [resourceKey, visible]);

  useLayoutEffect(() => {
    transport.current?.follow(requestedFrame);
  }, [requestedFrame, resourceKey, visible]);
  useLayoutEffect(() => {
    transport.current?.setRange(range);
    if (disabled) transport.current?.pause();
  }, [range.sourceIn, range.sourceOut, disabled, resourceKey, visible]);

  const pause = (): void => transport.current?.pause();
  const scrub = (next: number): void => {
    pause();
    transport.current?.seek(next);
    onFrame(next);
  };

  const currentObservation = visible && observation?.key === resourceKey ? observation.state : null;
  const observedFrame = currentObservation?.frame ?? null;
  const error = decoderError || currentObservation?.error || '';
  const buffering = observedFrame === null && !error;
  const playing = currentObservation?.status === 'playing' || currentObservation?.status === 'starting';
  const steadyTransportLabel = playing ? 'Playing' : 'Paused';
  const transportLabel = currentObservation?.status === 'starting' ? 'Starting' : steadyTransportLabel;
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    // No source-review shortcut may reach the main preview's window handlers.
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!commands.current?.cancel()) onClose();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input:not([type="range"]), select, textarea, [contenteditable="true"]')
    )
      return;
    const key = event.key.toLowerCase();
    if (key === 'i' || key === 'o') {
      event.preventDefault();
      commands.current?.mark(key === 'i' ? 'in' : 'out');
    }
  };

  const lastAddedExcerpt = excerpts.find((excerpt) => excerpt.id === lastAddedId);
  const insertDisabled = disabled || !mediaReady(asset);
  const insertExcerpt = (): void => {
    setLastAddedId(null);
    if (insertDisabled) return;
    const id = onInsert();
    if (id !== null) setLastAddedId(id);
  };

  return (
    <section
      className="source-review rush-source"
      aria-label="Source review"
      data-source-excerpt-count={excerpts.length}
    >
      <div className="source-review-heading">
        <div>
          <strong title={asset.name}>{asset.name}</strong>
          <span>
            {asset.metadata.width} × {asset.metadata.height} · original source frames
          </span>
          {excerpts.length > 0 && (
            <SourceExcerpts
              key={`excerpts-${asset.id}`}
              excerpts={excerpts}
              rate={rate}
              lastAddedId={lastAddedExcerpt?.id ?? null}
              disabled={disabled}
              onRevealClip={onRevealClip}
              onKeyDown={keyboard}
            />
          )}
        </div>
        <button
          className={`secondary-button small ${pinned ? 'active' : ''}`}
          aria-label="Pin source review"
          aria-pressed={pinned}
          title="Keep this recording selected while moving over other recordings"
          onKeyDown={keyboard}
          onClick={onPin}
        >
          <Icon name="pin" size={14} />
          <span className="source-pin-label">{pinned ? 'Pinned' : 'Pin'}</span>
        </button>
        <button
          className="primary-button small"
          type="button"
          aria-label={`Add clip ${sourceSeconds(range.sourceOut - range.sourceIn)} to timeline`}
          title={`Append this range to ${targetLayer} as a new, independent clip; omitted source frames remain available`}
          disabled={insertDisabled}
          onKeyDown={keyboard}
          onClick={insertExcerpt}
        >
          <Icon name="plus" size={15} />
          Add clip {sourceSeconds(range.sourceOut - range.sourceIn)}
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
      <div
        className="source-preview"
        ref={preview}
        data-media-id={asset.id}
        data-source-frame={observedFrame ?? undefined}
        data-source-status={currentObservation?.status ?? 'buffering'}
        data-buffering={buffering ? 'true' : 'false'}
        data-source-error={error ? 'true' : 'false'}
        aria-busy={buffering}
      >
        <div
          className="source-video-host"
          ref={host}
          style={{ opacity: observedFrame === null ? 0 : 1 }}
          aria-hidden="true"
        />
        <button
          className="source-preview-focus"
          aria-label={`Review source frame of ${asset.name}`}
          title="Source review: I marks IN, O marks exclusive OUT"
          onKeyDown={keyboard}
        />
        {buffering && (
          <div className="source-preview-overlay">
            <span className="spinner" />
            Seeking frame {currentObservation?.requestedFrame ?? requestedFrame}…
          </div>
        )}
        {rangeDraft && <div className="source-drag-hint">Release to apply · Esc to cancel</div>}
        {error && (
          <div className="source-preview-overlay source-preview-error">
            <span role="alert">{error}</span>
            <button
              className="secondary-button small"
              aria-label="Retry source preview"
              onKeyDown={keyboard}
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      <SourceRangeEditor
        key={asset.id}
        ref={commands}
        asset={asset}
        range={range}
        frame={observedFrame ?? requestedFrame}
        observedFrame={observedFrame}
        disabled={disabled}
        onFrame={scrub}
        onRange={onRange}
        onPause={pause}
        onDraft={setRangeDraft}
        onKeyDown={keyboard}
        transport={
          <button
            className="play-button source-play-button"
            aria-label={playing ? 'Pause source preview' : 'Play source preview'}
            title="Play the applied IN–OUT range, muted; stop at OUT − 1"
            disabled={
              rangeDraft ||
              !visible ||
              disabled ||
              (!playing && (observedFrame === null || !!error || currentObservation?.pendingPlay))
            }
            onKeyDown={keyboard}
            onClick={() => {
              if (playing) pause();
              else transport.current?.play();
            }}
          >
            <Icon name={playing ? 'pause' : 'play'} size={19} />
          </button>
        }
        readout={
          <div className="source-review-readout">
            <span title={`Frame ${observedFrame ?? requestedFrame} of ${asset.metadata.frameCount - 1}`}>
              {formatTimecode(observedFrame ?? requestedFrame, rate)}
            </span>
            <small>{transportLabel}</small>
          </div>
        }
      />
      <output
        className="source-add-feedback"
        aria-live="polite"
        aria-atomic="true"
        data-added-clip-id={lastAddedExcerpt?.id}
      >
        {lastAddedExcerpt && 'Clip added · mark another range'}
      </output>
    </section>
  );
}

function SourceExcerpts({
  excerpts,
  rate,
  lastAddedId,
  disabled,
  onRevealClip,
  onKeyDown,
}: Readonly<{
  excerpts: readonly RushExcerpt[];
  rate: MediaAsset['metadata']['frameRate'];
  lastAddedId: string | null;
  disabled: boolean;
  onRevealClip: Props['onRevealClip'];
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}>) {
  const count = `${excerpts.length} ${excerpts.length === 1 ? 'clip' : 'clips'}`;
  const label = `Show ${count} from this recording`;
  return (
    <Popover
      className="source-excerpts"
      label={label}
      trigger={
        <span>
          Show {count} <Icon name="chevron-down" size={12} />
        </span>
      }
    >
      {(close) => (
        <>
          <p className="source-excerpts-description">Source IN → OUT · OUT exclusive</p>
          <ol className="source-excerpt-list" aria-label="Timeline clips from this recording">
            {excerpts.map((excerpt) => (
              <li
                className="source-excerpt-row"
                key={excerpt.id}
                data-clip-id={excerpt.id}
                data-last-added={lastAddedId === excerpt.id ? 'true' : undefined}
              >
                <div className="source-excerpt-info">
                  <span className="source-excerpt-heading">
                    <strong>Clip {excerpt.index}</strong>
                    <span className="source-excerpt-layer" title={excerpt.layerName}>
                      {excerpt.layerName}
                    </span>
                  </span>
                  <span
                    className="source-excerpt-range"
                    title={`Original source frames ${excerpt.sourceIn} → ${excerpt.sourceOut}, OUT exclusive`}
                  >
                    {formatTimecode(excerpt.sourceIn, rate)} → {formatTimecode(excerpt.sourceOut, rate)}
                  </span>
                </div>
                <button
                  className="secondary-button small source-excerpt-reveal"
                  type="button"
                  aria-label={`Show clip ${excerpt.index} on timeline`}
                  title={`Show clip ${excerpt.index} on ${excerpt.layerName}`}
                  disabled={disabled}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      close();
                    } else onKeyDown(event);
                  }}
                  onClick={() => {
                    close();
                    onRevealClip(excerpt.id);
                  }}
                >
                  Show
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </Popover>
  );
}

function SourceRangeEditor({
  asset,
  range,
  frame,
  observedFrame,
  disabled,
  onFrame,
  onRange,
  onPause,
  onDraft,
  onKeyDown,
  transport,
  readout,
  ref,
}: Readonly<RangeProps>) {
  const count = asset.metadata.frameCount;
  const snapshots = asset.prepared?.thumbnailFrames ?? [];
  const [failedSnapshots, setFailedSnapshots] = useState<readonly number[]>([]);
  const snapshotsAvailable = snapshots.some((sourceFrame) => !failedSnapshots.includes(sourceFrame));
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<RangeDrag | null>(null);
  const animation = useRef<number | null>(null);
  const pointerX = useRef(0);
  const [draft, setDraft] = useState<MediaSelection | null>(null);
  const [numbers, setNumbers] = useState({ sourceIn: String(range.sourceIn), sourceOut: String(range.sourceOut) });
  const [error, setError] = useState('');
  const errorId = useId();
  const selected = draft ?? range;
  const numbersDirty = numbers.sourceIn !== String(range.sourceIn) || numbers.sourceOut !== String(range.sourceOut);

  useEffect(() => {
    onDraft(draft !== null);
    return () => onDraft(false);
  }, [draft !== null, onDraft]);

  useEffect(() => {
    setNumbers({ sourceIn: String(range.sourceIn), sourceOut: String(range.sourceOut) });
    setError('');
  }, [range.sourceIn, range.sourceOut]);

  const clearDrag = useCallback((): RangeDrag | null => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    const active = drag.current;
    drag.current = null;
    if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    return active;
  }, []);
  useEffect(
    () => () => {
      clearDrag();
    },
    [clearDrag],
  );

  const cancel = (): boolean => {
    const active = clearDrag();
    const changed = active !== null || numbersDirty || !!error;
    setDraft(null);
    setNumbers({ sourceIn: String(range.sourceIn), sourceOut: String(range.sourceOut) });
    setError('');
    if (active) onFrame(active.headBefore);
    return changed;
  };
  const cancelLatest = useRef(cancel);
  cancelLatest.current = cancel;
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelLatest.current();
    };
    window.addEventListener('keydown', escape, true);
    const blur = (): void => {
      if (drag.current) cancelLatest.current();
    };
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const commit = (next: MediaSelection): void => {
    if (disabled) return;
    onPause();
    try {
      validateMediaSelection(next, count);
      if (next.mediaId !== asset.id) throw new Error('Range belongs to a different recording.');
      if (next.sourceIn !== range.sourceIn || next.sourceOut !== range.sourceOut) onRange({ ...next });
      setNumbers({ sourceIn: String(next.sourceIn), sourceOut: String(next.sourceOut) });
      setError('');
    } catch (cause) {
      setError(message(cause));
    }
  };
  const mark = (edge: MediaSelectionEdge): void => {
    if (disabled || observedFrame === null || drag.current) return;
    commit(markMediaSelection(range, edge, observedFrame, count));
  };
  useImperativeHandle(ref, () => ({ mark, cancel }));

  const moveAt = (clientX: number): void => {
    const active = drag.current;
    if (!active) return;
    const initial = active.edge === 'in' ? active.base.sourceIn : active.base.sourceOut;
    const boundary = initial + Math.round(((clientX - active.startX) * count) / active.width);
    active.candidate = moveMediaSelectionEdge(active.base, active.edge, boundary, count);
    setDraft(active.candidate);
    onFrame(active.edge === 'in' ? active.candidate.sourceIn : active.candidate.sourceOut - 1);
  };
  const begin = (event: PointerEvent<HTMLButtonElement>, edge: MediaSelectionEdge): void => {
    if (event.button !== 0 || disabled || !strip.current) return;
    const width = strip.current.getBoundingClientRect().width;
    if (width <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    onPause();
    event.currentTarget.focus({ preventScroll: true });
    drag.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      edge,
      base: { ...range },
      candidate: { ...range },
      startX: event.clientX,
      width,
      headBefore: frame,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ ...range });
    setError('');
    onFrame(edge === 'in' ? range.sourceIn : range.sourceOut - 1);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    pointerX.current = event.clientX;
    if (animation.current !== null) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = null;
      moveAt(pointerX.current);
    });
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    moveAt(event.clientX);
    const active = clearDrag();
    setDraft(null);
    if (active) commit(active.candidate);
  };
  const trimKeyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: MediaSelectionEdge): void => {
    if (disabled || drag.current) return;
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
    const candidate = moveMediaSelectionEdge(range, edge, next, count);
    commit(candidate);
    onFrame(edge === 'in' ? candidate.sourceIn : candidate.sourceOut - 1);
  };

  return (
    <div className="source-range-editor" data-dirty={numbersDirty || draft !== null}>
      <div className="source-track">
        {transport}
        <div
          className="source-range-strip"
          ref={strip}
          aria-label="Range"
          data-source-in={selected.sourceIn}
          data-source-out={selected.sourceOut}
          data-range-draft={draft ? 'true' : 'false'}
          data-snapshots={snapshotsAvailable ? 'true' : 'false'}
        >
          <span className="source-filmstrip" aria-hidden="true">
            {snapshots.map((sourceFrame) => (
              <img
                key={sourceFrame}
                loading="lazy"
                draggable={false}
                hidden={failedSnapshots.includes(sourceFrame)}
                src={`/api/media/${encodeURIComponent(asset.id)}/thumbnail/${sourceFrame}`}
                alt=""
                onError={() => setFailedSnapshots((failed) => [...failed, sourceFrame])}
              />
            ))}
          </span>
          {!snapshotsAvailable && <span className="source-filmstrip-missing">Snapshots unavailable</span>}
          <span
            className="source-range-omitted before"
            style={{ width: `${(selected.sourceIn / count) * 100}%` }}
            aria-hidden="true"
          />
          <span
            className="source-range-omitted after"
            style={{
              left: `${(selected.sourceOut / count) * 100}%`,
              width: `${((count - selected.sourceOut) / count) * 100}%`,
            }}
            aria-hidden="true"
          />
          <span
            className="source-range-selection"
            style={{
              left: `${(selected.sourceIn / count) * 100}%`,
              width: `${((selected.sourceOut - selected.sourceIn) / count) * 100}%`,
            }}
            aria-hidden="true"
          />
          <input
            className="source-playhead-input"
            type="range"
            aria-label="Source playhead"
            min={0}
            max={count - 1}
            step={1}
            value={frame}
            aria-valuetext={`Source frame ${frame}, ${formatTimecode(frame, asset.metadata.frameRate)}`}
            onKeyDown={onKeyDown}
            onChange={(event) => onFrame(Number(event.target.value))}
          />
          <span
            className="source-range-head"
            style={{ left: `${count === 1 ? 0 : (frame / (count - 1)) * 100}%` }}
            aria-hidden="true"
          />
          {(['in', 'out'] as const).map((edge) => {
            const value = edge === 'in' ? selected.sourceIn : selected.sourceOut;
            return (
              <button
                key={edge}
                className={`source-trim-handle ${edge}`}
                role="slider"
                aria-label={`Trim source ${edge === 'in' ? 'start' : 'end'}`}
                disabled={disabled}
                style={{ left: `${(value / count) * 100}%` }}
                aria-valuemin={edge === 'in' ? 0 : selected.sourceIn + 1}
                aria-valuemax={edge === 'in' ? selected.sourceOut - 1 : count}
                aria-valuenow={value}
                aria-valuetext={`${value}, ${formatTimecode(value, asset.metadata.frameRate)}${edge === 'out' ? ', OUT exclusive' : ''}`}
                title={`Source ${edge === 'in' ? 'IN' : 'OUT (exclusive)'}. Drag to trim or restore; arrows: 1 frame, Shift: 10.`}
                onPointerDown={(event) => begin(event, edge)}
                onPointerMove={move}
                onPointerUp={finish}
                onPointerCancel={() => cancel()}
                onLostPointerCapture={() => {
                  if (drag.current) cancel();
                }}
                onKeyDown={(event) => {
                  trimKeyboard(event, edge);
                  onKeyDown(event);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <span />
              </button>
            );
          })}
        </div>
      </div>
      <div className="source-range-row">
        {readout}
        <form
          className="source-range-numbers"
          onSubmit={(event) => {
            event.preventDefault();
            if (!numbers.sourceIn.trim() || !numbers.sourceOut.trim()) {
              setError('Enter whole source frames for IN and OUT.');
              return;
            }
            commit({ mediaId: asset.id, sourceIn: Number(numbers.sourceIn), sourceOut: Number(numbers.sourceOut) });
          }}
        >
          <label>
            <span>IN</span>
            <input
              aria-label="Source IN"
              aria-describedby={error ? errorId : undefined}
              aria-invalid={!!error}
              type="number"
              min={0}
              max={count - 1}
              step={1}
              value={draft ? selected.sourceIn : numbers.sourceIn}
              disabled={disabled || draft !== null}
              onKeyDown={onKeyDown}
              onChange={(event) => setNumbers({ ...numbers, sourceIn: event.target.value })}
            />
          </label>
          <label>
            <span>OUT</span>
            <input
              aria-label="Source OUT"
              aria-describedby={error ? errorId : undefined}
              aria-invalid={!!error}
              type="number"
              min={1}
              max={count}
              step={1}
              value={draft ? selected.sourceOut : numbers.sourceOut}
              disabled={disabled || draft !== null}
              onKeyDown={onKeyDown}
              onChange={(event) => setNumbers({ ...numbers, sourceOut: event.target.value })}
            />
          </label>
          <button
            className="secondary-button small"
            type="submit"
            aria-label="Apply range"
            disabled={disabled || !numbersDirty || draft !== null}
            onKeyDown={onKeyDown}
          >
            Apply
          </button>
          {(draft || numbersDirty) && (
            <button
              className="text-button"
              type="button"
              aria-label="Cancel range"
              onKeyDown={onKeyDown}
              onClick={cancel}
            >
              Cancel
            </button>
          )}
        </form>
      </div>
      {error && (
        <div className="source-range-description source-range-error" id={errorId} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
