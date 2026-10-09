import type { RefObject } from 'react';
import type { PreviewDiagnostics } from '../preview/engine.js';
import { formatTimecode } from '../shared/timing.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import './preview-comparison.css';
import { TimecodeField } from './TimecodeField.js';

interface Props {
  canvas: RefObject<HTMLCanvasElement | null>;
  diagnostics: PreviewDiagnostics | null;
  duration: number;
  drafting: boolean;
  onTogglePlayback: () => void;
  onToggleUngraded: () => void;
  onSeek: (frame: number) => void;
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
        Import folder
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
  onToggleUngraded,
  onSeek,
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
  const waiting = ['loading', 'seeking', 'buffering'].includes(status);
  const failed = !!startupError || status === 'error';
  const controlsUnavailable = !duration || drafting || loading || !!startupError;
  const label = { playing: 'Playing', paused: 'Paused' }[status as 'playing' | 'paused'] ?? status;
  const caption = previewCaption(loading, diagnostics, startupError);
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
            aria-label="Show ungraded preview"
            aria-pressed={diagnostics?.ungraded ?? false}
            title="Preview only: bypass all colour adjustments on every video track, keeping opacity, fades and transitions. Saved grades and exports are unchanged."
            disabled={controlsUnavailable || failed || !diagnostics || status === 'disposed'}
            onClick={onToggleUngraded}
          >
            <Icon name="colour" size={14} />
            {diagnostics?.ungraded ? 'Ungraded' : 'Compare'}
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
        {diagnostics?.ungraded && <span className="preview-comparison-overlay">Ungraded · colour bypassed</span>}
      </div>
      <div className="transport">
        <span className="transport-note">
          <span className={`transport-dot ${status}`} />
          {duration ? label : 'Empty timeline'}
        </span>
        <div className="transport-buttons">
          <button
            className="icon-button"
            aria-label="Go to timeline start"
            title="Timeline start (Home)"
            disabled={controlsUnavailable}
            onClick={() => onSeek(0)}
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
            className="play-button"
            aria-label={diagnostics?.playing ? 'Pause preview' : 'Play preview'}
            title="Play or pause (Space)"
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
            aria-label="Go to timeline end"
            title="Timeline end (End)"
            disabled={controlsUnavailable}
            onClick={() => onSeek(duration - 1)}
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
