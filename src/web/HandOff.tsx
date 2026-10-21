import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { MAX_BRIEF_NOTES, type Brief } from '../shared/assistant-session.js';
import type { MediaJob } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import type { OperationOutput } from '../shared/operations/index.js';
import { forEachSerial } from '../shared/serial.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import { callOperation } from './operations.js';
import './hand-off.css';

type Readiness = OperationOutput<'hand_off_readiness'>;

const POLL_MS = 2000;

interface Props {
  project: ProjectDocument;
  musicName: (mediaId: string) => string;
  busy: boolean;
  error: string;
  /** Why the project cannot be handed off now, or null. */
  blocked: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onJobs: (jobs: MediaJob[]) => void;
  onHandOff: (brief: Brief) => Promise<boolean>;
  onClose: () => void;
}

/** An optional number field's value: null when empty, or the reason it is invalid. */
function optionalNumber(
  text: string,
  minimum: number,
  maximum: number,
  integer = false,
): { value: number | null; error: string } {
  if (text.trim() === '') return { value: null, error: '' };
  const value = Number(text);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value)))
    return { value: null, error: `Enter ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.` };
  return { value, error: '' };
}

function useReadiness(projectId: string): { readiness: Readiness | null; error: string; refresh: () => void } {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void callOperation('hand_off_readiness', { projectId })
      .then((next) => {
        if (cancelled) return;
        setReadiness(next);
        setError('');
        const pending =
          next.recordings.some((item) => item.preparation === 'preparing' || item.cameraMotion === 'analysing') ||
          next.music.some((item) => item.preparation === 'preparing' || item.beats === 'analysing');
        if (pending) timer = setTimeout(() => setTick((value) => value + 1), POLL_MS);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Cannot read what the project is ready for.');
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, tick]);
  return { readiness, error, refresh: useCallback(() => setTick((value) => value + 1), []) };
}

function count(items: number, word: string): string {
  return `${items} ${word}${items === 1 ? '' : 's'}`;
}

type Queue = () => Promise<{ job: MediaJob }[]>;

interface ReadinessLine {
  key: string;
  ready: boolean;
  text: string;
  action: { label: string; run: Queue } | null;
}

function queue(ids: readonly string[], submit: (id: string) => Promise<{ job: MediaJob }>): Queue {
  return async () => {
    const accepted: { job: MediaJob }[] = [];
    await forEachSerial(ids, async (id) => {
      accepted.push(await submit(id));
    });
    return accepted;
  };
}

/** One readiness line: done when no part remains, else the remaining parts joined. */
function line(key: string, done: string, parts: readonly (string | false)[], action: ReadinessLine['action']) {
  const remaining = parts.filter((part): part is string => part !== false);
  return { key, ready: remaining.length === 0, text: remaining.length ? remaining.join(' · ') : done, action };
}

function recordingLines({ recordings }: Readiness): ReadinessLine[] {
  const unprepared = recordings.filter((item) => item.preparation === 'unprepared').map((item) => item.id);
  const preparing = recordings.filter((item) => item.preparation === 'preparing').length;
  const motion = recordings
    .filter((item) => item.preparation === 'ready' && item.cameraMotion === 'missing')
    .map((item) => item.id);
  const analysing = recordings.filter((item) => item.cameraMotion === 'analysing').length;
  const ready = recordings.filter((item) => item.preparation === 'ready').length;
  if (!recordings.length)
    return [{ key: 'recordings', ready: false, text: 'No video recordings in this project yet', action: null }];
  const lines = [
    line(
      'recordings',
      `${count(recordings.length, 'video recording')} prepared`,
      [
        unprepared.length + preparing > 0 && `${ready} of ${count(recordings.length, 'video recording')} prepared`,
        unprepared.length > 0 && `the assistant cannot see the ${unprepared.length} others`,
        preparing > 0 && `${preparing} preparing`,
      ],
      unprepared.length ? { label: `Prepare ${unprepared.length}`, run: queue(unprepared, api.prepare) } : null,
    ),
  ];
  if (ready)
    lines.push(
      line(
        'motion',
        `Camera motion analysed (${count(ready, 'prepared recording')}): the assistant can find steady ranges`,
        [
          motion.length > 0 && `Camera motion not analysed for ${count(motion.length, 'recording')}`,
          analysing > 0 && `${analysing} analysing`,
        ],
        motion.length ? { label: `Analyse ${motion.length}`, run: queue(motion, api.analyseMotion) } : null,
      ),
    );
  return lines;
}

