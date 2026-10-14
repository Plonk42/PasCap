import { useId, useState, type ReactNode } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { MAX_MUSIC_TRACKS, type MusicTrack, type ProjectDocument } from '../shared/model.js';
import './declutter.css';
import { Disclosure } from './Disclosure.js';
import { durationLabel, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import { createMusicInstance, musicInstanceEdit, videoTimelineDuration } from './music-ui.js';
import { NumberField } from './NumberField.js';
import { Popover } from './Popover.js';
import { ResetButton, resetBlocked } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  assets: AudioAsset[];
  busy: boolean;
  drafting: boolean;
  selectedMusicId: string | null;
  onSelectMusic: (id: string) => void;
  onImport: () => void;
  onEdit: (command: EditCommand) => void;
}

function MusicTiming({ helpId, children }: Readonly<{ helpId: string; children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      className="music-timing"
      title="Placement & fades"
      label="Placement & fades"
      triggerId={`${helpId}-timing-title`}
      contentId={`${helpId}-timing-fields`}
      open={open}
      onToggle={setOpen}
      help={
        <HelpPopover label="Audio timing" guide="add-music-and-export">
          <p id={helpId}>
            IN and OUT pick the part of the recording; Start and Duration place it on the timeline. Both fades must fit
            within Duration.
          </p>
          <p className="editor-help-tip">Tip: Loop repeats the chosen part, and music can play on over black.</p>
        </HelpPopover>
      }
    >
      {children}
    </Disclosure>
  );
}

