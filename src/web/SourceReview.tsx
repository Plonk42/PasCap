import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { VideoStreams } from '../preview/video-streams.js';
import {
  markMediaSelection,
  moveMediaSelectionEdge,
  validateMediaSelection,
  type MediaSelection,
  type MediaSelectionEdge,
} from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import type { SelectRange } from '../shared/model.js';
import {
  addKeptRange,
  freeStretchAt,
  insertKeptRange,
  keptRangeBounds,
  removeKeptRange,
  type FreeStretch,
} from '../shared/selects.js';
import { formatTimecode } from '../shared/timing.js';
import { DamageMarks } from './DamageMarks.js';
import { mediaReady, sourceSeconds } from './display.js';
import { Icon } from './icons.js';
import { Popover } from './Popover.js';
import {
  CameraMotionPanel,
  MotionLanes,
  useCameraMotionView,
  useSmoothRange,
  type MotionLanesProps,
} from './SmoothRange.js';
import { SourceTransport, type SourceTransportState } from './source-transport.js';
import { useDelayedFlag } from './use-delayed-flag.js';
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
  /** The recording's kept ranges (empty: the whole recording) and the one the range editor shows. */
  kept: readonly SelectRange[];
  activeKept: number;
  onActivateKept: (index: number) => void;
  /** Replaces the recording's kept ranges and edits the given one; throws when the project rejects them. */
  onKept: (kept: readonly SelectRange[], active: number) => void;
  excerpts: readonly RushExcerpt[];
  disabled: boolean;
  onFrame: (frame: number) => void;
  /** Applies a range to the active kept range; throws when the project rejects it, for the editor to show. */
  onRange: (range: MediaSelection) => void;
  onClose: () => void;
  /** Adds the applied range, or the given ranges in one Undo step; returns the first new clip. */
  onInsert: (ranges?: readonly MediaSelection[]) => string | null;
  onRevealClip: (id: string) => void;
  targetLayer: string;
  ref?: Ref<SourcePlayback>;
}

/** Lets the editor's Space shortcut play or pause the source preview while it is displayed. */
export interface SourcePlayback {
  toggle: () => void;
  /** Seek the open recording without a render of the editor; false when another one is shown. */
  show: (mediaId: string, frame: number) => boolean;
}

interface Observation {
  key: string;
  state: SourceTransportState;
}
interface RangeCommands {
  mark: (edge: MediaSelectionEdge) => void;
  /** Applies a range as the editor's own edit, so a rejection shows inline. */
  apply: (range: MediaSelection) => void;
  cancel: () => boolean;
}
interface RangeProps {
  asset: MediaAsset;
  range: MediaSelection;
  /** The other kept ranges are drawn on the strip. */
  kept: readonly SelectRange[];
  activeKept: number;
  onActivateKept: (index: number) => void;
  onKept: (kept: readonly SelectRange[], active: number) => void;
  /** Adds one clip per kept range in one Undo step. */
  onAddAll: (kept: readonly SelectRange[]) => void;
  addAllDisabled: boolean;
  targetLayer: string;
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
  /** Camera motion lanes stacked under the strip, sharing its playhead and range. */
  motion: Omit<MotionLanesProps, 'range'> | null;
  ref: Ref<RangeCommands>;
}
interface RangeDrag {
  pointerId: number;
  element: HTMLElement;
  /** A handle being dragged, or a new kept range being drawn with Shift on the strip. */
  edge: MediaSelectionEdge | 'draw';
  base: MediaSelection;
  candidate: MediaSelection;
  startX: number;
  width: number;
  headBefore: number;
  /** Drawing only: the frame it started at, the free stretch it stays in, and whether the pointer moved. */
  anchor: number;
  stretch: FreeStretch;
  moved: boolean;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Cannot review this recording.';
}

function addedFeedback(count: number): string {
  return count > 1 ? `${count} clips added · one per range` : 'Clip added · mark another range';
}

