import { useId, useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { EditCommand } from '../shared/commands.js';
import type { MusicTrack, ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';
import './declutter.css';
import { durationLabel, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { NumberField } from './NumberField.js';

interface Props { project: ProjectDocument; assets: AudioAsset[]; busy: boolean; drafting: boolean; onImport: (path: string) => Promise<void>; onPrepare: (id: string) => Promise<void>; onEdit: (command: EditCommand) => void }
export function MusicControls({ project, assets, busy, drafting, onImport, onPrepare, onEdit }: Readonly<Props>) {
  const helpId = useId();
  const [filename, setFilename] = useState('');
  const music = project.music;
  const duration = calculateLayout(project).duration;
  const source = assets.find((asset) => asset.id === music?.mediaId);
  const inputContext = `${project.id}:${music?.mediaId}`;
  const sourceRangeError = (sourceIn: number, sourceOut: number): string | null => music && !music.loop && music.duration > sourceOut - sourceIn
    ? `Keep at least ${music.duration} source frames, shorten Duration, or enable Loop music first.` : null;
  const update = (settings: Partial<MusicTrack>): void => { if (music) onEdit({ type: 'music', music: { ...music, ...settings } }); };
  return <section className="music-controls declutter-music" aria-label="Music settings">
    <form className="music-import" onSubmit={(event) => { event.preventDefault(); void onImport(filename); }}><input aria-label="Music file path" placeholder="Local audio file path" value={filename} onChange={(event) => setFilename(event.target.value)} /><button type="submit" className="secondary-button small" disabled={busy || !filename.trim()}>Import audio</button></form>
    <label className="speed-field">Recording<select aria-label="Music recording" disabled={drafting} value={music?.mediaId ?? ''} onChange={(event) => {
      const asset = assets.find((item) => item.id === event.target.value);
      if (!asset) { onEdit({ type: 'music', music: null }); return; }
      onEdit({ type: 'music', music: { mediaId: asset.id, sourceIn: 0, sourceOut: asset.metadata.frameCount, start: 0, duration: Math.min(asset.metadata.frameCount, duration || asset.metadata.frameCount), gainDb: 0, fadeIn: 0, fadeOut: 0, loop: false } });
    }}><option value="">No music</option>{assets.map((asset) => <option key={asset.id} disabled={asset.status !== 'ready'} value={asset.id}>{asset.name} · {durationLabel(asset.metadata.durationSeconds)}{asset.status !== 'ready' ? ` (${asset.status})` : ''}</option>)}</select></label>
    {assets.filter((asset) => asset.status === 'error').map((asset) => <button key={asset.id} className="text-button" title={asset.error ?? ''} disabled={busy} onClick={() => { void onPrepare(asset.id); }}>Retry {asset.name}</button>)}
    {music && <>
      <div className="music-track-overview"><span>{sourceSeconds(music.duration)} on timeline</span><button className="text-button" disabled={drafting || !duration} onClick={() => update({ start: 0, duration: music.loop ? duration : Math.min(duration, music.sourceOut - music.sourceIn) })}>Fit to video duration</button></div>
      <label className="speed-field">Gain dB<NumberField aria-label="Music gain" min={-60} max={12} step={0.5} value={music.gainDb} disabled={drafting} resetKey={inputContext} onCommit={(gainDb) => update({ gainDb })} /></label>
      <label className="music-loop"><input type="checkbox" aria-label="Loop music" checked={music.loop} disabled={drafting} onChange={(event) => update({ loop: event.target.checked })} />Loop selected source range</label>
      <details className="music-timing"><summary>Placement & fades</summary>
        <div className="range-fields"><label>Source IN<NumberField aria-label="Music source IN" aria-describedby={helpId} min={0} max={music.sourceOut - 1} integer step={1} value={music.sourceIn} disabled={drafting} resetKey={inputContext} validate={(value) => sourceRangeError(value, music.sourceOut)} onCommit={(sourceIn) => update({ sourceIn })} /></label><label>Source OUT<NumberField aria-label="Music source OUT" aria-describedby={helpId} min={music.sourceIn + 1} max={Math.min(source?.metadata.frameCount ?? 2_147_483_647, 2_147_483_647)} integer step={1} value={music.sourceOut} disabled={drafting} resetKey={inputContext} validate={(value) => sourceRangeError(music.sourceIn, value)} onCommit={(sourceOut) => update({ sourceOut })} /></label></div>
        <div className="range-fields"><label>Timeline start<NumberField aria-label="Music timeline start" aria-describedby={helpId} min={0} max={2_147_483_647} integer step={1} value={music.start} disabled={drafting} resetKey={inputContext} onCommit={(start) => update({ start })} /></label><label>Duration · frames<NumberField aria-label="Music duration" aria-describedby={helpId} min={Math.max(1, music.fadeIn + music.fadeOut)} max={music.loop ? 2_147_483_647 : music.sourceOut - music.sourceIn} integer step={1} value={music.duration} disabled={drafting} resetKey={inputContext} hint={music.loop ? 'At least the combined fade lengths.' : 'Must fit the source range and combined fades; enable Loop music to repeat.'} onCommit={(duration) => update({ duration })} /></label></div>
        <div className="range-fields"><label>Fade in · frames<NumberField aria-label="Music fade in" aria-describedby={helpId} min={0} max={music.duration - music.fadeOut} integer step={1} value={music.fadeIn} disabled={drafting} resetKey={inputContext} onCommit={(fadeIn) => update({ fadeIn })} /></label><label>Fade out · frames<NumberField aria-label="Music fade out" aria-describedby={helpId} min={0} max={music.duration - music.fadeIn} integer step={1} value={music.fadeOut} disabled={drafting} resetKey={inputContext} onCommit={(fadeOut) => update({ fadeOut })} /></label></div>
        <HelpPopover label="Audio timing" className="control-help"><p id={helpId}>IN / OUT use original audio frames; OUT is exclusive. Start, duration and fades use timeline frames. Both fades must fit within Duration.</p></HelpPopover>
      </details>
    </>}
  </section>;
}
