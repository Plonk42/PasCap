import { useId, useRef, useState, type RefObject } from 'react';
import {
  defaultExportName,
  EXPORT_PROFILES,
  EXPORT_RESOURCES,
  exportOutputNameSchema,
  LAYERED_EXPORT_RESOURCES,
  needsLayeredExport,
  type ExportProfile,
} from '../shared/export.js';
import { keySettings } from '../shared/keyframes.js';
import type { MediaJob } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';
import { framesToSeconds } from '../shared/timing.js';
import { durationLabel } from './display.js';
import { ExportSpace, useExportSpace } from './ExportSpace.js';
import { Icon } from './icons.js';
import { orderActivityJobs } from './Jobs.js';
import { Modal } from './Modal.js';

export interface ExportDialogProps {
  project: ProjectDocument;
  jobs: readonly MediaJob[];
  busy: boolean;
  error: string;
  onExport: (profile: ExportProfile, outputName: string) => Promise<boolean>;
  onClose: () => void;
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function summarizeExport(project: ProjectDocument) {
  const keys = { points: 0, settings: 0, speed: 0, colour: 0, opacity: 0 };
  for (const layer of project.layers) {
    keys.points += layer.keyframes.length;
    for (const point of layer.keyframes) {
      for (const setting of keySettings(point)) {
        keys.settings++;
        if (setting === 'speed') keys.speed++;
        else if (setting === 'opacity') keys.opacity++;
        else keys.colour++;
      }
    }
  }
  const layout = calculateLayout(project);
  const videoDuration = layout.clips.reduce((duration, clip) => Math.max(duration, clip.end), 0);
  return {
    duration: layout.duration,
    musicTail: layout.duration - videoDuration,
    clips: project.clips.length,
    layers: project.layers.length,
    enabledLayers: project.layers.filter((layer) => layer.enabled).length,
    musicTracks: project.music.length,
    keys,
    keyframeCount: keys.points,
    layered: needsLayeredExport(project),
  };
}

export function ExportDialog({
  project,
  jobs,
  busy,
  error,
  onExport,
  onClose,
  restoreFocusTo,
}: Readonly<ExportDialogProps>) {
  const id = useId();
  const [profile, setProfile] = useState<ExportProfile>('draft720');
  // Null follows the default (title + quality) until the user types a name.
  const [customName, setCustomName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submission = useRef(false);
  const [localError, setLocalError] = useState('');
  const submitting = busy || pending;
  const summary = summarizeExport(project);
  const space = useExportSpace(project, profile);
  const storageReady = space.phase === 'ready' && space.data !== null && space.data.status !== 'blocked';
  const settings = EXPORT_PROFILES[profile];
  const nameDraft = customName ?? defaultExportName(project.title, profile);
  const name = exportOutputNameSchema.safeParse(nameDraft);
  const nameError = name.success ? '' : (name.error.issues[0]?.message ?? 'Enter a valid output name.');
  const ready = storageReady && name.success && summary.duration > 0 && summary.clips > 0;
  const history = orderActivityJobs(jobs).filter((job) => job.kind === 'export' && job.state === 'completed');

  const startExport = async (): Promise<void> => {
    if (busy || submission.current || !ready || !name.success) return;
    submission.current = true;
    setPending(true);
    setLocalError('');
    try {
      if (await onExport(profile, name.data)) onClose();
      else setLocalError('The export could not be submitted. Check the error and try again.');
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'The export could not be submitted.');
    } finally {
      submission.current = false;
      setPending(false);
    }
  };

  return (
    <Modal
      className="export-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-snapshot`}
      busy={submitting}
      error={error || localError}
      onClose={onClose}
      {...(restoreFocusTo ? { restoreFocusTo } : {})}
      footer={
        <>
          <button className="secondary-button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={submitting || !ready}
            onClick={() => {
              void startExport();
            }}
          >
            <Icon name="download" size={15} />
            Start export
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Export video</h2>
      </div>
      <p className="activity-export-project">{project.title}</p>
      <dl className="activity-export-summary">
        <div>
          <dt>Duration</dt>
          <dd>
            {durationLabel(framesToSeconds(summary.duration))}
            {summary.musicTail > 0 && (
              <small>{durationLabel(framesToSeconds(summary.musicTail))} music-only black tail</small>
            )}
          </dd>
        </div>
      </dl>
      {!summary.clips && <p className="activity-empty">Add a video clip to the project before exporting.</p>}
      <fieldset className="export-quality-field" disabled={submitting}>
        <legend>Quality</legend>
        <div className="export-quality-options">
          <label className="export-quality-option">
            <input
              type="radio"
              name={`${id}-quality`}
              aria-label="720p draft"
              checked={profile === 'draft720'}
              onChange={() => setProfile('draft720')}
            />
            <strong>720p draft</strong>
            <span>For review</span>
            <small>1280 × 720</small>
          </label>
          <label className="export-quality-option">
            <input
              type="radio"
              name={`${id}-quality`}
              aria-label="4K final"
              checked={profile === 'final4k'}
              onChange={() => setProfile('final4k')}
            />
            <strong>4K final</strong>
            <span>Full-resolution delivery</span>
            <small>3840 × 2160</small>
          </label>
        </div>
      </fieldset>
      <p className="export-originals-note">
        <Icon name="video" size={15} />
        Renders from originals · H.264 · SDR BT.709
      </p>
      <div className="export-name-field">
        <label htmlFor={`${id}-name`}>Output name</label>
        <div className="export-name-input">
          <input
            id={`${id}-name`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={nameDraft}
            disabled={submitting}
            aria-invalid={nameError !== ''}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            onChange={(event) => setCustomName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void startExport();
            }}
          />
          <span aria-hidden="true">.mp4</span>
        </div>
        {nameError && (
          <span className="export-name-error" id={`${id}-name-error`} role="alert">
            {nameError}
          </span>
        )}
      </div>
      <ExportSpace state={space} />
      <details className="export-render-details">
        <summary>Rendering details</summary>
        <section className="activity-export-snapshot" id={`${id}-snapshot`}>
          <h3>Fixed snapshot</h3>
          <dl className="activity-export-counts">
            <div>
              <dt>Clips</dt>
              <dd>{summary.clips}</dd>
            </div>
            <div>
              <dt>Video tracks</dt>
              <dd>
                {summary.layers} <small>({summary.enabledLayers} enabled)</small>
              </dd>
            </div>
            <div>
              <dt>Track keyframes</dt>
              <dd>
                {summary.keyframeCount} <small>({summary.keys.settings} animated settings)</small>
              </dd>
            </div>
            <div>
              <dt>Music tracks</dt>
              <dd>{summary.musicTracks}</dd>
            </div>
          </dl>
          <p>
            The submitted edit includes clip speed and transforms, each video track’s Colour, Ripple, transitions and
            fades, enabled video tracks, bottom-to-top composition order, track Opacity and keyframes
            {summary.musicTracks ? `, and all ${summary.musicTracks} music tracks` : '; no music tracks are placed'}.
            Later edits do not change a submitted render.
          </p>
          {summary.musicTracks > 0 && (
            <p>
              Music tracks retain independent ranges, placement, gain, fades and looping. Overlaps sum linearly, then
              the final mix is hard-clamped to −1…1, without normalization or ducking. Export reaches the last video or
              music OUT. Video closing fades stay on their last clips; any remaining music continues over black.
            </p>
          )}
          <p>After submission, rendering continues in Activity and the editor remains available.</p>
        </section>
        <p className="activity-hint">
          {settings.width} × {settings.height} · {summary.keys.speed} speed values · {summary.keys.colour} colour values
          · {summary.keys.opacity} opacity values.
        </p>
        {summary.layered ? (
          <aside className="activity-export-warning" aria-labelledby={`${id}-resources`}>
            <h3 id={`${id}-resources`}>Layered export resources</h3>
            <p>Sequential compositing can be slow, especially at 4K; no completion-time estimate is available.</p>
            <p>
              Up to {LAYERED_EXPORT_RESOURCES.maxLosslessClipsOnDisk} lossless clips and{' '}
              {LAYERED_EXPORT_RESOURCES.maxLosslessTimelineRepresentations} full-timeline representations. Disk use
              depends on duration and compression.
            </p>
            <p>
              {LAYERED_EXPORT_RESOURCES.rawFrameBuffers} reusable raw buffers use{' '}
              {((settings.width * settings.height * LAYERED_EXPORT_RESOURCES.rawBytesPerPixel) / 1_000_000).toFixed(1)}{' '}
              MB at {settings.width} × {settings.height}; up to {LAYERED_EXPORT_RESOURCES.maxInMemoryLuts} LUTs add{' '}
              {((LAYERED_EXPORT_RESOURCES.maxInMemoryLuts * LAYERED_EXPORT_RESOURCES.lutBytes) / 1_000_000).toFixed(1)}{' '}
              MB. Native codec/pipe/filter memory and selected audio are additional.
            </p>
            <p>
              Per-pass maxima: {LAYERED_EXPORT_RESOURCES.maxOriginalVideoDecoders} original decoder,{' '}
              {LAYERED_EXPORT_RESOURCES.maxIntermediateVideoDecoders} intermediate readers,{' '}
              {LAYERED_EXPORT_RESOURCES.maxVideoEncoders} encoder, and{' '}
              {LAYERED_EXPORT_RESOURCES.maxNativeVideoChildrenPerPass} video child processes in total. These maxima do
              not all occur together.
            </p>
          </aside>
        ) : (
          <p className="activity-hint">
            Up to {EXPORT_RESOURCES.maxLosslessClipsOnDisk} temporary lossless clips. Disk use depends on duration and
            compression.
          </p>
        )}
      </details>
      {submitting && (
        <output className="activity-pending" aria-live="polite">
          Submitting export…
        </output>
      )}
      {history.length > 0 && (
        <section className="activity-export-history" aria-labelledby={`${id}-history`}>
          <h3 id={`${id}-history`}>Completed exports</h3>
          <ul>
            {history.map((job) => (
              <li key={job.id}>
                <div>
                  <strong>{job.label}</strong>
                  {job.finishedAt && (
                    <span className="activity-hint">
                      {Number.isFinite(Date.parse(job.finishedAt)) ? (
                        <time dateTime={job.finishedAt}>
                          {new Date(job.finishedAt).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </time>
                      ) : (
                        'Completion time unavailable'
                      )}
                    </span>
                  )}
                </div>
                <div className="activity-job-actions">
                  {job.outputUrl && (
                    <>
                      <a href={job.outputUrl} target="_blank" rel="noreferrer" aria-label={`Open export ${job.label}`}>
                        Open
                      </a>
                      <a href={job.outputUrl} download aria-label={`Download export ${job.label}`}>
                        Download
                      </a>
                    </>
                  )}
                  {job.receiptUrl && (
                    <a
                      href={job.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Receipt for export ${job.label}`}
                    >
                      Receipt
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