function musicLine({ music }: Readiness): ReadinessLine {
  if (!music.length)
    return {
      key: 'music',
      ready: false,
      text: 'No music in this project: the assistant cuts without a beat',
      action: null,
    };
  const unprepared = music.filter((item) => item.preparation === 'unprepared').map((item) => item.id);
  const beats = music.filter((item) => item.preparation === 'ready' && item.beats === 'missing').map((item) => item.id);
  const pending = music.filter((item) => item.preparation === 'preparing' || item.beats === 'analysing').length;
  let action: ReadinessLine['action'] = null;
  if (unprepared.length) action = { label: `Prepare ${unprepared.length}`, run: queue(unprepared, api.prepareAudio) };
  else if (beats.length) action = { label: `Analyse ${beats.length}`, run: queue(beats, api.analyseMusic) };
  return line(
    'music',
    `Music prepared and its beats analysed (${count(music.length, 'recording')})`,
    [
      unprepared.length > 0 && `${count(unprepared.length, 'music recording')} not prepared`,
      beats.length > 0 && `beats not analysed for ${count(beats.length, 'music recording')}`,
      pending > 0 && `${pending} in progress`,
    ],
    action,
  );
}

function readinessLines(readiness: Readiness): ReadinessLine[] {
  return [...recordingLines(readiness), musicLine(readiness)];
}

