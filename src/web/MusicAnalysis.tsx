import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { MediaJob } from '../shared/media.js';
import type { MusicAnalysis } from '../shared/music-analysis.js';
import { api, ApiError } from './api.js';
import { Icon } from './icons.js';

const POLL_MS = 1000;

export type MusicAnalysisPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'running'; queued: boolean; progress: number }
  | { kind: 'ready'; analysis: MusicAnalysis }
  | { kind: 'error'; message: string };

/** Analyses already fetched this session, per prepared music recording. */
const known = new Map<string, MusicAnalysis>();

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ApiError('Request cancelled.', 0, 'aborted'));
      },
      { once: true },
    );
  });
}

function failed(cause: unknown): MusicAnalysisPhase {
  return { kind: 'error', message: cause instanceof Error ? cause.message : 'Cannot analyse this music.' };
}

/** The tempo, beats and sections of a prepared music recording, following its background analysis. */
export function useMusicAnalysis(asset: AudioAsset | undefined): {
  phase: MusicAnalysisPhase;
  analyse: () => void;
} {
  const ready = asset?.status === 'ready';
  const id = asset?.id ?? '';
  const key = `${id}/${asset?.content?.digest ?? ''}`;
  const [phase, setPhase] = useState<MusicAnalysisPhase>({ kind: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const start = useCallback((): AbortSignal => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    return abort.signal;
  }, []);
  const follow = useCallback(
    async (job: MediaJob, signal: AbortSignal): Promise<void> => {
      const poll = async (current: MediaJob): Promise<MediaJob> => {
        if (current.state !== 'queued' && current.state !== 'running') return current;
        setPhase({ kind: 'running', queued: current.state === 'queued', progress: current.progress });
        await delay(POLL_MS, signal);
        const next = (await api.jobs({ signal })).jobs.find((candidate) => candidate.id === current.id);
        if (!next) throw new Error('The music analysis is no longer listed. Try again.');
        return poll(next);
      };
      const done = await poll(job);
      if (done.state === 'cancelled') return setPhase({ kind: 'idle' });
      if (done.state === 'failed') throw new Error(done.message);
      const { analysis } = await api.musicAnalysis(id, { signal });
      if (!analysis) throw new Error('The analysis finished but its result is missing. Try again.');
      known.set(key, analysis);
      setPhase({ kind: 'ready', analysis });
    },
    [id, key],
  );
  useEffect(() => {
    const cached = known.get(key);
    if (cached || !ready) {
      setPhase(cached ? { kind: 'ready', analysis: cached } : { kind: 'idle' });
      return () => controller.current?.abort();
    }
    const signal = start();
    setPhase({ kind: 'checking' });
    api
      .musicAnalysis(id, { signal })
      .then(({ analysis, job }) => {
        if (analysis) {
          known.set(key, analysis);
          return setPhase({ kind: 'ready', analysis });
        }
        // Preparation queues the analysis once the music is ready.
        if (job) return follow(job, signal);
        setPhase({ kind: 'idle' });
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setPhase(failed(cause));
      });
    return () => controller.current?.abort();
  }, [key, ready]);
  const analyse = useCallback(() => {
    if (!id) return;
    const signal = start();
    api
      .analyseMusic(id)
      .then(({ job }) => (signal.aborted ? undefined : follow(job, signal)))
      .catch((cause: unknown) => {
        if (!signal.aborted) setPhase(failed(cause));
      });
  }, [id, follow, start]);
  return { phase, analyse };
}

function summary(analysis: MusicAnalysis): string {
  if (!analysis.tempo) return 'No steady beat found';
  const meter = analysis.meter ? ` · ${analysis.meter.beatsPerBar}/4` : '';
  return `${Math.round(analysis.tempo.bpm)} BPM${meter} · ${analysis.beats.length} beats`;
}

/** One line under Recording: the analysis summary, its progress, or the action that starts it. */
export function MusicAnalysisStatus({ asset }: Readonly<{ asset: AudioAsset | undefined }>) {
  const { phase, analyse } = useMusicAnalysis(asset);
  if (asset?.status !== 'ready') return null;
  let text: string;
  if (phase.kind === 'ready') text = summary(phase.analysis);
  else if (phase.kind === 'checking') text = 'Reading the music analysis…';
  else if (phase.kind === 'running')
    text = phase.queued ? 'Music analysis queued…' : `Analysing music ${Math.round(phase.progress * 100)}%`;
  else if (phase.kind === 'error') text = phase.message;
  else text = 'Tempo and beats not analysed';
  return (
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
  );
}
