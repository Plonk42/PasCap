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
  type Ref,
} from 'react';
import { VideoDecoderSlot } from '../preview/decoder.js';
import {
  fullMediaSelection,
  markMediaSelection,
  moveMediaSelectionEdge,
  validateMediaSelection,
  type MediaSelection,
  type MediaSelectionEdge,
} from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import { formatTimecode, secondsToFrames } from '../shared/timing.js';
import { mediaReady } from './display.js';
import { Icon } from './icons.js';
import { Popover } from './Popover.js';
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
  requestedFrame: number;
  frame: number | null;
  error: string;
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
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
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
  return cause instanceof Error ? cause.message : 'Cannot review this source.';
}

/** One paused proxy decoder, independent of the project preview and transport. */
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
  const slot = useRef<VideoDecoderSlot | null>(null);
  const loaded = useRef('');
  const loading = useRef<AbortController | null>(null);
  const seeking = useRef<AbortController | null>(null);
  const commands = useRef<RangeCommands | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [decoderError, setDecoderError] = useState('');
  const [visible, setVisible] = useState(true);
  const [retry, setRetry] = useState(0);
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);
  const requestedFrame = Math.max(0, Math.min(asset.metadata.frameCount - 1, Math.round(frame)));
  const rate = asset.metadata.frameRate;
  const resourceKey = `${asset.id}/${asset.prepared?.verification.verifiedAt}/${asset.metadata.frameCount}/${rate.numerator}/${rate.denominator}/${retry}`;
  const latest = useRef({ key: resourceKey, frame: requestedFrame, rate });
  latest.current = { key: resourceKey, frame: requestedFrame, rate };

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
    if (preview.current) observer.observe(preview.current);
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
    const decoder = new VideoDecoderSlot(host.current, 2);
    // This is the visible source viewer, not another project-preview slot.
    delete decoder.video.dataset['pascapDecoder'];
    decoder.video.dataset['sourceDecoder'] = 'true';
    decoder.video.style.cssText = '';
    decoder.video.preload = 'metadata';
    decoder.video.defaultMuted = true;
    decoder.video.muted = true;
    decoder.video.volume = 0;
    decoder.video.disableRemotePlayback = true;
    slot.current = decoder;
    setDecoderError('');
    return () => {
      loading.current?.abort();
      seeking.current?.abort();
      loaded.current = '';
      decoder.dispose();
      if (slot.current === decoder) slot.current = null;
    };
  }, [visible]);

  const seekLatest = useCallback((): void => {
    const decoder = slot.current;
    const request = latest.current;
    if (!decoder || loaded.current !== request.key) return;
    seeking.current?.abort();
    const controller = new AbortController();
    seeking.current = controller;
    setObservation({ key: request.key, requestedFrame: request.frame, frame: null, error: '' });
    // An aborted seek may have reached seeked before its rVFC. Do not let an
    // older decodedFrame bypass a reverse seek to a different currentTime.
    if (
      decoder.decodedFrame === request.frame &&
      secondsToFrames(decoder.video.currentTime, request.rate, 'floor') !== request.frame
    ) {
      decoder.decodedFrame = -1;
    }
    void decoder
      .seek(request.frame, controller.signal)
      .then(() => {
        if (
          controller.signal.aborted ||
          slot.current !== decoder ||
          latest.current.key !== request.key ||
          latest.current.frame !== request.frame
        )
          return;
        if (
          !decoder.ready ||
          decoder.decodedFrame !== request.frame ||
          secondsToFrames(decoder.video.currentTime, request.rate, 'floor') !== request.frame
        ) {
          throw new Error('Source decoder has not delivered the requested exact frame.');
        }
        setObservation({ key: request.key, requestedFrame: request.frame, frame: decoder.decodedFrame, error: '' });
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          slot.current === decoder &&
          latest.current.key === request.key &&
          latest.current.frame === request.frame
        ) {
          setObservation({ key: request.key, requestedFrame: request.frame, frame: null, error: message(cause) });
        }
      });
  }, []);

  useEffect(() => {
    const decoder = slot.current;
    if (!visible || !decoder) return;
    const controller = new AbortController();
    loading.current = controller;
    loaded.current = '';
    seeking.current?.abort();
    setObservation({ key: resourceKey, requestedFrame: latest.current.frame, frame: null, error: '' });
    if (!mediaReady(asset) || asset.prepared?.verification.frameCount !== asset.metadata.frameCount) {
      setObservation({
        key: resourceKey,
        requestedFrame: latest.current.frame,
        frame: null,
        error: 'Prepare a complete, verified source proxy before reviewing it.',
      });
      return () => controller.abort();
    }
    // Only the registered proxy endpoint is ever loaded, never sourcePath or an
    // arbitrary URL. Frame moves do not restart an in-flight resource load.
    void decoder
      .load(`/api/media/${encodeURIComponent(asset.id)}/proxy`, rate, controller.signal)
      .then(() => {
        if (controller.signal.aborted || slot.current !== decoder || latest.current.key !== resourceKey) return;
        loaded.current = resourceKey;
        seekLatest();
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && slot.current === decoder && latest.current.key === resourceKey) {
          setObservation({
            key: resourceKey,
            requestedFrame: latest.current.frame,
            frame: null,
            error: message(cause),
          });
        }
      });
    return () => {
      controller.abort();
      seeking.current?.abort();
      loaded.current = '';
    };
  }, [resourceKey, visible, seekLatest]);

  useEffect(() => {
    seekLatest();
  }, [resourceKey, requestedFrame, visible, seekLatest]);

  const currentObservation =
    visible && observation?.key === resourceKey && observation.requestedFrame === requestedFrame ? observation : null;
  const observedFrame = currentObservation?.frame ?? null;
  const error = decoderError || (observation?.key === resourceKey ? observation.error : '');
  const buffering = observedFrame === null && !error;
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
          title="Keep this source selected while moving over other recordings"
          onKeyDown={keyboard}
          onClick={onPin}
        >
          <Icon name="pin" size={14} />
          <span className="source-pin-label">{pinned ? 'Pinned' : 'Pin'}</span>
        </button>
        <button
          className="primary-button small"
          type="button"
          aria-label="Add source excerpt to timeline"
          title={`Append this range to ${targetLayer} as a new, independent excerpt; omitted source frames remain available`}
          disabled={insertDisabled}
          onKeyDown={keyboard}
          onClick={insertExcerpt}
        >
          <Icon name="plus" size={15} />
          Add excerpt
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
            Seeking frame {requestedFrame}…
          </div>
        )}
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
      <div className="source-review-readout">
        <span>Source {formatTimecode(observedFrame ?? requestedFrame, rate)}</span>
        <span>
          Frame {observedFrame ?? requestedFrame} / {asset.metadata.frameCount - 1}
        </span>
        <small>Paused · muted</small>
      </div>
      <SourceRangeEditor
        key={asset.id}
        ref={commands}
        asset={asset}
        range={range}
        frame={requestedFrame}
        observedFrame={observedFrame}
        disabled={disabled}
        onFrame={onFrame}
        onRange={onRange}
        onKeyDown={keyboard}
      />
      <output
        className="source-add-feedback"
        aria-live="polite"
        aria-atomic="true"
        data-added-clip-id={lastAddedExcerpt?.id}
      >
        {lastAddedExcerpt && 'Excerpt added · mark another range'}
        {!lastAddedExcerpt && excerpts.length === 0 && 'Mark IN and OUT, add, then choose another range'}
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
  const label = `${excerpts.length} ${excerpts.length === 1 ? 'excerpt' : 'excerpts'} from this rush`;
  return (
    <Popover className="source-excerpts" label={label} trigger={<span>{label}</span>}>
      {(close) => (
        <>
          <p className="source-excerpts-description">Source IN → OUT · OUT exclusive</p>
          <ol className="source-excerpt-list" aria-label="Timeline excerpts from this rush">
            {excerpts.map((excerpt) => (
              <li
                className="source-excerpt-row"
                key={excerpt.id}
                data-clip-id={excerpt.id}
                data-last-added={lastAddedId === excerpt.id ? 'true' : undefined}
              >
                <div className="source-excerpt-info">
                  <span className="source-excerpt-heading">
                    <strong>Excerpt {excerpt.index}</strong>
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
                  aria-label={`Show excerpt ${excerpt.index} on timeline`}
                  title={`Show excerpt ${excerpt.index} on ${excerpt.layerName}`}
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
  onKeyDown,
  ref,
}: Readonly<RangeProps>) {
  const count = asset.metadata.frameCount;
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<RangeDrag | null>(null);
  const animation = useRef<number | null>(null);
  const pointerX = useRef(0);
  const [draft, setDraft] = useState<MediaSelection | null>(null);
  const [numbers, setNumbers] = useState({ sourceIn: String(range.sourceIn), sourceOut: String(range.sourceOut) });
  const [error, setError] = useState('');
  const descriptionId = useId();
  const selected = draft ?? range;
  const numbersDirty = numbers.sourceIn !== String(range.sourceIn) || numbers.sourceOut !== String(range.sourceOut);

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
    return () => window.removeEventListener('keydown', escape, true);
  }, []);

  const commit = (next: MediaSelection): void => {
    if (disabled) return;
    try {
      validateMediaSelection(next, count);
      if (next.mediaId !== asset.id) throw new Error('Source range belongs to a different recording.');
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
      <div
        className="source-range-strip"
        ref={strip}
        aria-label="Source range"
        data-source-in={selected.sourceIn}
        data-source-out={selected.sourceOut}
        data-range-draft={draft ? 'true' : 'false'}
      >
        <span className="source-range-track" aria-hidden="true" />
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
            aria-describedby={descriptionId}
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
            aria-describedby={descriptionId}
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
          aria-label="Apply source range"
          disabled={disabled || !numbersDirty || draft !== null}
          onKeyDown={onKeyDown}
        >
          Apply
        </button>
      </form>
      <div className="source-range-actions">
        <button
          className="secondary-button small"
          aria-label="Mark source IN"
          title="Mark displayed source frame as IN (I)"
          disabled={disabled || observedFrame === null || draft !== null}
          onKeyDown={onKeyDown}
          onClick={() => mark('in')}
        >
          Mark IN
        </button>
        <button
          className="secondary-button small"
          aria-label="Mark source OUT"
          title="Mark after displayed source frame as exclusive OUT (O)"
          disabled={disabled || observedFrame === null || draft !== null}
          onKeyDown={onKeyDown}
          onClick={() => mark('out')}
        >
          Mark OUT
        </button>
        <button
          className="icon-button"
          aria-label="Reset source range"
          title="Restore the full original source range"
          disabled={disabled || draft !== null || (range.sourceIn === 0 && range.sourceOut === count && !numbersDirty)}
          onKeyDown={onKeyDown}
          onClick={() => commit(fullMediaSelection(asset.id, count))}
        >
          <Icon name="reset" size={13} />
        </button>
        {(draft || numbersDirty) && (
          <button className="text-button" aria-label="Cancel source range" onKeyDown={onKeyDown} onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      <div
        className={`source-range-description ${error ? 'source-range-error' : ''}`}
        id={descriptionId}
        role={error ? 'alert' : undefined}
      >
        {error ||
          (draft
            ? 'Release to apply · Esc to cancel'
            : `${selected.sourceOut - selected.sourceIn} / ${count} frames · OUT exclusive · I / O`)}
      </div>
    </div>
  );
}
