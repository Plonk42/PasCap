import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import { MAX_BRIEF_NOTES, type Brief } from '../shared/assistant-session.js';
import {
  AUTO_EDIT_GRADES,
  AUTO_EDIT_ORDERS,
  AUTO_EDIT_PACES,
  AUTO_EDIT_TRANSITIONS,
  DEFAULT_AUTO_EDIT_CHOICES,
  type AutoEditChoices,
} from '../shared/auto-edit/options.js';
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
import { GRADE_LABELS, ORDER_LABELS, PACE_LABELS, TRANSITION_LABELS } from './auto-edit.js';
import { Icon } from './icons.js';
import { Modal } from './Modal.js';
import { callOperation } from './operations.js';
import { steadyLimitsText, useSteadyLimits } from './SmoothRange.js';
import { useStyles } from './styles.js';
import './hand-off.css';

type Readiness = OperationOutput<'hand_off_readiness'>;

const POLL_MS = 2000;
/** While nothing is preparing, the dialog still notices an MCP client connecting. */
const IDLE_POLL_MS = 5000;
/** A music choice naming a recording of the bin rather than a music track. */
const RECORDING = 'recording:';

interface Props {
  project: ProjectDocument;
  musicName: (mediaId: string) => string;
  busy: boolean;
  error: string;
  /** Why the project cannot be handed off now, or null. */
  blocked: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  /** The auto edit this dialog started, as Activity last saw it, or null. */
  autoEditJob: MediaJob | null;
  onJobs: (jobs: MediaJob[]) => void;
  onHandOff: (brief: Brief) => Promise<boolean>;
  onAutoEdit: (brief: Brief, choices: AutoEditChoices) => Promise<boolean>;
  onOpenAutoEdit: (jobId: string) => void;
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
        unprepared.length > 0 && `the ${unprepared.length} others are left out`,
        preparing > 0 && `${preparing} preparing`,
      ],
      unprepared.length ? { label: `Prepare ${unprepared.length}`, run: queue(unprepared, api.prepare) } : null,
    ),
  ];
  if (ready)
    lines.push(
      line(
        'motion',
        `Camera motion analyzed (${count(ready, 'prepared recording')}): steady ranges can be found`,
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
      text: 'No music in this project: the cut has no beat to follow',
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

/** The music choice: a music track by ID, or a recording of the bin that no track plays. */
function musicChoices(project: ProjectDocument, musicName: (mediaId: string) => string) {
  const playing = new Set(project.music.flatMap((lane) => lane.clips.map((clip) => clip.mediaId)));
  return [
    ...project.music.map((track, index) => ({
      value: track.id,
      label: `Music track ${index + 1} · ${[...new Set(track.clips.map((clip) => musicName(clip.mediaId)))].join(', ')}`,
    })),
    ...project.media.audioIds
      .filter((id) => !playing.has(id))
      .map((id) => ({ value: `${RECORDING}${id}`, label: `${musicName(id)} · placed from its start` })),
  ];
}

function initialMusic(project: ProjectDocument, choices: readonly { value: string }[]): string {
  if (project.music.length === 1) return project.music[0]!.id;
  return project.music.length === 0 && choices[0] ? choices[0].value : '';
}

function briefMusic(choice: string): Pick<Brief, 'musicTrackId' | 'musicId'> {
  if (choice.startsWith(RECORDING)) return { musicTrackId: null, musicId: choice.slice(RECORDING.length) };
  return { musicTrackId: choice || null, musicId: null };
}

function ChoiceSelect<K extends string>({
  id,
  label,
  value,
  values,
  labels,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: K;
  values: readonly K[];
  labels: Readonly<Record<K, string>>;
  disabled: boolean;
  onChange: (value: K) => void;
}>) {
  return (
    <div className="hand-off-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as K)}>
        {values.map((item) => (
          <option key={item} value={item}>
            {labels[item]}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Where the auto edit this dialog started stands, and how to open it once done. */
function AutoEditStatus({ job, onOpen }: Readonly<{ job: MediaJob; onOpen: () => void }>) {
  if (job.state === 'queued' || job.state === 'running')
    return (
      <div className="hand-off-auto-status">
        <progress max={1} value={job.progress} aria-label="Auto edit progress" />
        <span>{job.message}</span>
      </div>
    );
  if (job.state === 'completed')
    return (
      <div className="hand-off-auto-status done">
        <Icon name="check" size={15} />
        <span>{job.message}</span>
        <button className="primary-button small" onClick={onOpen}>
          Open the auto edit
        </button>
      </div>
    );
  return (
    <p className="hand-off-error" role="alert">
      {job.state === 'canceled' ? 'The auto edit was canceled.' : job.message}
    </p>
  );
}

/** Auto edit's choices beside the brief, its button and its job. */
function AutoEditSection({
  title,
  choices,
  disabled,
  job,
  onChoices,
  onStart,
  onOpen,
}: Readonly<{
  title: string;
  choices: AutoEditChoices;
  disabled: boolean;
  job: MediaJob | null;
  onChoices: (choices: AutoEditChoices) => void;
  onStart: () => void;
  onOpen: (jobId: string) => void;
}>) {
  const id = useId();
  const running = job?.state === 'queued' || job?.state === 'running';
  const set =
    <K extends keyof AutoEditChoices>(key: K) =>
    (value: AutoEditChoices[K]) =>
      onChoices({ ...choices, [key]: value });
  const select = { disabled: disabled || running };
  return (
    <section className="hand-off-auto" aria-labelledby={`${id}-title`}>
      <div className="hand-off-auto-heading">
        <h3 id={`${id}-title`}>Auto edit</h3>
        <button
          className="secondary-button small"
          disabled={disabled || running}
          title="Build a first cut in a copy of this project"
          onClick={onStart}
        >
          <Icon name="wand" size={14} />
          Auto edit
        </button>
      </div>
      <p className="hand-off-hint">
        Builds a first cut in a copy, <strong>{title} · Auto edit</strong>: steady shots of your kept ranges, cut on the
        music and graded, in a minute or two. This project stays as it is.
      </p>
      <div className="hand-off-auto-options">
        <ChoiceSelect
          id={`${id}-pace`}
          label="Pace"
          value={choices.pace}
          values={AUTO_EDIT_PACES}
          labels={PACE_LABELS}
          onChange={set('pace')}
          {...select}
        />
        <ChoiceSelect
          id={`${id}-order`}
          label="Order"
          value={choices.order}
          values={AUTO_EDIT_ORDERS}
          labels={ORDER_LABELS}
          onChange={set('order')}
          {...select}
        />
        <ChoiceSelect
          id={`${id}-transitions`}
          label="Transitions"
          value={choices.transitions}
          values={AUTO_EDIT_TRANSITIONS}
          labels={TRANSITION_LABELS}
          onChange={set('transitions')}
          {...select}
        />
        <ChoiceSelect
          id={`${id}-grade`}
          label="Grade"
          value={choices.grade}
          values={AUTO_EDIT_GRADES}
          labels={GRADE_LABELS}
          onChange={set('grade')}
          {...select}
        />
      </div>
      {job && <AutoEditStatus job={job} onOpen={() => onOpen(job.id)} />}
    </section>
  );
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
        <p>
          Clients keep the tools they loaded: after updating PasCap, restart its server in your client (in VS Code,{' '}
          <strong>MCP: List Servers</strong> → pascap → <strong>Restart Server</strong>).
        </p>
      </details>
    </section>
  );
}

/**
 * Starts an auto edit in a copy, or an assistant session, with the user's brief, after showing what both can use.
 */
export function HandOffDialog({
  project,
  musicName,
  busy,
  error,
  blocked,
  restoreFocusTo,
  autoEditJob,
  onJobs,
  onHandOff,
  onAutoEdit,
  onOpenAutoEdit,
  onClose,
}: Readonly<Props>) {
  const id = useId();
  const [notes, setNotes] = useState('');
  const music = musicChoices(project, musicName);
  const [musicChoice, setMusicChoice] = useState<string>(() => initialMusic(project, music));
  const [target, setTarget] = useState('');
  const [useLimits, setUseLimits] = useState(true);
  const [limits] = useSteadyLimits();
  const [maxClips, setMaxClips] = useState('');
  const styles = useStyles();
  const [styleId, setStyleId] = useState('');
  const [choices, setChoices] = useState<AutoEditChoices>({ ...DEFAULT_AUTO_EDIT_CHOICES });
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
  const brief = (): Brief => ({
    notes: notes.trim(),
    ...briefMusic(musicChoice),
    targetSeconds: targetSeconds.value,
    ...briefLimits(useLimits ? limits : null),
    maxClips: clips.value,
    style: styles.some((style) => style.id === styleId) ? styleId : null,
  });
  const submit = async (action: () => Promise<boolean>, closes: boolean): Promise<void> => {
    if (submitting || submission.current || invalid || blocked) return;
    submission.current = true;
    setPending(true);
    try {
      const ok = await action();
      if (ok && closes) onClose();
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
              void submit(() => onHandOff(brief()), true);
            }}
          >
            <Icon name="assistant" size={15} />
            Hand off
          </button>
        </>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={`${id}-title`}>Hand off</h2>
      </div>
      <p id={`${id}-intro`} className="hand-off-intro">
        Let PasCap build a first cut of <strong>{project.title}</strong> with Auto edit, or hand it to an assistant
        connected to PasCap, which edits it while you watch: you can take over at any time, and the project as it is now
        is kept so you can restore it.
      </p>
      <div className="hand-off-field">
        <label htmlFor={`${id}-notes`}>What should it make?</label>
        <textarea
          id={`${id}-notes`}
          rows={3}
          maxLength={MAX_BRIEF_NOTES}
          value={notes}
          placeholder="Style, story, shots to favor or avoid… (for the assistant)"
          disabled={submitting}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="hand-off-options">
        <div className="hand-off-field">
          <label htmlFor={`${id}-music`}>Music</label>
          <select
            id={`${id}-music`}
            value={musicChoice}
            disabled={submitting || !music.length}
            onChange={(event) => setMusicChoice(event.target.value)}
          >
            <option value="">{music.length ? 'Any music track' : 'No music'}</option>
            {music.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {field('target', 'Target length (s)', target, setTarget, targetSeconds.error, 'Music', 'any')}
        {field('clips', 'Most clips', maxClips, setMaxClips, clips.error, 'Any', '1')}
        {styles.length > 0 && (
          <div className="hand-off-field">
            <label htmlFor={`${id}-style`}>Look</label>
            <select
              id={`${id}-style`}
              value={styleId}
              disabled={submitting}
              onChange={(event) => setStyleId(event.target.value)}
            >
              <option value="">Generic</option>
              {styles.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
                </option>
              ))}
            </select>
          </div>
        )}
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
      <AutoEditSection
        title={project.title}
        choices={choices}
        disabled={submitting || invalid || blocked !== null}
        job={autoEditJob}
        onChoices={setChoices}
        onStart={() => {
          void submit(() => onAutoEdit(brief(), choices), false);
        }}
        onOpen={onOpenAutoEdit}
      />
      <section className="hand-off-readiness" aria-labelledby={`${id}-ready`}>
        <h3 id={`${id}-ready`}>What PasCap can use</h3>
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
                <span>An export is running: auto edit and the assistant&apos;s pictures wait until it finishes</span>
              </li>
            )}
          </ul>
        )}
      </section>
      {readiness && <Connection connection={readiness.connection} />}
    </Modal>
  );
}
