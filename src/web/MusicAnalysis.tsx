import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { EditCommand } from '../shared/commands.js';
import type { MediaJob } from '../shared/media.js';
import type { MusicTrack } from '../shared/model.js';
import { beatBookmarks, type BeatChoice, type MusicAnalysis } from '../shared/music-analysis.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { Popover } from './Popover.js';

const POLL_MS = 1000;

export type MusicAnalysisPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'running'; queued: boolean; progress: number }
  | { kind: 'ready'; analysis: MusicAnalysis }
  | { kind: 'error'; message: string };

interface Entry {
  phase: MusicAnalysisPhase;
  listeners: Set<() => void>;
  /** Set once a read or job has started for the current preparation, until the music is prepared again. */
  started: boolean;
}

/** One entry per prepared music recording, shared by its lanes and the Audio tab: one read, one poll. */
const entries = new Map<string, Entry>();
const IDLE: MusicAnalysisPhase = { kind: 'idle' };

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { phase: IDLE, listeners: new Set(), started: false };
    entries.set(key, entry);
  }
  return entry;
}

function publish(key: string, phase: MusicAnalysisPhase): void {
  const entry = entryFor(key);
  entry.phase = phase;
  for (const listener of entry.listeners) listener();
}

function failed(key: string, cause: unknown): void {
  publish(key, { kind: 'error', message: cause instanceof Error ? cause.message : 'Cannot analyse this music.' });
}

/** Shows a music analysis job's progress, then its result. */
async function follow(key: string, id: string, job: MediaJob): Promise<void> {
  const poll = async (current: MediaJob): Promise<MediaJob> => {
    if (current.state !== 'queued' && current.state !== 'running') return current;
    publish(key, { kind: 'running', queued: current.state === 'queued', progress: current.progress });
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const next = (await api.jobs()).jobs.find((candidate) => candidate.id === current.id);
    if (!next) throw new Error('The music analysis is no longer listed. Try again.');
    return poll(next);
  };
  const done = await poll(job);
  if (done.state === 'cancelled') return publish(key, IDLE);
  if (done.state === 'failed') throw new Error(done.message);
  const { analysis } = await api.musicAnalysis(id);
  if (!analysis) throw new Error('The analysis finished but its result is missing. Try again.');
  publish(key, { kind: 'ready', analysis });
}

function load(key: string, id: string): void {
  const entry = entryFor(key);
  if (entry.started) return;
  entry.started = true;
  publish(key, { kind: 'checking' });
  api
    .musicAnalysis(id)
    .then(({ analysis, job }) => {
      if (analysis) return publish(key, { kind: 'ready', analysis });
      // Preparation queues the analysis once the music is ready.
      if (job) return follow(key, id, job);
      publish(key, IDLE);
    })
    .catch((cause: unknown) => failed(key, cause));
}

