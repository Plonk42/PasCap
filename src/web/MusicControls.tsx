import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import {
  MAX_MUSIC_CLIPS,
  MAX_MUSIC_TRACKS,
  type MusicClip,
  type MusicLane,
  type MusicTransition,
  type ProjectDocument,
} from '../shared/model.js';
import {
  insertMusicClip,
  musicClipEnd,
  musicTracks,
  removeMusicClips,
  setMusicRipple,
  setMusicTransition,
  type MusicTransitionType,
} from '../shared/music-lanes.js';
import './editor-panels.css';
import './music-ui.css';
import { Disclosure } from './Disclosure.js';
import { durationLabel, sourceSeconds } from './display.js';
import { HelpPopover } from './HelpPopover.js';
import { Icon } from './icons.js';
import {
  createMusicClip,
  createMusicLane,
  musicClipEdit,
  musicEditError,
  musicLaneEdit,
  videoTimelineDuration,
  type MusicEdit,
} from './music-ui.js';
import { MusicAnalysisStatus } from './MusicAnalysis.js';
import { NumberField } from './NumberField.js';
import { Popover } from './Popover.js';
import { ResetButton, resetBlocked } from './SettingValueControl.js';
import { ValueControl } from './ValueControl.js';

/** A timeline boundary button's request to show the transition after one music clip. */
export interface MusicBoundaryRequest {
  leftId: string;
  serial: number;
}

interface Props {
  project: ProjectDocument;
  assets: AudioAsset[];
  busy: boolean;
  drafting: boolean;
  /** The selected music clip. */
  selectedMusicId: string | null;
  boundary: MusicBoundaryRequest | null;
  onSelectMusic: (id: string) => void;
  onImport: () => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  onSeek: (frame: number) => void;
}

type LaneUpdate = (lane: MusicLane) => MusicLane;

const MAX_FRAME = 2_147_483_647;
/** A new crossfade or fade through silence lasts one second; a new pause is half a second. */
const DEFAULT_TRANSITION_FRAMES = 30;
const DEFAULT_PAUSE_FRAMES = 15;
const TRANSITION_NAMES: Record<MusicTransitionType, string> = {
  cut: 'Cut',
  crossfade: 'Crossfade',
  'fade-through-silence': 'Fade through silence',
  'fade-silence-pause': 'Fade through silence with pause',
};

/** Why an edit cannot apply, or null: invalid drafts stay editable, never clamped. */
function editError(project: ProjectDocument, edit: () => MusicEdit): string | null {
  try {
    applyCommand(project, edit());
    return null;
  } catch (cause) {
    return musicEditError(cause, 'This edit cannot be applied to the music track.');
  }
}

function recordingName(clip: MusicClip, assets: readonly AudioAsset[]): string {
  return assets.find((asset) => asset.id === clip.mediaId)?.name ?? 'Unavailable recording';
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
            IN and OUT pick the part of the recording; Start and Duration place the selected clip. Fade in and out apply
            at the start and end of the music track.
          </p>
          <p className="editor-help-tip">Tip: Loop repeats the chosen part, and music can play on over black.</p>
        </HelpPopover>
      }
    >
      {children}
    </Disclosure>
  );
}

