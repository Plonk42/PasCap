import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { MAX_MUSIC_TRACKS, type MusicTrack, type ProjectDocument } from '../shared/model.js';
import './declutter.css';
import { Disclosure } from './Disclosure.js';
import { durationLabel, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import './media-import.css';
import { Modal } from './Modal.js';
import { createMusicInstance, musicInstanceEdit, videoTimelineDuration } from './music-ui.js';
import { NumberField } from './NumberField.js';
import { ValueControl } from './ValueControl.js';

interface Props {
  project: ProjectDocument;
  assets: AudioAsset[];
  busy: boolean;
  drafting: boolean;
  selectedMusicId: string | null;
  onSelectMusic: (id: string) => void;
  error: string;
  onImport: (path: string) => Promise<boolean>;
  onBrowseImport: (path: string) => Promise<boolean>;
  onBrowseVisibility: (open: boolean) => void;
  onPrepare: (id: string) => Promise<void>;
  onEdit: (command: EditCommand) => void;
}

const MusicBrowser = lazy(() => import('./MusicBrowser.js').then((module) => ({ default: module.MusicBrowser })));

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
        <HelpPopover label="Audio timing">
          <p id={helpId}>
            IN / OUT use original audio frames; OUT is exclusive. Start, duration and fades use timeline frames. Both
            fades must fit within Duration. Music can extend the project beyond the last video clip, continuing over
            black. Video closing fades stay on their last clips; changing video length never shortens music.
          </p>
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
  error,
  onImport,
  onBrowseImport,
  onBrowseVisibility,
  onPrepare,
  onEdit,
}: Readonly<Props>) {
  const helpId = useId();
  const [filename, setFilename] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [chosenRecordingId, setChosenRecordingId] = useState('');
  const browseTrigger = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const blocked = busy || drafting || importing;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onBrowseVisibility(showBrowser);
    return () => {
      if (showBrowser) onBrowseVisibility(false);
    };
  }, [showBrowser, onBrowseVisibility]);
  const importMusic = async (path: string, fromBrowser: boolean): Promise<void> => {
    if (blocked || pending.current || !path.trim()) return;
    pending.current = true;
    setImporting(true);
    setImportError('');
    try {
      const accepted = await (fromBrowser ? onBrowseImport(path) : onImport(path));
      if (!mounted.current) return;
      if (accepted) {
        if (fromBrowser) setShowBrowser(false);
      } else
        setImportError(
          'Music import was not confirmed. Check Activity and the current project’s music bin before importing again. Your selection is kept.',
        );
    } catch (cause) {
      if (mounted.current)
        setImportError(
          `${cause instanceof Error ? cause.message : 'Music import was not confirmed.'} Check Activity and the current project’s music bin before repeating the import.`,
        );
    } finally {
      pending.current = false;
      if (mounted.current) setImporting(false);
    }
  };
  const music = project.music.find((track) => track.id === selectedMusicId) ?? project.music[0];
  const videoDuration = videoTimelineDuration(project);
  const recordingId = music?.mediaId ?? chosenRecordingId;
  const recording = assets.find((asset) => asset.id === recordingId);
  let addReason = recording?.status !== 'ready' ? 'Choose a ready Recording before adding a music track.' : '';
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
      <button
        ref={browseTrigger}
        type="button"
        className="secondary-button small music-browse-trigger"
        disabled={blocked}
        onClick={() => {
          setImportError('');
          setShowBrowser(true);
        }}
      >
        <Icon name="folder" size={14} />
        Browse music files
      </button>
      <form
        className="music-import"
        onSubmit={(event) => {
          event.preventDefault();
          void importMusic(filename, false);
        }}
      >
        <input
          aria-label="Music file path"
          placeholder="Local audio file path"
          value={filename}
          disabled={blocked}
          onChange={(event) => setFilename(event.target.value)}
        />
        <button type="submit" className="secondary-button small" disabled={blocked || !filename.trim()}>
          <Icon name="plus" size={14} />
          Import audio
        </button>
      </form>
      {!showBrowser && importError && !error && (
        <p className="footage-error" role="alert">
          {importError}
        </p>
      )}
      {showBrowser && (
        <Modal
          className="music-browser-dialog"
          labelledBy={`${helpId}-browse-title`}
          describedBy={`${helpId}-browse-description`}
          busy={blocked}
          error={[error, importError].filter(Boolean).join('\n')}
          restoreFocusTo={browseTrigger}
          onClose={() => {
            if (!pending.current) setShowBrowser(false);
          }}
          footer={
            <button
              type="button"
              className="secondary-button"
              disabled={blocked}
              onClick={() => {
                if (!pending.current) setShowBrowser(false);
              }}
            >
              Cancel
            </button>
          }
        >
          <div className="activity-dialog-heading">
            <h2 id={`${helpId}-browse-title`}>Browse music files</h2>
          </div>
          <p className="control-hint" id={`${helpId}-browse-description`}>
            Choose one original audio file accessible to the PasCap service. Browsing and selection do not import, copy
            or prepare it.
          </p>
          <Suspense fallback={<output className="footage-loading">Opening music browser…</output>}>
            <MusicBrowser busy={blocked} onImport={(path) => importMusic(path, true)} />
          </Suspense>
        </Modal>
      )}
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
        <div className="music-instance-actions">
          <button
            type="button"
            className="secondary-button small"
            aria-label="Add music track"
            aria-describedby={addReason ? `${helpId}-add-reason` : undefined}
            title={addReason || 'Add an independent instance of the chosen Recording; existing tracks stay unchanged.'}
            disabled={blocked || !!addReason}
            onClick={() => {
              if (recording) addMusic(recording);
            }}
          >
            <Icon name="plus" size={14} />
            Add music track
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Delete selected music track"
            title="Delete only the selected music track · Undo restores it"
            disabled={blocked || !music}
            onClick={removeMusic}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
        {addReason && (
          <p className="control-hint" id={`${helpId}-add-reason`}>
            {addReason}
          </p>
        )}
      </div>
      <label className="speed-field">
        <span>Recording</span>
        <select
          aria-label="Music recording"
          disabled={blocked}
          title="Choose this track’s recording deliberately. Use Add music track first to create another independent instance."
          value={recordingId}
          onChange={(event) => {
            const asset = assets.find((item) => item.id === event.target.value);
            if (!asset) {
              setChosenRecordingId('');
              removeMusic();
              return;
            }
            if (asset.status !== 'ready') return;
            setChosenRecordingId(asset.id);
            if (music)
              onEdit(musicInstanceEdit(project, music.id, createMusicInstance(music.id, asset, videoDuration)));
            else addMusic(asset);
          }}
        >
          <option value="">{music ? 'No music · remove this track' : 'No music'}</option>
          {recordingId && !recording && <option value={recordingId}>Unavailable recording</option>}
          {assets.map((asset) => (
            <option key={asset.id} disabled={asset.status !== 'ready'} value={asset.id}>
              {asset.name} · {durationLabel(asset.metadata.durationSeconds)}
              {asset.status !== 'ready' ? ` (${asset.status})` : ''}
            </option>
          ))}
        </select>
      </label>
      {assets
        .filter((asset) => asset.status === 'error')
        .map((asset) => (
          <button
            key={asset.id}
            className="text-button"
            title={asset.error ?? ''}
            disabled={busy}
            onClick={() => {
              void onPrepare(asset.id);
            }}
          >
            Retry {asset.name}
          </button>
        ))}
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
              ? 'Start this track at frame 0 and fit to the last video OUT, limited by the source range unless Loop is enabled. Other music tracks stay unchanged.'
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
        <label htmlFor={`${helpId}-gain`}>Gain dB</label>
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
        <span>Loop selected source range</span>
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
              hint={
                music.loop
                  ? 'Can extend past video; must contain both fades.'
                  : 'Can extend past video; must fit the source range and both fades. Loop repeats the range.'
              }
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
