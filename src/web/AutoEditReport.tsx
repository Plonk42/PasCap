import { useId, type RefObject } from 'react';
import type { AutoEditResult } from '../shared/auto-edit/result.js';
import type { MediaJob } from '../shared/media.js';
import { formatTimecode } from '../shared/timing.js';
import {
  alignmentLine,
  autoEditHeadline,
  GRADE_LABELS,
  gradeLine,
  ORDER_LABELS,
  PACE_LABELS,
  TRANSITION_LABELS,
} from './auto-edit.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import './auto-edit.css';

interface Props {
  result: AutoEditResult;
  /** A Try again job this dialog started, as Activity last saw it, or null. */
  job: MediaJob | null;
  busy: boolean;
  error: string;
  /** Why Try again cannot run now, or null. */
  blocked: string | null;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  onTryAgain: () => void;
  onShowClip: (clipId: string) => void;
  onClose: () => void;
}

function choicesLine({ choices }: AutoEditResult['report']): string {
  const variant = choices.variant ? ` · alternative ${choices.variant}` : '';
  return `${PACE_LABELS[choices.pace]} pace · ${ORDER_LABELS[choices.order]} · ${TRANSITION_LABELS[choices.transitions]} · grade ${GRADE_LABELS[choices.grade].toLowerCase()}${variant}`;
}

function Notes({ report }: Readonly<{ report: AutoEditResult['report'] }>) {
  const notes = [...report.notes, ...(report.grade.failed ? [report.grade.failed] : [])];
  if (!notes.length) return null;
  return (
    <ul className="auto-edit-notes">
      {notes.map((note) => (
        <li key={note}>
          <Icon name="warning" size={14} />
          <span>{note}</span>
        </li>
      ))}
    </ul>
  );
}

function range(item: { recording: string; sourceIn: number; sourceOut: number }): string {
  return `${item.recording} frames ${item.sourceIn}–${item.sourceOut - 1}`;
}

/** The report of an auto edit: what it built and why, with Try again for the next-best alternative. */
export function AutoEditReportDialog({
  result,
  job,
  busy,
  error,
  blocked,
  restoreFocusTo,
  onTryAgain,
  onShowClip,
  onClose,
}: Readonly<Props>) {
  const id = useId();
  const { report } = result;
  const running = job?.state === 'queued' || job?.state === 'running';
  const alignment = alignmentLine(report);
  return (
    <Modal
      className="auto-edit-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-summary`}
      busy={busy}
      error={error || (job?.state === 'failed' ? job.message : '')}
      onClose={onClose}
      {...(restoreFocusTo && { restoreFocusTo })}
      footer={
        <>
          {running && (
            <span className="auto-edit-progress">
              <progress max={1} value={job.progress} aria-label="Try again progress" />
              <span>{job.message}</span>
            </span>
          )}
          {!running && blocked && <span className="activity-hint">{blocked}</span>}
          <button
            className="secondary-button"
            disabled={busy || running || blocked !== null}
            title="Replace the cut with the next-best alternative; Undo comes back to this one"
            onClick={onTryAgain}
          >
            <Icon name="wand" size={15} />
            Try again
          </button>
          <button className="primary-button" disabled={busy} onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Auto edit</h2>
      </div>
      <div id={`${id}-summary`} className="auto-edit-summary">
        <p>
          <strong>{autoEditHeadline(report)}</strong>
          {report.targetSeconds !== null && ` · target ${report.targetSeconds} s`}
        </p>
        <p>{choicesLine(report)}</p>
        {alignment && <p>{alignment}</p>}
        <p>{gradeLine(report)}</p>
      </div>
      <Notes report={report} />
      <div className="auto-edit-table">
        <table aria-label="Clips of the auto edit">
          <thead>
            <tr>
              <th scope="col">Clip</th>
              <th scope="col">Recording</th>
              <th scope="col">At</th>
              <th scope="col">Music</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {report.clips.map((clip, index) => (
              <tr key={clip.clipId}>
                <td>
                  <button
                    className="secondary-button small"
                    aria-label={`Show clip ${index + 1}`}
                    title="Close and select this clip on the timeline"
                    onClick={() => onShowClip(clip.clipId)}
                  >
                    {index + 1}
                  </button>
                </td>
                <td title={range(clip)}>{clip.recording}</td>
                <td>{formatTimecode(clip.start)}</td>
                <td>{clip.section ?? '—'}</td>
                <td>{clip.reasons.join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.duplicates.length > 0 && (
        <details className="auto-edit-more">
          <summary>
            Alike takes left out ({report.duplicates.reduce((sum, item) => sum + item.alike.length, 0)})
          </summary>
          <ul>
            {report.duplicates.map((item) => (
              <li key={`${item.chosen.mediaId}:${item.chosen.sourceIn}`}>
                Kept {range(item.chosen)}; left out {item.alike.map(range).join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.leftOutCount > 0 && (
        <details className="auto-edit-more">
          <summary>
            Steady ranges not used ({report.leftOutCount} of {report.leftOutCount + report.clips.length})
          </summary>
          <ul>
            {report.leftOut.map((item) => (
              <li key={`${item.mediaId}:${item.sourceIn}`}>
                {range(item)}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {report.skipped.length > 0 && (
        <details className="auto-edit-more" open>
          <summary>Recordings not used ({report.skipped.length})</summary>
          <ul>
            {report.skipped.map((item) => (
              <li key={item.mediaId}>
                {item.recording}: {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Modal>
  );
}
