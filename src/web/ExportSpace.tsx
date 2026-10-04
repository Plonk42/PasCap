import { useEffect, useState } from 'react';
import { formatStorageBytes, MIN_EXPORT_FREE_BYTES, type ExportPreflight } from '../shared/export-space.js';
import type { ExportProfile } from '../shared/export.js';
import type { ProjectDocument } from '../shared/model.js';
import { api } from './api.js';
import { Icon } from './icons.js';
import './export-space.css';

interface SpaceState { phase: 'checking' | 'ready' | 'error'; data: ExportPreflight | null; error: string }
interface Snapshot extends SpaceState { project: ProjectDocument; profile: ExportProfile; attempt: number }
export interface ExportSpaceState extends SpaceState { retry: () => void }

export function useExportSpace(project: ProjectDocument, profile: ExportProfile): ExportSpaceState {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ project, profile, attempt, phase: 'checking', data: null, error: '' }));
  useEffect(() => {
    const context = { project, profile, attempt };
    if (!project.clips.length) {
      setSnapshot({ ...context, phase: 'error', data: null, error: 'Add a video clip before checking export storage.' });
      return;
    }
    const controller = new AbortController();
    setSnapshot({ ...context, phase: 'checking', data: null, error: '' });
    void api.exportPreflight(project, profile, { signal: controller.signal }).then(({ space }) => {
      if (!controller.signal.aborted) setSnapshot({ ...context, phase: 'ready', data: space, error: '' });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setSnapshot({ ...context, phase: 'error', data: null, error: cause instanceof Error ? cause.message : 'Storage could not be checked. Check the local service and retry.' });
    });
    return () => controller.abort();
  }, [project, profile, attempt]);
  // Do not expose a previous profile's green result before the new effect runs.
  const current = snapshot.project === project && snapshot.profile === profile && snapshot.attempt === attempt;
  return {
    ...(current ? snapshot : { phase: 'checking' as const, data: null, error: '' }),
    retry: () => setAttempt((value) => value + 1),
  };
}

const STORAGE_LABEL = { available: 'Space checked', tight: 'Space may be tight', blocked: 'Free space needed' } as const;

export function ExportSpace({ state }: Readonly<{ state: ExportSpaceState }>) {
  if (state.phase === 'checking') return <output className="export-space-pending" aria-live="polite"><span className="spinner" />Checking storage…</output>;
  if (state.phase === 'error' || !state.data) return <section className="export-storage-error" role="alert"><Icon name="warning" size={18} /><p>{state.error}</p><button type="button" className="secondary-button small" onClick={state.retry}>Retry storage check</button></section>;
  const space = state.data;
  const max = Math.max(1, space.availableBytes);
  return <section className="export-storage" aria-label="Export storage" data-status={space.status}>
    <div className="export-storage-heading"><Icon name={space.status === 'available' ? 'check' : 'warning'} size={17} /><strong>{STORAGE_LABEL[space.status]}</strong><button type="button" className="icon-button" aria-label="Refresh storage check" title="Check available space again; does not start a render" onClick={state.retry}><Icon name="reset" size={14} /></button></div>
    <dl className="export-storage-values"><div><dt>Free on export volume</dt><dd>{formatStorageBytes(space.availableBytes)}</dd></div><div><dt>Planning allowance</dt><dd>{formatStorageBytes(space.estimate.totalBytes)}</dd></div></dl>
    <meter min={0} max={max} low={max * 0.65} high={max * 0.85} optimum={0} value={Math.min(max, space.estimate.totalBytes)} aria-label="Planning allowance compared with available storage" aria-valuetext={`${formatStorageBytes(space.estimate.totalBytes)} planning allowance; ${formatStorageBytes(space.availableBytes)} free. Actual use varies.`} />
    <p className="export-storage-note">Allowance, not a prediction or guaranteed upper bound. Actual compression and other disk users change the space needed.</p>
    {space.status === 'blocked' && <p className="export-storage-blocked" role="alert">Free at least {formatStorageBytes(MIN_EXPORT_FREE_BYTES)} to start, then recheck. A full render may need substantially more.</p>}
    {space.status === 'tight' && <p className="export-storage-note">You can still start, but freeing space first is recommended.</p>}
    <details className="export-storage-details"><summary>Storage details</summary><p>Outputs and job-owned temporary files are stored here:</p><output className="export-storage-path">{space.directory}</output><dl>
      <div><dt>Lossless clips/timelines</dt><dd>{formatStorageBytes(space.estimate.losslessBytes)}</dd></div>
      <div><dt>Encoded chunks + final MP4</dt><dd>{formatStorageBytes(space.estimate.encodedBytes)}</dd></div>
      <div><dt>Selected music PCM</dt><dd>{formatStorageBytes(space.estimate.audioBytes)}</dd></div>
      <div><dt>Margin + start reserve</dt><dd>{formatStorageBytes(space.estimate.overheadBytes)}</dd></div>
    </dl><p>Uses uncompressed 4-byte clip and 8-byte timeline frames, one byte per pixel per frame for each encoded copy, selected stereo PCM, and a 25% margin plus a 16 MiB start reserve. These are planning assumptions, not codec guarantees.</p><p>A storage failure cleans up only the failed job. Originals, saved edits and completed exports stay intact. Space is checked again before admission and when the worker starts.</p></details>
  </section>;
}