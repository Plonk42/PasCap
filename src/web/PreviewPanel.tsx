import type { RefObject } from 'react';
import type { PreviewDiagnostics } from '../preview/engine.js';
import { formatTimecode } from '../shared/timing.js';
import { Icon } from './icons.js';
import { TimecodeField } from './TimecodeField.js';

interface Props {
  canvas: RefObject<HTMLCanvasElement | null>;
  diagnostics: PreviewDiagnostics | null;
  duration: number;
  drafting: boolean;
  onTogglePlayback: () => void;
  onSeek: (frame: number) => void;
  onRetry: () => void;
  onMedia: () => void;
  onImport: () => void;
  loading: boolean;
}

function previewCaption(loading: boolean, diagnostics: PreviewDiagnostics | null) {
  if (loading) return { heading: 'Opening your workspace', message: 'Connecting to the local service…' };
  if (diagnostics?.status === 'error') return { heading: 'Preview needs attention', message: diagnostics.message };
  return { heading: 'Start your edit', message: 'Import a folder, wait for editing proxies, then add an excerpt from Media.' };
}

export function PreviewPanel({ canvas, diagnostics, duration, drafting, onTogglePlayback, onSeek, onRetry, onMedia, onImport, loading }: Readonly<Props>) {
  const frame = diagnostics?.frame ?? 0;
  const status = diagnostics?.status ?? 'empty';
  const waiting = ['loading', 'seeking', 'buffering'].includes(status);
  const label = { playing: 'Playing', paused: 'Paused' }[status as 'playing' | 'paused'] ?? status;
  const caption = previewCaption(loading, diagnostics);
  return <section className="preview-panel" aria-label="Preview">
    <div className="preview-heading"><h2>Preview</h2><span className="preview-quality" title={diagnostics?.renderer}>720p · 29.97 fps</span></div>
    <div className="canvas-stage"><canvas ref={canvas} aria-label="WebGL live video preview" />
      {(!duration || status === 'error') && <div className="preview-empty"><Icon name="video" size={36} /><h3>{caption.heading}</h3><p>{caption.message}</p>{!loading && <div className="empty-actions">{status === 'error' ? <button className="secondary-button" onClick={onRetry}>Retry preview</button> : <><button className="primary-button" onClick={onMedia}>Browse Media</button><button className="secondary-button" onClick={onImport}>Import folder</button></>}</div>}</div>}
      {waiting && <div className="buffering-overlay"><span className="spinner" />{diagnostics?.message}</div>}
    </div>
    <div className="transport"><span className="transport-note"><span className={`transport-dot ${status}`} />{duration ? label : 'No clips'}</span><div className="transport-buttons">
      <button className="icon-button" aria-label="Go to timeline start" title="Timeline start (Home)" disabled={!duration || drafting} onClick={() => onSeek(0)}><Icon name="start" size={16} /></button>
      <button className="icon-button" aria-label="Previous frame" disabled={!duration || drafting} onClick={() => onSeek(Math.max(0, frame - 1))}><Icon name="back" size={16} /></button>
      <button className="play-button" aria-label={diagnostics?.playing ? 'Pause preview' : 'Play preview'} disabled={!duration || drafting} onClick={onTogglePlayback}><Icon name={diagnostics?.playing ? 'pause' : 'play'} size={21} /></button>
      <button className="icon-button" aria-label="Next frame" title="Next frame (→)" disabled={!duration || drafting} onClick={() => onSeek(Math.min(duration - 1, frame + 1))}><Icon name="forward" size={16} /></button>
      <button className="icon-button" aria-label="Go to timeline end" title="Timeline end (End)" disabled={!duration || drafting} onClick={() => onSeek(duration - 1)}><Icon name="end" size={16} /></button>
    </div><div className="timecode"><TimecodeField frame={Math.min(frame, Math.max(0, duration - 1))} duration={duration} disabled={!duration || drafting} onSeek={onSeek} /><span>/ {formatTimecode(duration)}</span><small title="30 fps nominal, non-drop-frame">NDF</small></div></div>
  </section>;
}