import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { MediaJob } from '../shared/media.js';
import type { MusicTrack } from '../shared/model.js';
import { keyName, type MusicAnalysis } from '../shared/music-analysis.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import { MusicStructureList } from './music-structure.js';

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
/** Every change to any entry, for views that read several recordings at once. */
const anyListeners = new Set<() => void>();
let revision = 0;

const entryKey = (asset: AudioAsset): string => `${asset.id}/${asset.content?.digest ?? ''}`;

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
  revision++;
  for (const listener of anyListeners) listener();
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
  const key = asset ? entryKey(asset) : '/';
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

function subscribeAny(listener: () => void): () => void {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
}

/** The analyses of these recordings once read; the music lanes load them. */
export function useAnalyses(assets: readonly AudioAsset[]): (mediaId: string) => MusicAnalysis | null {
  const current = useSyncExternalStore(subscribeAny, () => revision);
  return useMemo(() => {
    const analyses = new Map<string, MusicAnalysis>();
    for (const asset of assets) {
      const phase = asset.status === 'ready' ? entries.get(entryKey(asset))?.phase : undefined;
      if (phase?.kind === 'ready') analyses.set(asset.id, phase.analysis);
    }
    return (mediaId: string) => analyses.get(mediaId) ?? null;
    // `current` changes whenever an analysis is read.
  }, [assets, current]);
}

function summary(analysis: MusicAnalysis): string {
  const key = analysis.key ? ` · ${keyName(analysis.key)}` : '';
  const hits = analysis.hits.length ? ` · ${analysis.hits.length} hits` : '';
  if (!analysis.tempo) return `No steady beat found${key}${hits}`;
  const meter = analysis.meter ? ` · ${analysis.meter.beatsPerBar}/4` : '';
  return `${Math.round(analysis.tempo.bpm)} BPM${meter}${key} · ${analysis.beats.length} beats${hits}`;
}

function statusText(phase: MusicAnalysisPhase): string {
  if (phase.kind === 'ready') return summary(phase.analysis);
  if (phase.kind === 'checking') return 'Reading the music analysis…';
  if (phase.kind === 'running')
    return phase.queued ? 'Music analysis queued…' : `Analysing music ${Math.round(phase.progress * 100)}%`;
  if (phase.kind === 'error') return phase.message;
  return 'Tempo and beats not analysed';
}

interface StatusProps {
  asset: AudioAsset | undefined;
  music: MusicTrack;
  onSeek: (frame: number) => void;
}

/** Under Recording: the analysis summary, its progress or Analyse music, then the music's structure. */
export function MusicAnalysisStatus({ asset, music, onSeek }: Readonly<StatusProps>) {
  const { phase, analyse } = useMusicAnalysis(asset);
  if (asset?.status !== 'ready') return null;
  const text = statusText(phase);
  return (
    <div className="music-analysis">
      <div className={`music-analysis-status ${phase.kind}`} role="status" aria-live="polite">
        <Icon name="music" size={14} />
        <span title={text}>{text}</span>
        {(phase.kind === 'idle' || phase.kind === 'error') && (
          <button
            type="button"
            className="text-button"
            title="Find the tempo, beats, hits and sections of this music in the background"
            onClick={analyse}
          >
            Analyse music
          </button>
        )}
      </div>
      {phase.kind === 'ready' && <MusicStructureList music={music} analysis={phase.analysis} onSeek={onSeek} />}
    </div>
  );
}