/** One video-only proxy decoder, independent of the project preview and transport. */
export function SourceReview({
  asset,
  frame,
  range,
  kept,
  activeKept,
  onActivateKept,
  onKept,
  excerpts,
  disabled,
  onFrame,
  onRange,
  onClose,
  onInsert,
  onRevealClip,
  targetLayer,
  ref,
}: Readonly<Props>) {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const transport = useRef<SourceTransport | null>(null);
  const commands = useRef<RangeCommands | null>(null);
  const [observation, setObservation] = useState<Observation | null>(null);
  const [decoderError, setDecoderError] = useState('');
  const [visible, setVisible] = useState(true);
  const [retry, setRetry] = useState(0);
  const [lastAdded, setLastAdded] = useState<{ id: string; count: number } | null>(null);
  const [rangeDraft, setRangeDraft] = useState(false);
  const smooth = useSmoothRange(asset);
  const motionView = useCameraMotionView();
  const requestedFrame = Math.max(0, Math.min(asset.metadata.frameCount - 1, Math.round(frame)));
  const rate = asset.metadata.frameRate;
  const resourceKey = `${asset.id}/${asset.prepared?.verification.verifiedAt}/${asset.metadata.frameCount}/${rate.numerator}/${rate.denominator}/${retry}`;
  const latest = useRef({ range, onFrame });
  latest.current = { range, onFrame };
  // The latest requested frame: `frame` only changes when the editor opens or returns to a frame.
  const position = useRef({ mediaId: asset.id, frame: requestedFrame });

  useEffect(() => {
    setLastAdded(null);
  }, [asset.id]);

  useEffect(() => {
    let inView = true;
    let wasVisible = true;
    // Hidden observations are ignored, and a newly visible transport publishes its own
    // state on creation: hiding then showing within one render keeps the live transport.
    const change = (): void => {
      const next = inView && !document.hidden;
      if (next === wasVisible) return;
      wasVisible = next;
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
    if (typeof VideoDecoder !== 'function') {
      setDecoderError('Source review requires WebCodecs video decoding in a current browser.');
      return;
    }
    setDecoderError('');
    if (!mediaReady(asset) || asset.prepared?.verification.frameCount !== asset.metadata.frameCount) {
      setDecoderError('Prepare a complete, verified recording proxy before reviewing it.');
      return;
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      setDecoderError('Source review cannot draw decoded frames in this browser.');
      return;
    }
    canvas.dataset['sourceDecoder'] = 'true';
    host.current.append(canvas);
    const draw = (frame: VideoFrame): void => {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    };
    const mediaId = asset.id;
    const owner = new SourceTransport(
      new VideoStreams(1),
      draw,
      rate,
      asset.metadata.frameCount,
      latest.current.range,
      position.current.mediaId === mediaId ? position.current.frame : requestedFrame,
      (state) => {
        position.current = { mediaId, frame: state.requestedFrame };
        setObservation({ key: resourceKey, state });
        if (state.frame !== null) latest.current.onFrame(state.frame);
      },
    );
    transport.current = owner;
    setObservation({ key: resourceKey, state: owner.state });
    // Registered, identity-guarded proxy only. Never play an original or prepare implicitly.
    owner.load(`/api/media/${encodeURIComponent(asset.id)}/proxy`);
    return () => {
      owner.dispose();
      canvas.remove();
      if (transport.current === owner) transport.current = null;
    };
  }, [resourceKey, visible]);

  useLayoutEffect(() => {
    position.current = { mediaId: asset.id, frame: requestedFrame };
    transport.current?.follow(requestedFrame);
  }, [requestedFrame, asset.id]);
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
  const shownFrame = observedFrame ?? currentObservation?.requestedFrame ?? requestedFrame;
  const error = decoderError || currentObservation?.error || '';
  const buffering = !error && (observedFrame === null || currentObservation?.status === 'buffering');
  // A seek keeps the previous image instead of blinking; 250 ms without a new image hides it and says so.
  const seekingShown = useDelayedFlag(buffering, undefined, observedFrame);
  const playing = currentObservation?.status === 'playing' || currentObservation?.status === 'starting';
  const steadyTransportLabel = playing ? 'Playing' : 'Paused';
  const transportLabel = currentObservation?.status === 'starting' ? 'Starting' : steadyTransportLabel;
  const playDisabled = rangeDraft || !visible || disabled || (!playing && (buffering || !!error));
  const togglePlayback = (): void => {
    if (playing) pause();
    else if (!playDisabled) transport.current?.play();
  };
  useImperativeHandle(ref, () => ({
    toggle: togglePlayback,
    show(mediaId, frame) {
      if (mediaId !== asset.id) return false;
      const next = Math.max(0, Math.min(asset.metadata.frameCount - 1, Math.round(frame)));
      position.current = { mediaId, frame: next };
      transport.current?.follow(next);
      return true;
    },
  }));
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    // Space reaches the editor shortcut, which plays this preview while it is displayed.
    if (event.code === 'Space') return;
    // No other source-review shortcut may reach the main preview's window handlers.
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

  const lastAddedExcerpt = excerpts.find((excerpt) => excerpt.id === lastAdded?.id);
  const insertDisabled = disabled || !mediaReady(asset);
  const insertExcerpt = (ranges?: readonly MediaSelection[]): void => {
    setLastAdded(null);
    if (insertDisabled) return;
    const id = onInsert(ranges);
    if (id !== null) setLastAdded({ id, count: ranges?.length ?? 1 });
  };

  return (
    <section
      className="source-review rush-source"
      aria-label="Source review"
      data-source-excerpt-count={excerpts.length}
    >
      <div className="source-review-heading">
        <div>
          <div className="source-review-title">
            <strong title={asset.name}>{asset.name}</strong>
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
          <span>
            {asset.metadata.width} × {asset.metadata.height} · original source frames
          </span>
        </div>
        <button
          className="primary-button small"
          type="button"
          aria-label={`Add clip ${sourceSeconds(range.sourceOut - range.sourceIn)} to timeline`}
          title={`Append this range to ${targetLayer} as a new, independent clip; omitted source frames remain available`}
          disabled={insertDisabled}
          onKeyDown={keyboard}
          onClick={() => insertExcerpt()}
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
          style={{ opacity: seekingShown || error ? 0 : 1 }}
          aria-hidden="true"
        />
        <button
          className="source-preview-focus"
          aria-label={`Review source frame of ${asset.name}`}
          title="Source review: I marks IN, O marks exclusive OUT"
          onKeyDown={keyboard}
        />
        {seekingShown && (
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
        kept={kept}
        activeKept={activeKept}
        onActivateKept={onActivateKept}
        onKept={onKept}
        onAddAll={(ranges) => insertExcerpt(ranges.map((part) => ({ mediaId: asset.id, ...part })))}
        addAllDisabled={insertDisabled || rangeDraft}
        targetLayer={targetLayer}
        frame={shownFrame}
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
            title="Play the applied IN–OUT range without audio; stop at OUT − 1"
            disabled={playDisabled}
            onKeyDown={keyboard}
            onClick={togglePlayback}
          >
            <Icon name={playing ? 'pause' : 'play'} size={19} />
          </button>
        }
        readout={
          <div className="source-review-readout">
            <span title={`Frame ${shownFrame} of ${asset.metadata.frameCount - 1}`}>
              {formatTimecode(shownFrame, rate)}
            </span>
            <small>{transportLabel}</small>
          </div>
        }
        motion={
          mediaReady(asset)
            ? { asset, smooth, view: motionView, disabled: disabled || rangeDraft, onFrame: scrub }
            : null
        }
      />
      {mediaReady(asset) && (
        <CameraMotionPanel
          asset={asset}
          range={range}
          smooth={smooth}
          view={motionView}
          disabled={disabled || rangeDraft}
          onApply={(suggestion) => {
            scrub(suggestion.sourceIn);
            commands.current?.apply({ mediaId: asset.id, ...suggestion });
          }}
          targetLayer={targetLayer}
          addDisabled={insertDisabled || rangeDraft}
          onAddAll={(steady) =>
            insertExcerpt(
              [...steady]
                .sort((a, b) => a.sourceIn - b.sourceIn)
                .map((part) => ({ mediaId: asset.id, sourceIn: part.sourceIn, sourceOut: part.sourceOut })),
            )
          }
          onKeyDown={keyboard}
        />
      )}
      <output
        className="source-add-feedback"
        aria-live="polite"
        aria-atomic="true"
        data-added-clip-id={lastAddedExcerpt?.id}
      >
        {lastAddedExcerpt && addedFeedback(lastAdded?.count ?? 1)}
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
  kept,
  activeKept,
  onActivateKept,
  onKept,
  onAddAll,
  addAllDisabled,
  targetLayer,
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
  motion,
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
  const [drawing, setDrawing] = useState(false);
  const [numbers, setNumbers] = useState({ sourceIn: String(range.sourceIn), sourceOut: String(range.sourceOut) });
  const [error, setError] = useState('');
  const errorId = useId();
  const selected = draft ?? range;
  const bounds = keptRangeBounds(kept, activeKept, count);
  const rate = asset.metadata.frameRate;
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
    setDrawing(false);
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
  useImperativeHandle(ref, () => ({ mark, apply: commit, cancel }));

  const commitNumbers = (): void => {
    if (!numbersDirty || draft !== null) return;
    if (!numbers.sourceIn.trim() || !numbers.sourceOut.trim()) {
      setError('Enter whole source frames for IN and OUT.');
      return;
    }
    commit({ mediaId: asset.id, sourceIn: Number(numbers.sourceIn), sourceOut: Number(numbers.sourceOut) });
  };
  let resetBlocked: string | null = null;
  if (disabled) resetBlocked = 'Finish the current edit before resetting the range.';
  else if (range.sourceIn === 0 && range.sourceOut === count && !numbersDirty && !error)
    resetBlocked = 'The range already covers the whole recording.';
  const resetRange = (): void => {
    if (resetBlocked !== null || drag.current) return;
    if (kept.length > 1) applyKept([], 0);
    else commit({ mediaId: asset.id, sourceIn: 0, sourceOut: count });
  };
  const applyKept = (ranges: readonly SelectRange[], active: number): boolean => {
    if (disabled) return false;
    onPause();
    try {
      onKept(ranges, active);
      setError('');
      return true;
    } catch (cause) {
      setError(message(cause));
      return false;
    }
  };
  const addPlan = addKeptRange(kept, frame, count);
  let addBlocked = 'reason' in addPlan ? addPlan.reason : '';
  if (disabled || draft !== null) addBlocked = 'Finish the current edit before adding a range.';
  const addRange = (): void => {
    if (addBlocked !== '' || drag.current || 'reason' in addPlan) return;
    const plan = insertKeptRange(kept, addPlan.range);
    if ('reason' in plan) setError(plan.reason);
    else if (applyKept(plan.ranges, plan.index)) onFrame(addPlan.range.sourceIn);
  };
  const removeRange = (index: number): void => {
    if (drag.current || draft !== null) return;
    const next = removeKeptRange(kept, index, activeKept);
    applyKept(next.ranges, next.active);
  };
  const activate = (index: number): void => {
    if (disabled || draft !== null) return;
    onPause();
    onActivateKept(index);
    onFrame(kept[index]!.sourceIn);
  };

  const changeNumber = (event: ChangeEvent<HTMLInputElement>, edge: MediaSelectionEdge): void => {
    const text = event.currentTarget.value;
    const { nativeEvent } = event;
    // Chrome steps with a plain Event, Firefox with insertReplacementText; typing is any other InputEvent.
    const typed =
      nativeEvent instanceof InputEvent &&
      nativeEvent.inputType !== '' &&
      nativeEvent.inputType !== 'insertReplacementText';
    const next = edge === 'in' ? { ...numbers, sourceIn: text } : { ...numbers, sourceOut: text };
    setNumbers(next);
    if (typed || !next.sourceIn.trim() || !next.sourceOut.trim()) return;
    const candidate = { mediaId: asset.id, sourceIn: Number(next.sourceIn), sourceOut: Number(next.sourceOut) };
    commit(candidate);
    const shown = edge === 'in' ? candidate.sourceIn : candidate.sourceOut - 1;
    if (Number.isInteger(shown) && shown >= 0 && shown < count) onFrame(shown);
  };

  const frameAt = (clientX: number): number => {
    const box = strip.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0;
    return Math.max(0, Math.min(count - 1, Math.floor(((clientX - box.left) / box.width) * count)));
  };
  const moveAt = (clientX: number): void => {
    const active = drag.current;
    if (!active) return;
    if (active.edge === 'draw') {
      const at = Math.max(active.stretch.from, Math.min(active.stretch.to - 1, frameAt(clientX)));
      active.moved ||= Math.abs(clientX - active.startX) >= 3;
      active.candidate = {
        mediaId: asset.id,
        sourceIn: Math.min(active.anchor, at),
        sourceOut: Math.max(active.anchor, at) + 1,
      };
      setDraft(active.candidate);
      onFrame(at);
      return;
    }
    const initial = active.edge === 'in' ? active.base.sourceIn : active.base.sourceOut;
    const boundary = initial + Math.round(((clientX - active.startX) * count) / active.width);
    // A handle stops one frame from the neighbouring kept ranges instead of failing on release.
    const limited = active.edge === 'in' ? Math.max(bounds.minIn, boundary) : Math.min(bounds.maxOut, boundary);
    active.candidate = moveMediaSelectionEdge(active.base, active.edge, limited, count);
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
      anchor: frame,
      stretch: { from: 0, to: count },
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ ...range });
    setError('');
    onFrame(edge === 'in' ? range.sourceIn : range.sourceOut - 1);
  };
  // Shift-drag on the strip draws a new kept range; a click on another kept range edits that one.
  const stripPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || disabled || drag.current || draft !== null) return;
    if (event.target instanceof Element && event.target.closest('.source-trim-handle')) return;
    const at = frameAt(event.clientX);
    if (!event.shiftKey) {
      const index = kept.findIndex(
        (item, position) => position !== activeKept && at >= item.sourceIn && at < item.sourceOut,
      );
      if (index >= 0) onActivateKept(index);
      return;
    }
    const stretch = freeStretchAt(kept, at, count);
    if (!stretch || !strip.current) return;
    event.preventDefault();
    event.stopPropagation();
    onPause();
    const candidate = { mediaId: asset.id, sourceIn: at, sourceOut: at + 1 };
    drag.current = {
      pointerId: event.pointerId,
      element: event.currentTarget,
      edge: 'draw',
      base: { ...range },
      candidate,
      startX: event.clientX,
      width: strip.current.getBoundingClientRect().width,
      headBefore: frame,
      anchor: at,
      stretch,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing(true);
    setDraft(candidate);
    setError('');
    onFrame(at);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    pointerX.current = event.clientX;
    if (animation.current !== null) return;
    animation.current = requestAnimationFrame(() => {
      animation.current = null;
      moveAt(pointerX.current);
    });
  };
  const finish = (event: PointerEvent<HTMLElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    moveAt(event.clientX);
    const active = clearDrag();
    setDraft(null);
    setDrawing(false);
    if (!active) return;
    if (active.edge !== 'draw') {
      commit(active.candidate);
      return;
    }
    if (!active.moved) return;
    const plan = insertKeptRange(kept, { sourceIn: active.candidate.sourceIn, sourceOut: active.candidate.sourceOut });
    if ('reason' in plan) setError(plan.reason);
    else applyKept(plan.ranges, plan.index);
  };
  const trimKeyboard = (event: KeyboardEvent<HTMLButtonElement>, edge: MediaSelectionEdge): void => {
    if (disabled || drag.current) return;
    const value = edge === 'in' ? range.sourceIn : range.sourceOut;
    const step = event.shiftKey ? 10 : 1;
    const positions: Readonly<Record<string, number>> = {
      ArrowLeft: value - step,
      ArrowRight: value + step,
      Home: edge === 'in' ? bounds.minIn : range.sourceIn + 1,
      End: edge === 'out' ? bounds.maxOut : range.sourceOut - 1,
    };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const limited = edge === 'in' ? Math.max(bounds.minIn, next) : Math.min(bounds.maxOut, next);
    const candidate = moveMediaSelectionEdge(range, edge, limited, count);
    commit(candidate);
    onFrame(edge === 'in' ? candidate.sourceIn : candidate.sourceOut - 1);
  };

  return (
    <div className="source-range-editor" data-dirty={numbersDirty || draft !== null}>
      <div className="source-track">
        {transport}
        <div className="source-track-stack">
          <div
            className="source-range-strip"
            ref={strip}
            aria-label="Range"
            title="Click or drag to scrub; click another kept range to edit it; Shift-drag to draw a new kept range"
            data-source-in={selected.sourceIn}
            data-source-out={selected.sourceOut}
            data-range-draft={draft ? 'true' : 'false'}
            data-drawing={drawing ? 'true' : undefined}
            data-snapshots={snapshotsAvailable ? 'true' : 'false'}
            onPointerDownCapture={stripPointerDown}
            onPointerMove={(event) => {
              if (drag.current?.edge === 'draw') move(event);
            }}
            onPointerUp={(event) => {
              if (drag.current?.edge === 'draw') finish(event);
            }}
            onPointerCancel={() => {
              if (drag.current?.edge === 'draw') cancel();
            }}
            onLostPointerCapture={() => {
              if (drag.current?.edge === 'draw') cancel();
            }}
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
            <DamageMarks damage={asset.damage} count={count} className="source-range-damaged" />
            {kept.map((item, index) =>
              index === activeKept && !drawing ? null : (
                <span
                  key={`${item.sourceIn}-${item.sourceOut}`}
                  className="source-range-kept"
                  style={{
                    left: `${(item.sourceIn / count) * 100}%`,
                    width: `${((item.sourceOut - item.sourceIn) / count) * 100}%`,
                  }}
                  aria-hidden="true"
                />
              ),
            )}
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
                  aria-valuemin={edge === 'in' ? bounds.minIn : selected.sourceIn + 1}
                  aria-valuemax={edge === 'in' ? selected.sourceOut - 1 : bounds.maxOut}
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
          {motion && <MotionLanes {...motion} range={selected} />}
          <span
            className="source-range-head"
            style={{ left: `${count === 1 ? 0 : (frame / (count - 1)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
      <div className="source-range-row">
        {readout}
        <KeptRanges
          kept={kept}
          activeKept={activeKept}
          rate={rate}
          busy={disabled || draft !== null}
          addBlocked={addBlocked}
          addAllDisabled={addAllDisabled}
          targetLayer={targetLayer}
          onActivate={activate}
          onRemove={removeRange}
          onAdd={addRange}
          onAddAll={() => onAddAll(kept)}
        />
        <form
          className="source-range-numbers"
          onSubmit={(event) => event.preventDefault()}
          onBlur={(event) => {
            // Tabbing from IN to OUT must not validate the pair against a stale OUT.
            if (!event.currentTarget.contains(event.relatedTarget)) commitNumbers();
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
              title="Enter or leave the pair to apply. Escape restores."
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) commitNumbers();
                onKeyDown(event);
              }}
              onChange={(event) => changeNumber(event, 'in')}
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
              title="Enter or leave the pair to apply. Escape restores."
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) commitNumbers();
                onKeyDown(event);
              }}
              onChange={(event) => changeNumber(event, 'out')}
            />
          </label>
          <button
            type="button"
            className="icon-button source-range-reset"
            aria-label="Reset source range"
            aria-disabled={resetBlocked !== null}
            tabIndex={resetBlocked === null ? 0 : -1}
            title={
              resetBlocked ??
              (kept.length > 1
                ? 'Reset to the whole recording: removes every kept range'
                : 'Reset IN and OUT to the whole recording')
            }
            onKeyDown={onKeyDown}
            onClick={resetRange}
          >
            <Icon name="reset" size={13} />
          </button>
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

/** The recording's kept ranges with timecodes and lengths: choose, remove and add them, or add one clip per range. */
function KeptRanges({
  kept,
  activeKept,
  rate,
  busy,
  addBlocked,
  addAllDisabled,
  targetLayer,
  onActivate,
  onRemove,
  onAdd,
  onAddAll,
}: Readonly<{
  kept: readonly SelectRange[];
  activeKept: number;
  rate: MediaAsset['metadata']['frameRate'];
  busy: boolean;
  addBlocked: string;
  addAllDisabled: boolean;
  targetLayer: string;
  onActivate: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onAddAll: () => void;
}>) {
  const noun = kept.length === 1 ? 'range' : 'ranges';
  const summary = kept.length ? `${kept.length} kept ${noun}` : 'Whole recording';
  const list = useRef<HTMLDivElement>(null);
  const remove = (index: number): void => {
    onRemove(index);
    // The removed row's button is gone: focus the row now at its place, else Add range.
    requestAnimationFrame(() => {
      const removes = list.current?.querySelectorAll<HTMLButtonElement>('.source-kept-remove');
      const next = removes?.[Math.min(index, removes.length - 1)] ?? list.current?.querySelector('.source-kept-add');
      if (next instanceof HTMLElement && !list.current?.contains(document.activeElement)) next.focus();
    });
  };
  return (
    <Popover
      className="source-kept"
      label="Kept ranges"
      title={
        kept.length
          ? `${summary}: choose, remove or add ranges`
          : 'The whole recording is kept: set IN and OUT, or add a range'
      }
      trigger={
        <span>
          {summary} <Icon name="chevron-down" size={12} />
        </span>
      }
    >
      <div className="source-kept-body" ref={list}>
        <p className="source-kept-description">
          {kept.length ? 'IN → OUT · OUT exclusive' : 'The whole recording is kept: set IN and OUT, or add a range.'}
        </p>
        {kept.length > 0 && (
          <ol className="source-kept-list" aria-label="Kept ranges of this recording">
            {kept.map((item, index) => (
              <li
                key={`${item.sourceIn}-${item.sourceOut}`}
                className="source-kept-row"
                data-active={index === activeKept ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="source-kept-choose"
                  aria-label={`Kept range ${index + 1}, ${formatTimecode(item.sourceIn, rate)} to ${formatTimecode(item.sourceOut, rate)}, ${sourceSeconds(item.sourceOut - item.sourceIn)}`}
                  aria-pressed={index === activeKept}
                  disabled={busy}
                  onClick={() => onActivate(index)}
                >
                  <strong>{index + 1}</strong>
                  <span className="source-kept-range">
                    {formatTimecode(item.sourceIn, rate)} → {formatTimecode(item.sourceOut, rate)}
                  </span>
                  <span className="source-kept-length">{sourceSeconds(item.sourceOut - item.sourceIn)}</span>
                </button>
                <button
                  type="button"
                  className="icon-button source-kept-remove"
                  aria-label={`Remove kept range ${index + 1}`}
                  title={
                    kept.length === 1
                      ? 'Remove this range: the whole recording is kept again'
                      : 'Remove this range from the kept ranges'
                  }
                  disabled={busy}
                  onClick={() => remove(index)}
                >
                  <Icon name="trash" size={13} />
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="source-kept-actions">
          <button
            type="button"
            className="secondary-button small source-kept-add"
            aria-disabled={addBlocked !== ''}
            title={
              addBlocked ||
              'Keep another range: from the displayed frame when it is free, else in the largest free stretch'
            }
            onClick={onAdd}
          >
            <Icon name="plus" size={13} />
            Add range
          </button>
          {kept.length > 1 && (
            <button
              type="button"
              className="secondary-button small"
              aria-label={`Add all ${kept.length} kept ranges to ${targetLayer}`}
              title={`Add one clip per kept range to ${targetLayer}, in one Undo step`}
              disabled={addAllDisabled}
              onClick={onAddAll}
            >
              <Icon name="plus" size={13} />
              Add all {kept.length}
            </button>
          )}
        </div>
        <p className="source-kept-description">Shift-drag on the range strip to draw a range.</p>
      </div>
    </Popover>
  );
}