export function MusicControls({
  project,
  assets,
  busy,
  drafting,
  selectedMusicId,
  onSelectMusic,
  onImport,
  onEdit,
}: Readonly<Props>) {
  const helpId = useId();
  const blocked = busy || drafting;
  const music = project.music.find((track) => track.id === selectedMusicId) ?? project.music[0];
  const videoDuration = videoTimelineDuration(project);
  const available = assets.some((asset) => asset.id === music?.mediaId);
  const ready = assets.filter((asset) => asset.status === 'ready');
  let addReason = ready.length ? '' : 'Import a music recording first; it can be added once it is ready.';
  if (project.music.length >= MAX_MUSIC_TRACKS)
    addReason = `A project can contain at most ${MAX_MUSIC_TRACKS} music tracks. Remove a track before adding another.`;
  const addMusic = (asset: AudioAsset): void => {
    if (blocked || project.music.length >= MAX_MUSIC_TRACKS || asset.status !== 'ready') return;
    onEdit({
      type: 'music',
      music: [...project.music, createMusicInstance(crypto.randomUUID(), asset, videoDuration)],
    });
  };
  const removeMusic = (): void => {
    if (music && !blocked) onEdit({ type: 'music', music: project.music.filter((track) => track.id !== music.id) });
  };
  return (
    <section className="music-controls declutter-music" aria-label="Music settings">
      <div className="music-instance-picker">
        <label className="speed-field">
          <span>
            Music track · {project.music.length} / {MAX_MUSIC_TRACKS}
          </span>
          <select
            aria-label="Music track"
            value={music?.id ?? ''}
            disabled={blocked || !project.music.length}
            onChange={(event) => onSelectMusic(event.target.value)}
          >
            {!project.music.length && <option value="">No music tracks</option>}
            {project.music.map((track, index) => (
              <option key={track.id} value={track.id}>
                {index + 1} · {assets.find((asset) => asset.id === track.mediaId)?.name ?? 'Unavailable recording'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete selected music track"
          title="Delete this music track · Undo restores it"
          disabled={blocked || !music}
          onClick={removeMusic}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
      {music && (
        <label className="speed-field music-recording-row">
          <span>Recording</span>
          <select
            aria-label="Music recording"
            disabled={blocked}
            title="Change the recording this music track plays"
            value={music.mediaId}
            onChange={(event) => {
              const asset = ready.find((item) => item.id === event.target.value);
              if (asset)
                onEdit(musicInstanceEdit(project, music.id, createMusicInstance(music.id, asset, videoDuration)));
            }}
          >
            {!available && <option value={music.mediaId}>Unavailable recording</option>}
            {assets.map((asset) => (
              <option key={asset.id} disabled={asset.status !== 'ready'} value={asset.id}>
                {asset.name} · {durationLabel(asset.metadata.durationSeconds)}
                {asset.status === 'ready' ? '' : ` (${asset.status})`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="music-add-row">
        {addReason || blocked ? (
          <button
            type="button"
            className="secondary-button small music-add"
            aria-label="Add music track"
            aria-describedby={addReason ? `${helpId}-add-reason` : undefined}
            title={addReason || undefined}
            disabled
          >
            <Icon name="plus" size={14} />
            Add music track
            {addReason && (
              <span className="declutter-sr-only" id={`${helpId}-add-reason`}>
                {addReason}
              </span>
            )}
          </button>
        ) : (
          <Popover
            label="Add music track"
            className="music-add"
            trigger={
              <>
                <Icon name="plus" size={14} />
                Add music track
              </>
            }
          >
            {(close) => (
              <ul className="music-add-list" aria-label="Ready music recordings">
                {ready.map((asset) => (
                  <li key={asset.id}>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Add ${asset.name} as a music track`}
                      onClick={() => {
                        close();
                        addMusic(asset);
                      }}
                    >
                      <Icon name="music" size={14} />
                      <span>{asset.name}</span>
                      <small>{durationLabel(asset.metadata.durationSeconds)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
        )}
        <button
          type="button"
          className="secondary-button small"
          title="Import music recordings into this project; originals stay in place"
          disabled={blocked}
          onClick={onImport}
        >
          <Icon name="folder" size={14} />
          Import music
        </button>
      </div>
      {project.music.map((track) => (
        <MusicInstanceControls
          key={track.id}
          project={project}
          music={track}
          source={assets.find((asset) => asset.id === track.mediaId)}
          active={track.id === music?.id}
          drafting={drafting}
          onEdit={onEdit}
        />
      ))}
    </section>
  );
}

function MusicInstanceControls({
  project,
  music,
  source,
  active,
  drafting,
  onEdit,
}: Readonly<{
  project: ProjectDocument;
  music: MusicTrack;
  source: AudioAsset | undefined;
  active: boolean;
  drafting: boolean;
  onEdit: Props['onEdit'];
}>) {
  const helpId = useId();
  const videoDuration = videoTimelineDuration(project);
  const inputContext = `${project.id}:${music.id}:${music.mediaId}`;
  const update = (settings: Partial<Omit<MusicTrack, 'id'>>): void => {
    if (active && !drafting) onEdit(musicInstanceEdit(project, music.id, settings));
  };
  const settingError = (settings: Partial<Omit<MusicTrack, 'id'>>): string | null => {
    try {
      if (!source) return 'The registered music recording is unavailable. Restore it before editing this track.';
      if ((settings.sourceOut ?? music.sourceOut) > source.metadata.frameCount)
        return 'Music range exceeds the registered original.';
      applyCommand(project, musicInstanceEdit(project, music.id, settings));
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'This edit cannot be applied to the music track.';
    }
  };
  const sourceRangeError = (sourceIn: number, sourceOut: number): string | null =>
    !music.loop && music.duration > sourceOut - sourceIn
      ? `Keep at least ${music.duration} source frames, shorten Duration, or enable Loop music first.`
      : settingError({ sourceIn, sourceOut });
  // Keep each instance mounted so selecting another track cannot borrow or discard its precise input draft.
  return (
    <div hidden={!active} data-music-controls-id={music.id}>
      <div className="music-track-overview">
        <span>{sourceSeconds(music.duration)} on timeline</span>
        <button
          className="text-button"
          disabled={drafting || !videoDuration}
          title={
            videoDuration
              ? 'Start this track at frame 0 and fit to the last video clip OUT, limited by the range unless Loop is enabled. Other music tracks stay unchanged.'
              : 'Add a video clip before fitting music to video duration.'
          }
          onClick={() =>
            update({
              start: 0,
              duration: music.loop ? videoDuration : Math.min(videoDuration, music.sourceOut - music.sourceIn),
            })
          }
        >
          Fit to video duration
        </button>
      </div>
      <div className="speed-field">
        <span className="setting-reset-group">
          <label htmlFor={`${helpId}-gain`}>Gain dB</label>
          <ResetButton
            name="Music gain"
            blocked={resetBlocked(music.gainDb === 0, drafting)}
            onReset={() => update({ gainDb: 0 })}
          />
        </span>
        <ValueControl
          id={`${helpId}-gain`}
          aria-label="Music gain"
          min={-60}
          max={12}
          step={0.5}
          value={music.gainDb}
          disabled={drafting}
          resetKey={inputContext}
          unit="dB"
          validate={(gainDb) => settingError({ gainDb })}
          onCommit={(gainDb) => update({ gainDb })}
        />
      </div>
      <label className="music-loop">
        <input
          type="checkbox"
          aria-label="Loop music"
          checked={music.loop}
          disabled={drafting}
          onChange={(event) => update({ loop: event.target.checked })}
        />
        <span>Loop selected range</span>
      </label>
      <MusicTiming helpId={helpId}>
        <div className="range-fields">
          <label>
            Source IN
            <NumberField
              aria-label="Music source IN"
              aria-describedby={helpId}
              min={0}
              max={music.sourceOut - 1}
              integer
              step={1}
              value={music.sourceIn}
              disabled={drafting}
              resetKey={inputContext}
              validate={(value) => sourceRangeError(value, music.sourceOut)}
              onCommit={(sourceIn) => update({ sourceIn })}
            />
          </label>
          <label>
            Source OUT
            <NumberField
              aria-label="Music source OUT"
              aria-describedby={helpId}
              min={music.sourceIn + 1}
              max={Math.min(source?.metadata.frameCount ?? 2_147_483_647, 2_147_483_647)}
              integer
              step={1}
              value={music.sourceOut}
              disabled={drafting}
              resetKey={inputContext}
              validate={(value) => sourceRangeError(music.sourceIn, value)}
              onCommit={(sourceOut) => update({ sourceOut })}
            />
          </label>
        </div>
        <div className="range-fields">
          <label>
            Timeline start
            <NumberField
              aria-label="Music timeline start"
              aria-describedby={helpId}
              min={0}
              max={2_147_483_647 - music.duration}
              integer
              step={1}
              value={music.start}
              disabled={drafting}
              resetKey={inputContext}
              validate={(start) => settingError({ start })}
              onCommit={(start) => update({ start })}
            />
          </label>
          <label>
            Duration · frames
            <NumberField
              aria-label="Music duration"
              aria-describedby={helpId}
              min={Math.max(1, music.fadeIn + music.fadeOut)}
              max={Math.min(2_147_483_647 - music.start, music.loop ? 2_147_483_647 : music.sourceOut - music.sourceIn)}
              integer
              step={1}
              value={music.duration}
              disabled={drafting}
              resetKey={inputContext}
              validate={(duration) => settingError({ duration })}
              onCommit={(duration) => update({ duration })}
            />
          </label>
        </div>
        <div className="range-fields">
          <label>
            Fade in · frames
            <NumberField
              aria-label="Music fade in"
              aria-describedby={helpId}
              min={0}
              max={music.duration - music.fadeOut}
              integer
              step={1}
              value={music.fadeIn}
              disabled={drafting}
              resetKey={inputContext}
              validate={(fadeIn) => settingError({ fadeIn })}
              onCommit={(fadeIn) => update({ fadeIn })}
            />
          </label>
          <label>
            Fade out · frames
            <NumberField
              aria-label="Music fade out"
              aria-describedby={helpId}
              min={0}
              max={music.duration - music.fadeIn}
              integer
              step={1}
              value={music.fadeOut}
              disabled={drafting}
              resetKey={inputContext}
              validate={(fadeOut) => settingError({ fadeOut })}
              onCommit={(fadeOut) => update({ fadeOut })}
            />
          </label>
        </div>
      </MusicTiming>
    </div>
  );
}
