import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { PreviewDiagnostics } from '../preview/engine.js';
import { formatTimecode } from '../shared/timing.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import './preview-comparison.css';
import { TimecodeField } from './TimecodeField.js';
import { useDelayedFlag } from './use-delayed-flag.js';

interface Props {
  canvas: RefObject<HTMLCanvasElement | null>;
  diagnostics: PreviewDiagnostics | null;
  duration: number;
  drafting: boolean;
  onTogglePlayback: () => void;
  /** Play covers only the selected timeline range. */
  rangeSelected: boolean;
  /** Shows the image without Colour and Detail for as long as `active` stays true. */
  onHoldOriginal: (active: boolean) => void;
  onSeek: (frame: number) => void;
  /** Start/end of the selected range, else of the timeline. */
  onSeekBoundary: (edge: 'start' | 'end') => void;
  onRetry: () => void;
  onMedia: () => void;
  onImport: () => void;
  loading: boolean;
  startupError: string;
  onReload: () => void;
  onDownload: () => void;
  canDownload: boolean;
  recoveryBusy: boolean;
}

function previewCaption(loading: boolean, diagnostics: PreviewDiagnostics | null, startupError: string) {
  if (startupError)
    return {
      heading: 'Preview needs attention',
      message:
        'Check the local service, then reload. Reload first saves pending edits; if saving fails, download the project and use save recovery.',
    };
  if (loading) return { heading: 'Opening your workspace', message: 'Loading the local editor and preview…' };
  if (diagnostics?.status === 'error') return { heading: 'Preview needs attention', message: diagnostics.message };
  return {
    heading: 'Start your edit',
    message: 'Import a folder, wait for editing proxies, then add a clip from Media.',
  };
}

function PreviewActions({
  startupError,
  runtimeError,
  onRetry,
  onMedia,
  onImport,
  onReload,
  onDownload,
  canDownload,
  recoveryBusy,
}: Readonly<
  Pick<
    Props,
    'startupError' | 'onRetry' | 'onMedia' | 'onImport' | 'onReload' | 'onDownload' | 'canDownload' | 'recoveryBusy'
  > & { runtimeError: boolean }
>) {
  if (startupError)
    return (
      <>
        <button className="secondary-button" disabled={recoveryBusy} onClick={onReload}>
          Reload editor
        </button>
        {canDownload && (
          <button className="secondary-button" onClick={onDownload}>
            Download project
          </button>
        )}
      </>
    );
  if (runtimeError)
    return (
      <button className="secondary-button" onClick={onRetry}>
        Retry preview
      </button>
    );
  return (
    <>
      <button className="primary-button" onClick={onMedia}>
        Browse Media
      </button>
      <button className="secondary-button" onClick={onImport}>
        Import media
      </button>
    </>
  );
}