/** The tempo, beats and sections of a prepared music recording, following its background analysis. */
export function useMusicAnalysis(asset: AudioAsset | undefined): {
  phase: MusicAnalysisPhase;
  analyse: () => void;
} {
  const ready = asset?.status === 'ready';
  const id = asset?.id ?? '';
  const key = `${id}/${asset?.content?.digest ?? ''}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(key);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [key],
  );
  const phase = useSyncExternalStore(subscribe, () => (ready ? entryFor(key).phase : IDLE));
  useEffect(() => {
    if (!id) return;
    if (ready) load(key, id);
    // Preparing again may replace the cache: read its analysis afresh once it is ready.
    else entryFor(key).started = false;
  }, [key, id, ready]);
  const analyse = useCallback(() => {
    if (!id) return;
    entryFor(key).started = true;
    api
      .analyseMusic(id)
      .then(({ job }) => follow(key, id, job))
      .catch((cause: unknown) => failed(key, cause));
  }, [id, key]);
  return { phase, analyse };
}

function summary(analysis: MusicAnalysis): string {
  if (!analysis.tempo) return 'No steady beat found';
  const meter = analysis.meter ? ` · ${analysis.meter.beatsPerBar}/4` : '';
  return `${Math.round(analysis.tempo.bpm)} BPM${meter} · ${analysis.beats.length} beats`;
}

function statusText(phase: MusicAnalysisPhase): string {
  if (phase.kind === 'ready') return summary(phase.analysis);
  if (phase.kind === 'checking') return 'Reading the music analysis…';
  if (phase.kind === 'running')
    return phase.queued ? 'Music analysis queued…' : `Analysing music ${Math.round(phase.progress * 100)}%`;
  if (phase.kind === 'error') return phase.message;
  return 'Tempo and beats not analysed';
}

/** Why Beats → bookmarks cannot open, or '' when it can. */
function unavailableReason(phase: MusicAnalysisPhase, disabled: boolean): string {
  if (phase.kind === 'checking' || phase.kind === 'running') return 'Wait for the music analysis to finish.';
  if (phase.kind !== 'ready') return 'Analyse the music first to find its beats.';
  if (!phase.analysis.tempo) return 'No steady beat was found in this music.';
  return disabled ? 'Finish the current edit first.' : '';
}

interface StatusProps {
  asset: AudioAsset | undefined;
  music: MusicTrack;
  bookmarks: readonly number[];
  disabled: boolean;
  onEdit: (commands: readonly EditCommand[]) => void;
}

/** Under Recording: the analysis summary, its progress or Analyse music, then Beats → bookmarks. */
export function MusicAnalysisStatus({ asset, music, bookmarks, disabled, onEdit }: Readonly<StatusProps>) {
  const id = useId();
  const { phase, analyse } = useMusicAnalysis(asset);
  if (asset?.status !== 'ready') return null;
  const text = statusText(phase);
  const reason = unavailableReason(phase, disabled);
  const trigger = (
    <>
      <Icon name="bookmark" size={14} />
      Beats → bookmarks
    </>
  );
  return (
    <div className="music-analysis">
      <div className={`music-analysis-status ${phase.kind}`} role="status" aria-live="polite">
        <Icon name="music" size={14} />
        <span title={text}>{text}</span>
        {(phase.kind === 'idle' || phase.kind === 'error') && (
          <button
            type="button"
            className="text-button"
            title="Find the tempo, beats and sections of this music in the background"
            onClick={analyse}
          >
            Analyse music
          </button>
        )}
      </div>
      {reason || phase.kind !== 'ready' ? (
        <>
          <button
            type="button"
            className="secondary-button small music-beat-bookmarks"
            aria-disabled="true"
            aria-describedby={`${id}-reason`}
            title={reason}
          >
            {trigger}
          </button>
          <span className="sr-only" id={`${id}-reason`}>
            {reason}
          </span>
        </>
      ) : (
        <Popover label="Beats → bookmarks" className="music-beat-bookmarks" trigger={trigger}>
          {(close) => (
            <div className="music-beat-choices">
              <p>Bookmark this music clip&apos;s beats, so every snapping gesture lands on the beat.</p>
              {(['beats', 'downbeats'] as const satisfies readonly BeatChoice[]).map((choice) => {
                const plan = beatBookmarks(bookmarks, music, phase.analysis.beats, choice);
                const label = choice === 'beats' ? 'All beats' : 'Downbeats only';
                return (
                  <div key={choice} className="music-beat-choice">
                    <button
                      type="button"
                      className="text-button"
                      aria-disabled={plan.reason ? 'true' : undefined}
                      aria-describedby={plan.reason ? `${id}-${choice}` : undefined}
                      onClick={() => {
                        if (plan.reason) return;
                        close();
                        onEdit(plan.frames.map((frame) => ({ type: 'bookmark-add', frame })));
                      }}
                    >
                      {label} · {plan.frames.length}
                    </button>
                    {plan.reason && <small id={`${id}-${choice}`}>{plan.reason}</small>}
                  </div>
                );
              })}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
