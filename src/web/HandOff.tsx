import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { MAX_BRIEF_NOTES, type Brief } from '../shared/assistant-session.js';
import type { MediaJob } from '../shared/media.js';
import type { ProjectDocument } from '../shared/model.js';
import {
  steadyLimitFields,
  steadyLimits,
  type SteadyLimitFields,
  type SteadyLimits,
} from '../shared/motion-analysis.js';
import type { OperationOutput } from '../shared/operations/index.js';
import { forEachSerial } from '../shared/serial.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import { callOperation } from './operations.js';
import { steadyLimitsText, useSteadyLimits } from './SmoothRange.js';
import './hand-off.css';

type Readiness = OperationOutput<'hand_off_readiness'>;

const POLL_MS = 2000;
/** While nothing is preparing, the dialog still notices an MCP client connecting. */
const IDLE_POLL_MS = 5000;

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

/** The limits as brief fields: those left at their default stay null, so the assistant's defaults apply. */
function briefLimits(limits: SteadyLimits | null): Record<keyof SteadyLimitFields, number | null> {
  const fields = steadyLimitFields(limits ?? steadyLimits());
  const initial = steadyLimitFields(steadyLimits());
  const keys = Object.keys(fields) as (keyof SteadyLimitFields)[];
  return Object.fromEntries(
    keys.map((key) => [key, limits === null || fields[key] === initial[key] ? null : fields[key]]),
  ) as Record<keyof SteadyLimitFields, number | null>;
}

function useReadiness(projectId: string): { readiness: Readiness | null; error: string; refresh: () => void } {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void callOperation('hand_off_readiness', { projectId })
      .then((next) => {
        if (canceled) return;
        setReadiness(next);
        setError('');
        const pending =
          next.recordings.some((item) => item.preparation === 'preparing' || item.cameraMotion === 'analyzing') ||
          next.music.some((item) => item.preparation === 'preparing' || item.beats === 'analyzing');
        timer = setTimeout(() => setTick((value) => value + 1), pending ? POLL_MS : IDLE_POLL_MS);
      })
      .catch((cause: unknown) => {
        if (!canceled) setError(cause instanceof Error ? cause.message : 'Cannot read what the project is ready for.');
      });
    return () => {
      canceled = true;
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
  const analyzing = recordings.filter((item) => item.cameraMotion === 'analyzing').length;
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
        `Camera motion analyzed (${count(ready, 'prepared recording')}): the assistant can find steady ranges`,
        [
          motion.length > 0 && `Camera motion not analyzed for ${count(motion.length, 'recording')}`,
          analyzing > 0 && `${analyzing} analyzing`,
        ],
        motion.length ? { label: `Analyze ${motion.length}`, run: queue(motion, api.analyzeMotion) } : null,
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
  const pending = music.filter((item) => item.preparation === 'preparing' || item.beats === 'analyzing').length;
  let action: ReadinessLine['action'] = null;
  if (unprepared.length) action = { label: `Prepare ${unprepared.length}`, run: queue(unprepared, api.prepareAudio) };
  else if (beats.length) action = { label: `Analyze ${beats.length}`, run: queue(beats, api.analyzeMusic) };
  return line(
    'music',
    `Music prepared and its beats analyzed (${count(music.length, 'recording')})`,
    [
      unprepared.length > 0 && `${count(unprepared.length, 'music recording')} not prepared`,
      beats.length > 0 && `beats not analyzed for ${count(beats.length, 'music recording')}`,
      pending > 0 && `${pending} in progress`,
    ],
    action,
  );
}

function readinessLines(readiness: Readiness): ReadinessLine[] {
  return [...recordingLines(readiness), musicLine(readiness)];
}

function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The VS Code `mcp.json` entry for this service, asking for the token rather than storing it. */
function vsCodeConfiguration(url: string): string {
  const configuration = {
    inputs: [
      {
        id: 'pascap-token',
        type: 'promptString',
        description: 'Contents of the PasCap MCP token file',
        password: true,
      },
    ],
    servers: {
      pascap: { type: 'http', url, headers: { Authorization: 'Bearer ${input:pascap-token}' } },
    },
  };
  return JSON.stringify(configuration, null, 2);
}

/** Whether an MCP client has called PasCap, and how to connect one. */
function Connection({ connection }: Readonly<{ connection: Readiness['connection'] }>) {
  const id = useId();
  const [copied, setCopied] = useState('');
  const configuration = vsCodeConfiguration(connection.url);
  const caller = connection.client ?? 'An MCP client';
  const copy = (): void => {
    navigator.clipboard.writeText(configuration).then(
      () => setCopied('Copied'),
      () => setCopied('Select the text and copy it'),
    );
  };
  return (
    <section className="hand-off-readiness hand-off-connection" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Assistant connection</h3>
      <ul>
        <li className={connection.lastCall ? 'ready' : 'idle'}>
          <Icon name={connection.lastCall ? 'check' : 'link'} size={15} />
          <span>
            {connection.lastCall
              ? `${caller} called PasCap ${ago(connection.lastCall, Date.now())}`
              : 'No assistant has called PasCap since it started'}
          </span>
        </li>
      </ul>
      <details>
        <summary>How to connect</summary>
        <p>
          Point an MCP client at <code>{connection.url}</code>, sending the token in <code>{connection.tokenFile}</code>{' '}
          as <code>Authorization: Bearer</code>. In VS Code, add this to <code>.vscode/mcp.json</code>; it asks for the
          token when it starts.
        </p>
        <pre aria-label="VS Code MCP configuration">{configuration}</pre>
        <div className="hand-off-copy">
          <button className="secondary-button small" onClick={copy}>
            Copy configuration
          </button>
          <output>{copied}</output>
        </div>
      </details>
    </section>
  );
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
  const [useLimits, setUseLimits] = useState(true);
  const [limits] = useSteadyLimits();
  const [maxClips, setMaxClips] = useState('');
  const [pending, setPending] = useState(false);
  const [queueError, setQueueError] = useState('');
  const submission = useRef(false);
  const { readiness, error: readinessError, refresh } = useReadiness(project.id);
  const targetSeconds = optionalNumber(target, 1, 86_400);
  const clips = optionalNumber(maxClips, 1, 1000, true);
  const invalid = targetSeconds.error !== '' || clips.error !== '';
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
        ...briefLimits(useLimits ? limits : null),
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
          placeholder="Style, story, shots to favor or avoid…"
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
        {field('clips', 'Most clips', maxClips, setMaxClips, clips.error, 'Any', '1')}
        <div className="hand-off-check">
          <input
            id={`${id}-limits`}
            type="checkbox"
            checked={useLimits}
            disabled={submitting}
            aria-describedby={`${id}-limits-text`}
            onChange={(event) => setUseLimits(event.target.checked)}
          />
          <label htmlFor={`${id}-limits`}>Steady ranges as in Source preview</label>
          <small id={`${id}-limits-text`}>{steadyLimitsText(useLimits ? limits : steadyLimits())}</small>
        </div>
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
      {readiness && <Connection connection={readiness.connection} />}
    </Modal>
  );
}