function RecordingPicker({
  label,
  text,
  itemLabel,
  ready,
  reason,
  disabled,
  onPick,
}: Readonly<{
  label: string;
  text: string;
  itemLabel: (asset: AudioAsset) => string;
  ready: readonly AudioAsset[];
  reason: string;
  disabled: boolean;
  onPick: (asset: AudioAsset) => void;
}>) {
  const reasonId = useId();
  const content = (
    <>
      <Icon name="plus" size={14} />
      {text}
    </>
  );
  if (reason || disabled)
    return (
      <button
        type="button"
        className="secondary-button small music-add"
        aria-label={label}
        aria-describedby={reason ? reasonId : undefined}
        title={reason || undefined}
        disabled
      >
        {content}
        {reason && (
          <span className="sr-only" id={reasonId}>
            {reason}
          </span>
        )}
      </button>
    );
  return (
    <Popover label={label} className="music-add" trigger={content}>
      {(close) => (
        <ul className="music-add-list" aria-label="Ready music recordings">
          {ready.map((asset) => (
            <li key={asset.id}>
              <button
                type="button"
                className="text-button"
                aria-label={itemLabel(asset)}
                onClick={() => {
                  close();
                  onPick(asset);
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
  );
}

export function MusicControls({
  project,
  assets,
  busy,
  drafting,
  selectedMusicId,
  boundary,
  onSelectMusic,
  onImport,
  onEdit,
  onSeek,
}: Readonly<Props>) {
  const blocked = busy || drafting;
  const lane = project.music.find((item) => item.clips.some((clip) => clip.id === selectedMusicId)) ?? project.music[0];
  const ready = assets.filter((asset) => asset.status === 'ready');
  let addReason = ready.length ? '' : 'Import a music recording first; it can be added once it is ready.';
  if (project.music.length >= MAX_MUSIC_TRACKS)
    addReason = `A project can contain at most ${MAX_MUSIC_TRACKS} music tracks. Remove a track before adding another.`;
  const addTrack = (asset: AudioAsset): void => {
    if (blocked || project.music.length >= MAX_MUSIC_TRACKS || asset.status !== 'ready') return;
    const created = createMusicLane(crypto.randomUUID(), crypto.randomUUID(), asset, videoTimelineDuration(project));
    onEdit({ type: 'music', music: [...project.music, created] });
  };
  const removeTrack = (): void => {
    if (lane && !blocked) onEdit({ type: 'music', music: project.music.filter((item) => item.id !== lane.id) });
  };
  return (
    <section className="music-controls editor-music" aria-label="Music settings">
      <div className="music-instance-picker">
        <label className="speed-field">
          <span>
            Music track · {project.music.length} / {MAX_MUSIC_TRACKS}
          </span>
          <select
            aria-label="Music track"
            value={lane?.id ?? ''}
            disabled={blocked || !project.music.length}
            onChange={(event) => {
              const next = project.music.find((item) => item.id === event.target.value);
              if (next) onSelectMusic(next.clips[0]!.id);
            }}
          >
            {!project.music.length && <option value="">No music tracks</option>}
            {project.music.map((item, index) => (
              <option key={item.id} value={item.id}>
                {index + 1} · {recordingName(item.clips[0]!, assets)}
                {item.clips.length > 1 ? ` + ${item.clips.length - 1} more` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="Delete selected music track"
          title="Delete this music track and its clips · Undo restores them"
          disabled={blocked || !lane}
          onClick={removeTrack}
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div className="music-add-row">
        <RecordingPicker
          label="Add music track"
          text="Add music track"
          itemLabel={(asset) => `Add ${asset.name} as a music track`}
          ready={ready}
          reason={addReason}
          disabled={blocked}
          onPick={addTrack}
        />
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
      {project.music.map((item, index) => (
        <MusicLaneControls
          key={item.id}
          project={project}
          lane={item}
          index={index}
          assets={assets}
          ready={ready}
          active={item.id === lane?.id}
          selectedClipId={selectedMusicId}
          boundary={boundary}
          busy={busy}
          drafting={drafting}
          onSelectMusic={onSelectMusic}
          onEdit={onEdit}
          onSeek={onSeek}
        />
      ))}
    </section>
  );
}

interface LaneProps {
  project: ProjectDocument;
  lane: MusicLane;
  /** The music track's position, from 0. */
  index: number;
  assets: readonly AudioAsset[];
  ready: readonly AudioAsset[];
  active: boolean;
  selectedClipId: string | null;
  boundary: MusicBoundaryRequest | null;
  busy: boolean;
  drafting: boolean;
  onSelectMusic: (id: string) => void;
  onEdit: Props['onEdit'];
  onSeek: Props['onSeek'];
}

/** One music track's settings, kept mounted so selecting another track cannot borrow or discard its drafts. */
function MusicLaneControls(props: Readonly<LaneProps>) {
  const { project, lane, index, assets, active, drafting, onEdit } = props;
  const helpId = useId();
  const root = useRef<HTMLDivElement>(null);
  const handled = useRef(props.boundary?.serial ?? 0);
  const clip = lane.clips.find((item) => item.id === props.selectedClipId) ?? lane.clips[0]!;
  const sources = musicTracks([lane]);
  const first = sources[0]!;
  const last = sources.at(-1)!;
  const inputContext = `${project.id}:${lane.id}`;
  const laneEdit = (update: LaneUpdate): MusicEdit => musicLaneEdit(project, lane.id, update);
  const commit = (update: LaneUpdate): void => {
    if (active && !drafting) onEdit(laneEdit(update));
  };
  const laneError = (update: LaneUpdate): string | null => editError(project, () => laneEdit(update));
  const boundary = props.boundary;
  useEffect(() => {
    if (!active || !boundary || boundary.serial === handled.current) return;
    handled.current = boundary.serial;
    const row = root.current?.querySelector<HTMLElement>(
      `[data-music-transition-row="${CSS.escape(boundary.leftId)}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector<HTMLSelectElement>('select')?.focus();
  }, [active, boundary]);
  return (
    <div hidden={!active} data-music-controls-id={lane.id} ref={root}>
      <div className="speed-field">
        <span className="setting-reset-group">
          <label htmlFor={`${helpId}-gain`}>Gain dB</label>
          <ResetButton
            name="Music gain"
            blocked={resetBlocked(lane.gainDb === 0, drafting)}
            onReset={() => commit((current) => ({ ...current, gainDb: 0 }))}
          />
        </span>
        <ValueControl
          id={`${helpId}-gain`}
          aria-label="Music gain"
          min={-60}
          max={12}
          step={0.5}
          value={lane.gainDb}
          disabled={drafting}
          resetKey={inputContext}
          unit="dB"
          validate={(gainDb) => laneError((current) => ({ ...current, gainDb }))}
          onCommit={(gainDb) => commit((current) => ({ ...current, gainDb }))}
        />
      </div>
      <label
        className="music-loop"
        title="Ripple on: the clips play one after another from the first one. Off: each clip keeps its own start."
      >
        <input
          type="checkbox"
          aria-label={`Ripple on music track ${index + 1}`}
          checked={lane.ripple}
          disabled={drafting}
          onChange={(event) => commit((current) => setMusicRipple(current, event.target.checked))}
        />
        <span>Ripple</span>
      </label>
      <MusicClipPicker {...props} clip={clip} />
      {lane.clips.map((item) => (
        <MusicClipSettings
          key={item.id}
          project={project}
          lane={lane}
          clip={item}
          assets={assets}
          ready={props.ready}
          active={active && item.id === clip.id}
          busy={props.busy}
          drafting={drafting}
          onEdit={onEdit}
          onSeek={props.onSeek}
        />
      ))}
      <MusicTiming helpId={helpId}>
        {lane.clips.map((item, position) => (
          <MusicClipTiming
            key={item.id}
            project={project}
            lane={lane}
            clip={item}
            position={position}
            asset={assets.find((asset) => asset.id === item.mediaId)}
            active={active && item.id === clip.id}
            drafting={drafting}
            helpId={helpId}
            onEdit={onEdit}
          />
        ))}
        <div className="range-fields">
          <label>
            Track fade in · frames
            <NumberField
              aria-label="Music fade in"
              aria-describedby={helpId}
              min={0}
              max={first.duration - first.fadeOut}
              integer
              step={1}
              value={lane.openingFade}
              disabled={drafting}
              resetKey={inputContext}
              validate={(openingFade) => laneError((current) => ({ ...current, openingFade }))}
              onCommit={(openingFade) => commit((current) => ({ ...current, openingFade }))}
            />
          </label>
          <label>
            Track fade out · frames
            <NumberField
              aria-label="Music fade out"
              aria-describedby={helpId}
              min={0}
              max={last.duration - last.fadeIn}
              integer
              step={1}
              value={lane.closingFade}
              disabled={drafting}
              resetKey={inputContext}
              validate={(closingFade) => laneError((current) => ({ ...current, closingFade }))}
              onCommit={(closingFade) => commit((current) => ({ ...current, closingFade }))}
            />
          </label>
        </div>
      </MusicTiming>
      {lane.transitions.length > 0 && (
        <fieldset className="music-transitions">
          <legend>Transitions</legend>
          <ol>
            {lane.transitions.map((transition, position) => (
              <MusicTransitionRow
                key={`${transition.leftId}:${transition.rightId}`}
                project={project}
                lane={lane}
                transition={transition}
                position={position}
                active={active}
                drafting={drafting}
                onEdit={onEdit}
              />
            ))}
          </ol>
        </fieldset>
      )}
    </div>
  );
}

function MusicClipPicker({
  project,
  lane,
  index,
  assets,
  ready,
  clip,
  busy,
  drafting,
  onSelectMusic,
  onEdit,
}: Readonly<LaneProps & { clip: MusicClip }>) {
  const reasonId = useId();
  const blocked = busy || drafting;
  let addReason = ready.length ? '' : 'Import a music recording first; it can be added once it is ready.';
  if (lane.clips.length >= MAX_MUSIC_CLIPS)
    addReason = `A music track holds at most ${MAX_MUSIC_CLIPS} clips. Add another music track instead.`;
  const single = lane.clips.length < 2;
  const deleteReason = 'A music track keeps at least one clip: delete the music track instead.';
  const add = (asset: AudioAsset): void => {
    if (blocked || lane.clips.length >= MAX_MUSIC_CLIPS || asset.status !== 'ready') return;
    const created = createMusicClip(crypto.randomUUID(), asset, musicClipEnd(lane.clips.at(-1)!));
    onEdit(musicLaneEdit(project, lane.id, (current) => insertMusicClip(current, created)));
  };
  const remove = (): void => {
    if (blocked || single) return;
    onEdit(musicLaneEdit(project, lane.id, (current) => removeMusicClips(current, new Set([clip.id]))!));
  };
  return (
    <div className="music-instance-picker music-clip-picker">
      <label className="speed-field">
        <span>
          Clip · {lane.clips.length} / {MAX_MUSIC_CLIPS}
        </span>
        <select
          aria-label="Music clip"
          value={clip.id}
          disabled={blocked}
          onChange={(event) => onSelectMusic(event.target.value)}
        >
          {lane.clips.map((item, position) => (
            <option key={item.id} value={item.id}>
              {position + 1} · {recordingName(item, assets)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="icon-button"
        aria-label="Delete selected music clip"
        aria-describedby={single ? reasonId : undefined}
        title={single ? deleteReason : 'Delete this music clip · Undo restores it'}
        disabled={blocked || single}
        onClick={remove}
      >
        <Icon name="trash" size={15} />
        {single && (
          <span className="sr-only" id={reasonId}>
            {deleteReason}
          </span>
        )}
      </button>
      <RecordingPicker
        label="Add music clip"
        text="Clip"
        itemLabel={(asset) => `Add ${asset.name} as a clip of music track ${index + 1}`}
        ready={ready}
        reason={addReason}
        disabled={blocked}
        onPick={add}
      />
    </div>
  );
}

/** The selected clip's recording, beats, length and loop. */
function MusicClipSettings({
  project,
  lane,
  clip,
  assets,
  ready,
  active,
  busy,
  drafting,
  onEdit,
  onSeek,
}: Readonly<{
  project: ProjectDocument;
  lane: MusicLane;
  clip: MusicClip;
  assets: readonly AudioAsset[];
  ready: readonly AudioAsset[];
  active: boolean;
  busy: boolean;
  drafting: boolean;
  onEdit: Props['onEdit'];
  onSeek: Props['onSeek'];
}>) {
  const asset = assets.find((item) => item.id === clip.mediaId);
  const source = musicTracks([lane]).find((item) => item.id === clip.id)!;
  const videoDuration = videoTimelineDuration(project);
  const update = (settings: Partial<Omit<MusicClip, 'id'>>): void => {
    if (active && !drafting) onEdit(musicClipEdit(project, clip.id, settings));
  };
  return (
    <div hidden={!active} data-music-clip-id={clip.id}>
      <label className="speed-field music-recording-row">
        <span>Recording</span>
        <select
          aria-label="Music recording"
          disabled={busy || drafting}
          title="Change the recording this music clip plays"
          value={clip.mediaId}
          onChange={(event) => {
            const next = ready.find((item) => item.id === event.target.value);
            // The clip keeps its place and length, limited by the new recording unless it loops.
            if (next)
              update({
                mediaId: next.id,
                sourceIn: 0,
                sourceOut: next.metadata.frameCount,
                duration: clip.loop ? clip.duration : Math.min(clip.duration, next.metadata.frameCount),
              });
          }}
        >
          {!asset && <option value={clip.mediaId}>Unavailable recording</option>}
          {assets.map((item) => (
            <option key={item.id} disabled={item.status !== 'ready'} value={item.id}>
              {item.name} · {durationLabel(item.metadata.durationSeconds)}
              {item.status === 'ready' ? '' : ` (${item.status})`}
            </option>
          ))}
        </select>
      </label>
      <MusicAnalysisStatus asset={asset} music={source} onSeek={onSeek} />
      <div className="music-track-overview">
        <span>{sourceSeconds(clip.duration)} on timeline</span>
        {lane.clips.length === 1 && (
          <button
            className="text-button"
            disabled={drafting || !videoDuration}
            title={
              videoDuration
                ? 'Start this music at frame 0 and fit it to the last video clip OUT, limited by its range unless Loop is enabled. Other music tracks stay unchanged.'
                : 'Add a video clip before fitting music to video duration.'
            }
            onClick={() =>
              update({
                start: 0,
                duration: clip.loop ? videoDuration : Math.min(videoDuration, clip.sourceOut - clip.sourceIn),
              })
            }
          >
            Fit to video duration
          </button>
        )}
      </div>
      <label className="music-loop">
        <input
          type="checkbox"
          aria-label="Loop music"
          checked={clip.loop}
          disabled={drafting}
          onChange={(event) => update({ loop: event.target.checked })}
        />
        <span>Loop selected range</span>
      </label>
    </div>
  );
}

/** The selected clip's source range and placement. */
function MusicClipTiming({
  project,
  lane,
  clip,
  position,
  asset,
  active,
  drafting,
  helpId,
  onEdit,
}: Readonly<{
  project: ProjectDocument;
  lane: MusicLane;
  clip: MusicClip;
  position: number;
  asset: AudioAsset | undefined;
  active: boolean;
  drafting: boolean;
  helpId: string;
  onEdit: Props['onEdit'];
}>) {
  const reasonId = useId();
  const source = musicTracks([lane]).find((item) => item.id === clip.id)!;
  const inputContext = `${project.id}:${clip.id}:${clip.mediaId}`;
  const update = (settings: Partial<Omit<MusicClip, 'id'>>): void => {
    if (active && !drafting) onEdit(musicClipEdit(project, clip.id, settings));
  };
  const settingError = (settings: Partial<Omit<MusicClip, 'id'>>): string | null => {
    if (!asset) return 'The registered music recording is unavailable. Restore it before editing this clip.';
    if ((settings.sourceOut ?? clip.sourceOut) > asset.metadata.frameCount)
      return 'Music range exceeds the registered original.';
    return editError(project, () => musicClipEdit(project, clip.id, settings));
  };
  const sourceRangeError = (sourceIn: number, sourceOut: number): string | null =>
    !clip.loop && clip.duration > sourceOut - sourceIn
      ? `Keep at least ${clip.duration} source frames, shorten Duration, or enable Loop music first.`
      : settingError({ sourceIn, sourceOut });
  // Later clips of a Ripple track follow the first one, like video clips.
  const startReason =
    lane.ripple && position > 0
      ? 'On a Ripple music track this clip follows the previous one: drag it to reorder, or turn Ripple off.'
      : '';
  return (
    <div hidden={!active} data-music-clip-timing-id={clip.id}>
      <div className="range-fields">
        <label>
          Source IN
          <NumberField
            aria-label="Music source IN"
            aria-describedby={helpId}
            min={0}
            max={clip.sourceOut - 1}
            integer
            step={1}
            value={clip.sourceIn}
            disabled={drafting}
            resetKey={inputContext}
            validate={(value) => sourceRangeError(value, clip.sourceOut)}
            onCommit={(sourceIn) => update({ sourceIn })}
          />
        </label>
        <label>
          Source OUT
          <NumberField
            aria-label="Music source OUT"
            aria-describedby={helpId}
            min={clip.sourceIn + 1}
            max={Math.min(asset?.metadata.frameCount ?? MAX_FRAME, MAX_FRAME)}
            integer
            step={1}
            value={clip.sourceOut}
            disabled={drafting}
            resetKey={inputContext}
            validate={(value) => sourceRangeError(clip.sourceIn, value)}
            onCommit={(sourceOut) => update({ sourceOut })}
          />
        </label>
      </div>
      <div className="range-fields">
        <label title={startReason || undefined}>
          Timeline start
          <NumberField
            aria-label="Music timeline start"
            aria-describedby={startReason ? reasonId : helpId}
            min={0}
            max={MAX_FRAME - clip.duration}
            integer
            step={1}
            value={clip.start}
            disabled={drafting || Boolean(startReason)}
            resetKey={inputContext}
            validate={(start) => settingError({ start })}
            onCommit={(start) => update({ start })}
          />
          {startReason && (
            <span className="sr-only" id={reasonId}>
              {startReason}
            </span>
          )}
        </label>
        <label>
          Duration · frames
          <NumberField
            aria-label="Music duration"
            aria-describedby={helpId}
            min={Math.max(1, source.fadeIn + source.fadeOut)}
            max={Math.min(MAX_FRAME - clip.start, clip.loop ? MAX_FRAME : clip.sourceOut - clip.sourceIn)}
            integer
            step={1}
            value={clip.duration}
            disabled={drafting}
            resetKey={inputContext}
            validate={(duration) => settingError({ duration })}
            onCommit={(duration) => update({ duration })}
          />
        </label>
      </div>
    </div>
  );
}

/** One boundary between clips: Cut, Crossfade or Fade through silence, with its length. */
function MusicTransitionRow({
  project,
  lane,
  transition,
  position,
  active,
  drafting,
  onEdit,
}: Readonly<{
  project: ProjectDocument;
  lane: MusicLane;
  transition: MusicTransition;
  position: number;
  active: boolean;
  drafting: boolean;
  onEdit: Props['onEdit'];
}>) {
  const errorId = useId();
  const [error, setError] = useState('');
  const edit = (type: MusicTransitionType, duration: number, pause = 0): MusicEdit =>
    musicLaneEdit(project, lane.id, (current) => setMusicTransition(current, position, type, duration, pause));
  const resetKey = `${project.id}:${transition.leftId}:${transition.rightId}:${transition.type}`;
  const choose = (type: MusicTransitionType): void => {
    // Switching type keeps the visible fade length where both types have one.
    let span = DEFAULT_TRANSITION_FRAMES;
    if (transition.type === 'fade-silence-pause') span = 2 * transition.fade;
    else if (transition.type !== 'cut') span = transition.duration;
    const duration = type === 'fade-silence-pause' ? Math.ceil(span / 2) : span;
    const pause = type === 'fade-silence-pause' ? DEFAULT_PAUSE_FRAMES : 0;
    const message = editError(project, () => edit(type, duration, pause));
    setError(message ?? '');
    if (!message && active && !drafting) onEdit(edit(type, duration, pause));
  };
  const name = `after clip ${position + 1}`;
  return (
    <li className="music-transition" data-music-transition-row={transition.leftId}>
      <div className="range-fields">
        <label>
          Clip {position + 1} → {position + 2}
          <select
            aria-label={`Music transition ${name}`}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            value={transition.type}
            disabled={drafting}
            onChange={(event) => choose(event.target.value as MusicTransitionType)}
          >
            {Object.entries(TRANSITION_NAMES).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {(transition.type === 'crossfade' || transition.type === 'fade-through-silence') && (
          <label>
            Duration · frames
            <NumberField
              aria-label={`Music transition duration ${name}`}
              min={transition.type === 'fade-through-silence' ? 2 : 1}
              max={MAX_FRAME}
              integer
              step={1}
              value={transition.duration}
              disabled={drafting}
              resetKey={resetKey}
              validate={(duration) => editError(project, () => edit(transition.type, duration))}
              onCommit={(duration) => {
                if (active && !drafting) onEdit(edit(transition.type, duration));
              }}
            />
          </label>
        )}
      </div>
      {transition.type === 'fade-silence-pause' && (
        <div className="range-fields">
          <label>
            Fade · frames
            <NumberField
              aria-label={`Music transition fade ${name}`}
              min={1}
              max={MAX_FRAME}
              integer
              step={1}
              value={transition.fade}
              disabled={drafting}
              resetKey={resetKey}
              validate={(fade) => editError(project, () => edit(transition.type, fade, transition.pause))}
              onCommit={(fade) => {
                if (active && !drafting) onEdit(edit(transition.type, fade, transition.pause));
              }}
            />
          </label>
          <label>
            Pause · frames
            <NumberField
              aria-label={`Music transition pause ${name}`}
              min={1}
              max={MAX_FRAME}
              integer
              step={1}
              value={transition.pause}
              disabled={drafting}
              resetKey={resetKey}
              validate={(pause) => editError(project, () => edit(transition.type, transition.fade, pause))}
              onCommit={(pause) => {
                if (active && !drafting) onEdit(edit(transition.type, transition.fade, pause));
              }}
            />
          </label>
        </div>
      )}
      {error && (
        <span className="number-field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </li>
  );
}
