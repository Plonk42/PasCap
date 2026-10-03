import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { musicSourceFrame } from '../shared/audio.js';
import type { EditCommand } from '../shared/commands.js';
import { applyCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { snapFrame, snapPoints } from '../shared/snap.js';
import type { DraftPreview } from './Timeline.js';

interface Props { project: ProjectDocument; asset: AudioAsset | undefined; leading: number; scale: number; frame: number; snapping: boolean; disabled: boolean; onPause: () => void; onEdit: (command: EditCommand) => void; onPreview: (draft: DraftPreview | null) => void; onError: (message: string) => void }
export function MusicTimeline({ project, asset, leading, scale, frame, snapping, disabled, onPause, onEdit, onPreview, onError }: Readonly<Props>) {
  const [candidate, setCandidate] = useState<ProjectDocument | null>(null);
  const drag = useRef<{ x: number; base: ProjectDocument; kind: 'move' | 'in' | 'out'; latest: ProjectDocument; invalid: string } | null>(null);
  const cancel = (): void => { if (drag.current) { drag.current = null; setCandidate(null); onPreview(null); } };
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } };
    window.addEventListener('keydown', escape, true); return () => window.removeEventListener('keydown', escape, true);
  });
  const music = (candidate ?? project).music;
  if (!music || !asset) return <div className="music-track-empty">Music · import an audio file in the inspector</div>;
  const peaks = Array.from({ length: 128 }, (_, index) => {
    const source = musicSourceFrame(music, music.start + Math.min(music.duration - 1, Math.floor(index / 128 * music.duration)))!;
    return { x: index * 4 + 1, peak: asset.waveform[Math.min(asset.waveform.length - 1, Math.floor(source / asset.metadata.frameCount * asset.waveform.length))] ?? 0 };
  });
  const start = (event: PointerEvent<HTMLButtonElement>, kind: 'move' | 'in' | 'out'): void => {
    if (event.button !== 0 || disabled || drag.current) return;
    event.preventDefault(); event.stopPropagation(); onPause();
    drag.current = { x: event.clientX, base: project, kind, latest: project, invalid: '' };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (!active?.base.music) return;
    const original = active.base.music;
    let delta = Math.round((event.clientX - active.x) / scale);
    if (snapping && !event.altKey) {
      const originalEdge = active.kind === 'out' ? original.start + original.duration : original.start;
      const points = snapPoints({ ...active.base, music: null });
      delta = snapFrame(originalEdge + delta, points, 8 / scale) - originalEdge;
    }
    let next = { ...original };
    if (active.kind === 'move') next.start = Math.max(0, original.start + delta);
    if (active.kind === 'in') {
      delta = Math.max(-Math.min(original.sourceIn, original.start), Math.min(original.duration - 1, delta));
      next = { ...original, sourceIn: original.sourceIn + delta, start: original.start + delta, duration: original.duration - delta };
    }
    if (active.kind === 'out') next.duration = Math.max(1, Math.min(original.loop ? 2_147_483_647 : original.sourceOut - original.sourceIn, original.duration + delta));
    try {
      const document = applyCommand(active.base, { type: 'music', music: next });
      active.latest = document; active.invalid = ''; setCandidate(document); onPreview({ document, frame });
    } catch (error) { active.invalid = error instanceof Error ? error.message : 'Invalid music range'; }
  };
  const finish = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!drag.current) return;
    const active = drag.current; cancel();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.invalid) onError(active.invalid); else onEdit({ type: 'music', music: active.latest.music });
  };
  const handlers = { onPointerMove: move, onPointerUp: finish, onPointerCancel: cancel, onLostPointerCapture: cancel };
  return <div className="music-timeline-clip" style={{ left: leading + music.start * scale, width: music.duration * scale }}>
    <button className="music-body" aria-label="Move music track" disabled={disabled} onPointerDown={(event) => start(event, 'move')} {...handlers}><svg viewBox="0 0 512 45" preserveAspectRatio="none" aria-label="Music waveform" role="img">{peaks.map(({ x, peak }) => <path key={x} d={`M${x} ${22 - Math.max(1, peak * 20)}v${Math.max(2, peak * 40)}`} stroke="#acb8ee" strokeWidth="2" />)}</svg><span>{asset.name}{music.loop ? ' · loop' : ''}</span></button>
    <button className="trim-handle in" aria-label="Trim music start" disabled={disabled} onPointerDown={(event) => start(event, 'in')} {...handlers}><span /></button>
    <button className="trim-handle out" aria-label="Trim music duration" disabled={disabled} onPointerDown={(event) => start(event, 'out')} {...handlers}><span /></button>
  </div>;
}