export function PreviewPanel({
  canvas,
  diagnostics,
  duration,
  drafting,
  onTogglePlayback,
  rangeSelected,
  onHoldOriginal,
  onSeek,
  onSeekBoundary,
  onRetry,
  onMedia,
  onImport,
  loading,
  startupError,
  onReload,
  onDownload,
  canDownload,
  recoveryBusy,
}: Readonly<Props>) {
  const frame = diagnostics?.frame ?? 0;
  const status = diagnostics?.status ?? 'empty';
  // A scrub drawing frames on its way keeps the image: wait 250 ms without a new one.
  const waiting = useDelayedFlag(
    ['loading', 'seeking', 'buffering'].includes(status),
    undefined,
    status === 'seeking' ? frame : undefined,
  );
  const failed = !!startupError || status === 'error';
  const controlsUnavailable = !duration || drafting || loading || !!startupError;
  const label = { playing: 'Playing', paused: 'Paused' }[status as 'playing' | 'paused'] ?? status;
  const caption = previewCaption(loading, diagnostics, startupError);
  const holding = useRef(false);
  const hold = useCallback(
    (active: boolean) => {
      if (holding.current === active) return;
      holding.current = active;
      onHoldOriginal(active);
    },
    [onHoldOriginal],
  );
  useEffect(() => {
    const release = () => hold(false);
    window.addEventListener('blur', release);
    return () => window.removeEventListener('blur', release);
  }, [hold]);
  const pressPointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    hold(true);
  };
  const keyHold = (event: KeyboardEvent<HTMLButtonElement>, active: boolean) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) hold(active);
  };
  return (
    <section className="preview-panel" aria-label="Preview">
      <div className="preview-heading preview-comparison-heading">
        <h2>Preview</h2>
        <div className="preview-comparison-controls">
          <span className="preview-quality" title={diagnostics?.renderer}>
            720p · 29.97 fps
          </span>
          <button
            type="button"
            className="preview-comparison-toggle"
            aria-label="Show original preview"
            aria-pressed={diagnostics?.ungraded ?? false}
            title="Hold to show the image without Colour and Detail on every video track, keeping geometry, Opacity, fades and transitions. Preview only; saved edits and exports are unchanged."
            disabled={controlsUnavailable || failed || !diagnostics || status === 'disposed'}
            onPointerDown={pressPointer}
            onPointerUp={() => hold(false)}
            onPointerCancel={() => hold(false)}
            onLostPointerCapture={() => hold(false)}
            onKeyDown={(event) => keyHold(event, true)}
            onKeyUp={(event) => keyHold(event, false)}
            onBlur={() => hold(false)}
          >
            <Icon name="colour" size={14} />
            Original
          </button>
        </div>
      </div>
      <div className="canvas-stage">
        <canvas ref={canvas} aria-label="WebGL live video preview" />
        {(!duration || failed || loading) && (
          <div className="preview-empty" role={failed ? 'alert' : undefined}>
            {loading ? <span className="spinner" /> : <Icon name="video" size={36} />}
            <div className="preview-empty-heading">
              <h3>{caption.heading}</h3>
              {startupError && (
                <HelpPopover label="Startup details">
                  <p>{startupError}</p>
                </HelpPopover>
              )}
            </div>
            <p>{caption.message}</p>
            {!loading && (
              <div className="empty-actions">
                <PreviewActions
                  startupError={startupError}
                  runtimeError={status === 'error'}
                  onRetry={onRetry}
                  onMedia={onMedia}
                  onImport={onImport}
                  onReload={onReload}
                  onDownload={onDownload}
                  canDownload={canDownload}
                  recoveryBusy={recoveryBusy}
                />
              </div>
            )}
          </div>
        )}
        {waiting && (
          <div className="buffering-overlay">
            <span className="spinner" />
            {diagnostics?.message}
          </div>
        )}
        {diagnostics?.ungraded && (
          <span className="preview-comparison-overlay">Original · Colour and Detail bypassed</span>
        )}
      </div>
      <div className="transport">
        <span className="transport-note">
          <span className={`transport-dot ${status}`} />
          {duration ? label : 'Empty timeline'}
        </span>
        <div className="transport-buttons">
          <button
            className="icon-button"
            aria-label={rangeSelected ? 'Go to selection start' : 'Go to timeline start'}
            title={rangeSelected ? 'Selection start (Home)' : 'Timeline start (Home)'}
            disabled={controlsUnavailable}
            onClick={() => onSeekBoundary('start')}
          >
            <Icon name="start" size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Previous frame"
            title="Previous frame (←)"
            disabled={controlsUnavailable}
            onClick={() => onSeek(Math.max(0, frame - 1))}
          >
            <Icon name="back" size={16} />
          </button>
          <button
            className={`play-button ${rangeSelected ? 'range-play' : ''}`}
            aria-label={diagnostics?.playing ? 'Pause preview' : 'Play preview'}
            title={rangeSelected ? 'Play the selected range or pause (Space)' : 'Play or pause (Space)'}
            disabled={controlsUnavailable}
            onClick={onTogglePlayback}
          >
            <Icon name={diagnostics?.playing ? 'pause' : 'play'} size={21} />
          </button>
          <button
            className="icon-button"
            aria-label="Next frame"
            title="Next frame (→)"
            disabled={controlsUnavailable}
            onClick={() => onSeek(Math.min(duration - 1, frame + 1))}
          >
            <Icon name="forward" size={16} />
          </button>
          <button
            className="icon-button"
            aria-label={rangeSelected ? 'Go to selection end' : 'Go to timeline end'}
            title={rangeSelected ? 'Selection end (End)' : 'Timeline end (End)'}
            disabled={controlsUnavailable}
            onClick={() => onSeekBoundary('end')}
          >
            <Icon name="end" size={16} />
          </button>
        </div>
        <div className="timecode">
          <TimecodeField
            frame={Math.min(frame, Math.max(0, duration - 1))}
            duration={duration}
            disabled={controlsUnavailable}
            onSeek={onSeek}
          />
          <span>/ {formatTimecode(duration)}</span>
          <small title="30 fps nominal, non-drop-frame">NDF</small>
        </div>
      </div>
    </section>
  );
}
