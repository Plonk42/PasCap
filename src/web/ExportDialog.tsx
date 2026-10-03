import { useId, useRef, useState, type RefObject } from 'react';
import { EXPORT_PROFILES, EXPORT_RESOURCES, LAYERED_EXPORT_RESOURCES, needsLayeredExport, type ExportProfile } from '../shared/export.js';
import { keySettings } from '../shared/keyframes.js';
import type { MediaJob } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';
import { framesToSeconds } from '../shared/timing.js';
import { durationLabel } from './display.js';
import { orderActivityJobs } from './Jobs.js';
import { Modal } from './Modal.js';

export interface ExportDialogProps {
  project: ProjectDocument;
  jobs: readonly MediaJob[];
  busy: boolean;
  error: string;
  onExport: (profile: ExportProfile) => Promise<boolean>;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function summarizeExport(project: ProjectDocument) {
  const keys = { points: 0, settings: 0, speed: 0, colour: 0, clipOpacity: 0, layerOpacity: 0 };
  for (const layer of project.layers) {
    keys.points += layer.keyframes.length;
    for (const point of layer.keyframes) {
      for (const setting of keySettings(point)) {
        keys.settings++;
        if (setting === 'speed' || setting === 'clipOpacity' || setting === 'layerOpacity') keys[setting]++;
        else keys.colour++;
      }
    }
  }
  return {
    duration: calculateLayout(project).duration,
    clips: project.clips.length,
    layers: project.layers.length,
    enabledLayers: project.layers.filter((layer) => layer.enabled).length,
    keys,
    keyframeCount: keys.points,
    layered: needsLayeredExport(project),
  };
}

export function ExportDialog({ project, jobs, busy, error, onExport, onClose, restoreFocusTo }: Readonly<ExportDialogProps>) {
  const id = useId();
  const [profile, setProfile] = useState<ExportProfile>('draft720');
  const [pending, setPending] = useState(false);
  const submission = useRef(false);
  const [localError, setLocalError] = useState('');
  const submitting = busy || pending;
  const summary = summarizeExport(project);
  const settings = EXPORT_PROFILES[profile];
  const history = orderActivityJobs(jobs).filter((job) => job.kind === 'export' && job.state === 'completed');

  const startExport = async (): Promise<void> => {
    if (busy || submission.current || !summary.duration || !summary.clips) return;
    submission.current = true; setPending(true); setLocalError('');
    try {
      if (await onExport(profile)) onClose();
      else setLocalError('The export could not be submitted. Check the error and try again.');
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : 'The export could not be submitted.'); }
    finally { submission.current = false; setPending(false); }
  };

  return <Modal className="export-dialog" labelledBy={`${id}-title`} describedBy={`${id}-snapshot`} busy={submitting} error={error || localError} onClose={onClose} {...(restoreFocusTo ? { restoreFocusTo } : {})} footer={<>
    <button className="secondary-button" onClick={onClose} disabled={submitting}>Cancel</button>
    <button className="primary-button" disabled={submitting || !summary.duration || !summary.clips} onClick={() => { void startExport(); }}>Start export</button>
  </>}>
    <div className="activity-dialog-heading"><h2 id={`${id}-title`}>Export video</h2></div>
    <p className="activity-export-project">{project.title}</p>
    <dl className="activity-export-summary">
      <div><dt>Duration</dt><dd>{durationLabel(framesToSeconds(summary.duration))}</dd></div>
      <div><dt>Clips</dt><dd>{summary.clips}</dd></div>
      <div><dt>Video layers</dt><dd>{summary.layers}<small>{summary.enabledLayers} enabled</small></dd></div>
      <div><dt>Shared layer points</dt><dd>{summary.keyframeCount}<small>{summary.keys.settings} participating settings</small></dd></div>
    </dl>
    {summary.keyframeCount > 0 && <p className="activity-hint">{summary.keys.speed} speed values · {summary.keys.colour} colour values · {summary.keys.clipOpacity} clip opacity · {summary.keys.layerOpacity} layer opacity</p>}
    {!summary.clips && <p className="activity-empty">Add a video clip to the project before exporting.</p>}
    <label className="activity-field activity-export-quality"><span>Quality</span><select aria-label="Export quality" value={profile} disabled={submitting} onChange={(event) => setProfile(event.target.value as ExportProfile)}><option value="draft720">720p draft · H.264</option><option value="final4k">4K final · H.264 SDR BT.709</option></select></label>
    <p className="activity-hint">{settings.width} × {settings.height} · H.264 · SDR BT.709. {profile === 'draft720' ? 'Lower-resolution draft for review.' : 'Final-resolution render.'} Both profiles render from originals, not preview proxies.</p>
    <section className="activity-export-snapshot" id={`${id}-snapshot`}><h3>Fixed snapshot</h3><p>The submitted edit includes clip grades and speed, transitions, enabled layers, opacity and keyframes{project.music ? ', and the selected music track' : '; no music track is selected'}. Later edits do not change a submitted render.</p><p>After submission, rendering continues in Activity and the editor remains available.</p></section>
    {summary.layered ? <aside className="activity-export-warning" aria-labelledby={`${id}-resources`}>
      <h3 id={`${id}-resources`}>Layered export resources</h3>
      <p>Layers or shared row keyframes require sequential compositing passes. This can be slow, especially at 4K; no completion-time estimate is available.</p>
      <p>Scratch storage may hold up to {LAYERED_EXPORT_RESOURCES.maxLosslessClipsOnDisk} lossless clips and {LAYERED_EXPORT_RESOURCES.maxLosslessTimelineRepresentations} full-timeline representations. Disk use depends on duration; no disk-space estimate is available.</p>
      <details><summary>Processing bounds</summary><p>Per-pass maxima: {LAYERED_EXPORT_RESOURCES.maxOriginalVideoDecoders} original decoder, {LAYERED_EXPORT_RESOURCES.maxIntermediateVideoDecoders} intermediate readers, {LAYERED_EXPORT_RESOURCES.maxVideoEncoders} encoder, and {LAYERED_EXPORT_RESOURCES.maxNativeVideoChildrenPerPass} video child processes in total. These maxima do not all occur together.</p></details>
    </aside> : <p className="activity-hint">Temporary lossless files may hold up to {EXPORT_RESOURCES.maxLosslessClipsOnDisk} clips. Disk use depends on duration; no disk-space estimate is available.</p>}
    {submitting && <output className="activity-pending" aria-live="polite">Submitting export…</output>}
    {history.length > 0 && <section className="activity-export-history" aria-labelledby={`${id}-history`}><h3 id={`${id}-history`}>Completed exports</h3><ul>{history.map((job) => <li key={job.id}>
      <div><strong>{job.label}</strong>{job.finishedAt && <span className="activity-hint">{Number.isFinite(Date.parse(job.finishedAt)) ? <time dateTime={job.finishedAt}>{new Date(job.finishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time> : 'Completion time unavailable'}</span>}</div>
      <div className="activity-job-actions">{job.outputUrl && <><a href={job.outputUrl} target="_blank" rel="noreferrer" aria-label={`Open export ${job.label}`}>Open</a><a href={job.outputUrl} download aria-label={`Download export ${job.label}`}>Download</a></>}{job.receiptUrl && <a href={job.receiptUrl} target="_blank" rel="noreferrer" aria-label={`Receipt for export ${job.label}`}>Receipt</a>}</div>
    </li>)}</ul></section>}
  </Modal>;
}