/** Starts an assistant session with the user's brief, after showing what the assistant can use. */
export function HandOffDialog({
  project,
  musicName,
  busy,
  error,
  blocked,
  restoreFocusTo,
  onJobs,
  onHandOff,
  onClose,
}: Readonly<Props>) {
  const id = useId();
  const [notes, setNotes] = useState('');
  const [musicTrackId, setMusicTrackId] = useState<string>(project.music.length === 1 ? project.music[0]!.id : '');
  const [target, setTarget] = useState('');
  const [movement, setMovement] = useState('');
  const [maxClips, setMaxClips] = useState('');
  const [pending, setPending] = useState(false);
  const [queueError, setQueueError] = useState('');
  const submission = useRef(false);
  const { readiness, error: readinessError, refresh } = useReadiness(project.id);
  const targetSeconds = optionalNumber(target, 1, 86_400);
  const allowedMovement = optionalNumber(movement, 0.5, 6);
  const clips = optionalNumber(maxClips, 1, 1000, true);
  const invalid = targetSeconds.error !== '' || allowedMovement.error !== '' || clips.error !== '';
  const submitting = busy || pending;

  const queueJobs = async (run: () => Promise<{ job: MediaJob }[]>): Promise<void> => {
    setPending(true);
    setQueueError('');
    try {
      onJobs((await run()).map((accepted) => accepted.job));
    } catch (cause) {
      setQueueError(cause instanceof Error ? cause.message : 'The jobs could not be queued. Check Activity.');
    } finally {
      setPending(false);
      refresh();
    }
  };
  const handOff = async (): Promise<void> => {
    if (submitting || submission.current || invalid || blocked) return;
    submission.current = true;
    setPending(true);
    try {
      const ok = await onHandOff({
        notes: notes.trim(),
        musicTrackId: musicTrackId || null,
        targetSeconds: targetSeconds.value,
        allowedMovement: allowedMovement.value,
        maxClips: clips.value,
      });
      if (ok) onClose();
    } finally {
      submission.current = false;
      setPending(false);
    }
  };
  const field = (
    name: string,
    label: string,
    value: string,
    set: (value: string) => void,
    fieldError: string,
    hint: string,
    step: string,
  ) => (
    <div className="hand-off-field">
      <label htmlFor={`${id}-${name}`}>{label}</label>
      <input
        id={`${id}-${name}`}
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        placeholder={hint}
        disabled={submitting}
        aria-invalid={fieldError !== ''}
        aria-describedby={fieldError ? `${id}-${name}-error` : undefined}
        onChange={(event) => set(event.target.value)}
      />
      {fieldError && (
        <span className="hand-off-error" id={`${id}-${name}-error`} role="alert">
          {fieldError}
        </span>
      )}
    </div>
  );

  return (
    <Modal
      className="hand-off-dialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-intro`}
      busy={submitting}
      error={error || queueError || readinessError}
      onClose={onClose}
      restoreFocusTo={restoreFocusTo}
      footer={
        <>
          {blocked && <span className="activity-hint">{blocked}</span>}
          <button className="secondary-button" disabled={submitting} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={submitting || invalid || blocked !== null}
            onClick={() => {
              void handOff();
            }}
          >
            <Icon name="assistant" size={15} />
            Hand off
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Hand off to an assistant</h2>
      </div>
      <p id={`${id}-intro`} className="hand-off-intro">
        An assistant connected to PasCap edits <strong>{project.title}</strong> while you watch. You can take over at
        any time, and the project as it is now is kept so you can restore it.
      </p>
      <div className="hand-off-field">
        <label htmlFor={`${id}-notes`}>What should it make?</label>
        <textarea
          id={`${id}-notes`}
          rows={4}
          maxLength={MAX_BRIEF_NOTES}
          value={notes}
          placeholder="Style, story, shots to favour or avoid…"
          disabled={submitting}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="hand-off-options">
        <div className="hand-off-field">
          <label htmlFor={`${id}-music`}>Music track</label>
          <select
            id={`${id}-music`}
            value={musicTrackId}
            disabled={submitting || !project.music.length}
            onChange={(event) => setMusicTrackId(event.target.value)}
          >
            <option value="">{project.music.length ? 'Any' : 'No music track'}</option>
            {project.music.map((track, index) => (
              <option key={track.id} value={track.id}>
                {`Music track ${index + 1} · ${[...new Set(track.clips.map((clip) => musicName(clip.mediaId)))].join(', ')}`}
              </option>
            ))}
          </select>
        </div>
        {field('target', 'Target length (s)', target, setTarget, targetSeconds.error, 'Music', 'any')}
        {field('movement', 'Allowed movement', movement, setMovement, allowedMovement.error, '2', '0.1')}
        {field('clips', 'Most clips', maxClips, setMaxClips, clips.error, 'Any', '1')}
      </div>
      <section className="hand-off-readiness" aria-labelledby={`${id}-ready`}>
        <h3 id={`${id}-ready`}>What the assistant can use</h3>
        {readiness === null ? (
          <output className="activity-hint">
            <span className="spinner" aria-hidden="true" />
            <span>Checking recordings and music…</span>
          </output>
        ) : (
          <ul>
            {readinessLines(readiness).map(({ key, ready, text, action }) => (
              <li key={key} className={ready ? 'ready' : 'missing'}>
                <Icon name={ready ? 'check' : 'warning'} size={15} />
                <span>{text}</span>
                {action && (
                  <button
                    className="secondary-button small"
                    disabled={submitting}
                    onClick={() => {
                      void queueJobs(action.run);
                    }}
                  >
                    {action.label}
                  </button>
                )}
              </li>
            ))}
            {readiness.exportRunning && (
              <li className="missing">
                <Icon name="warning" size={15} />
                <span>An export is running: the assistant cannot look at pictures until it finishes</span>
              </li>
            )}
          </ul>
        )}
      </section>
    </Modal>
  );
}
