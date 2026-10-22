import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { KEYFRAME_SETTINGS, keySettings } from '../shared/keyframes.js';
import { resolveMediaSelection, type MediaSelections } from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import {
  createClip,
  createLayer,
  type MusicTransition,
  type ProjectDocument,
  type VideoClip,
} from '../shared/model.js';
import { insertMusicClip, musicClips, musicTracks, musicTransitionOffset } from '../shared/music-lanes.js';
import type { TimelineRange } from '../shared/rush-editing.js';
import { snapFrame, snapPoints, type BeatSnap } from '../shared/snap.js';
import { trimOnTimeline, type TrimEdge } from '../shared/source-range.js';
import { spatialKeyChannels } from '../shared/spatial.js';
import { clipDuration } from '../shared/speed.js';
import { calculateLayout, transitionOffset, type PlacedClip } from '../shared/timeline.js';
import { formatTimecode, framesToSeconds, secondsToFrames } from '../shared/timing.js';
import { clipKeyframeMarkers, type ClipKeyframeMarker } from './clip-keyframe-markers.js';
import { clipKeyframeKind, clipKeyframeSlideTarget, type ClipKeyframeTarget } from './clip-keyframe-drag.js';
import type { InspectorSectionTarget } from './InspectorSection.js';
import { SPATIAL_CONTROLS } from './spatial-editor.js';
import './clip-keyframe-markers.css';
import {
  CLIP_DRAG_TYPE,
  durationLabel,
  MEDIA_DRAG_TYPE,
  MUSIC_DRAG_TYPE,
  shortName,
  sourceSeconds,
} from './display.js';
import { Icon } from './icons.js';
import { keyframeNavigationFrame, useKeyframeNavigation } from './keyframe-navigation.js';
import {
  KeyframeMarkers,
  useKeyframeSlide,
  type KeyframeSlide,
  type KeyframeSlideDraft,
  type KeyframeSlideTarget,
} from './keyframe-slide.js';
import { ClipContextMenu, type ClipMenuAnchor } from './ClipContextMenu.js';
import { nextLayerName } from './move-to-track.js';
import './editor-panels.css';
import './layers.css';
import { Layers } from './Layers.js';
import { createMusicClip, createMusicLane, musicEditError, musicLaneEdit, videoTimelineDuration } from './music-ui.js';
import { MusicTimeline, type MusicTimelineGesture } from './MusicTimeline.js';
import { RulerRange, RushEditBar, TimelineCutOverlay } from './RushEditBar.js';
import { useRulerRange } from './ruler-range.js';
import { adjacentBookmark, bookmarkKind, bookmarkTargets, rangeBookmarkCommands } from './timeline-bookmarks.js';
import { BeatSnapControl, RulerBeats, useBeatSnap } from './timeline-beats.js';
import './timeline-bookmarks.css';
import { trackKeyframeKind, transformKeyframeKind } from './timeline-keyframes.js';
import { planTimelineDrop, type DropPlan, type TimelinePayload } from './timeline-placement.js';
import {
  LANE_HEIGHT,
  LANE_OFFSET,
  MUSIC_LANE_HEIGHT,
  musicLanesTop,
  TIMELINE_RULER_HEIGHT,
  timelineLayerAt,
  timelineRows,
} from './timeline-rows.js';

export interface DraftPreview {
  document: ProjectDocument;
  frame: number;
}
/** Zoom out stops here, or lower while the whole timeline extent still needs a smaller scale to fit. */
const ZOOM_MIN = 12;
const ZOOM_MAX = 180;
const ZOOM_FACTOR = 1.25;
/** Space kept right of the last point, so Fit leaves it fully visible without a scrollbar. */
const TRAILING_MIN = 96;
const TICK_STEPS = [10, 30, 60, 300, 600, 1800, 3600, 36000];

/** Seconds between ruler labels, keeping labels at least 120 px apart below 24 px/s at any zoom. */
function rulerTickStep(pixelsPerSecond: number): number {
  if (pixelsPerSecond >= 60) return 1;
  if (pixelsPerSecond >= 24) return 5;
  const listed = TICK_STEPS.find((step) => step * pixelsPerSecond >= 120);
  if (listed) return listed;
  let step = TICK_STEPS.at(-1)!;
  while (step * pixelsPerSecond < 120) step *= 10;
  return step;
}
interface Props {
  project: ProjectDocument;
  assets: MediaAsset[];
  audioAssets: AudioAsset[];
  selectedClipId: string | null;
  /** Every selected clip once two or more are selected, the primary one included. */
  selectedClipIds: readonly string[];
  onToggleClip: (id: string) => void;
  onSelectTrackClips: (layerId: string) => void;
  selectedLayerId: string;
  onSelectLayer: (id: string) => void;
  selectedMusicId: string | null;
  onSelectMusic: (id: string) => void;
  /** Opens the transition after this music clip in Audio. */
  onMusicBoundary: (leftClipId: string) => void;
  selectedBoundaryId: string | null;
  frame: number;
  onSelect: (id: string) => void;
  onBoundary: (leftId: string) => void;
  onSeek: (frame: number) => void;
  onOpenSection: (section: InspectorSectionTarget) => void;
  onPause: () => void;
  onEdit: (command: EditCommand | readonly EditCommand[]) => void;
  onInsert: (mediaIds: string[], index: number, layerId: string, start: number) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onError: (message: string) => void;
  onSplit: () => void;
  onDelete: () => void;
  fitRequest: number;
  draggedMediaIds: readonly string[] | null;
  ranges: MediaSelections;
  onDuplicate: () => void;
  onQuickTrim: (edge: TrimEdge) => void;
  timeRange: TimelineRange | null;
  onTimeRange: (range: TimelineRange | null) => void;
  onCutRange: () => void;
  /** Ruler range or playhead drag starts (true) and ends (false). */
  onScrub?: (active: boolean) => void;
  revealRequest: number;
}
interface TrimDrag {
  pointerId: number;
  clip: VideoClip;
  sourceFrameCount: number;
  edge: TrimEdge;
  base: ProjectDocument;
  startX: number;
  startScroll: number;
  scale: number;
  leading: number;
  width: number;
  command: Extract<EditCommand, { type: 'trim' | 'trim-place' }> | null;
  candidate: ProjectDocument;
  error: string;
  moved: boolean;
  playhead: number;
  originShift: number;
  spacePending: boolean;
}
interface MoveContext {
  payload: TimelinePayload;
  scale: number;
  leading: number;
  width: number;
  base: ProjectDocument;
  playhead: number;
}

const CLIP_STATES = [
  ['selected', 'selected'],
  ['grouped', 'grouped'],
  ['activeLayer', 'active-layer'],
  ['disabledLayer', 'disabled-layer'],
  ['transformAnimated', 'transform-animated'],
  ['moving', 'moving'],
] as const;

function clipClassName(state: Readonly<Record<(typeof CLIP_STATES)[number][0], boolean>>): string {
  return ['timeline-clip', ...CLIP_STATES.filter(([key]) => state[key]).map(([, name]) => name)].join(' ');
}

function movingClipIds(payload: TimelinePayload | undefined): readonly string[] {
  if (payload?.kind === 'group') return payload.clipIds;
  return payload?.kind === 'clip' ? [payload.clipId] : [];
}

/** The last frame a drop ghost reaches, so the timeline can widen to show it. */
function dropExtent(plan: DropPlan | null): number {
  if (!plan) return 0;
  return Math.max(plan.start + plan.duration, ...(plan.ghosts ?? []).map((ghost) => ghost.start + ghost.duration));
}

function dropLabel(plan: DropPlan): string {
  if (plan.error) return 'Placement cannot fit';
  if (plan.ghosts) return `Move ${plan.ghosts.length} clips`;
  if (plan.mode === 'ripple') return 'Ripple insert';
  return plan.guide === null ? 'Move' : 'Snap';
}

function interactionMessage(
  error: string,
  plan: DropPlan | null,
  draft: ProjectDocument | null,
  selected: VideoClip | undefined,
): string {
  if (error) return error;
  if (plan?.error) return plan.error;
  if (plan) return `${dropLabel(plan)} · ${formatTimecode(plan.start)} · Alt bypasses snapping · Esc cancels`;
  if (draft && selected)
    return `${formatTimecode(selected.sourceIn)} → ${formatTimecode(selected.sourceOut)} · release to apply · Esc to cancel`;
  return '';
}

function timelineInteractionMessage(
  {
    keyframe,
    transform,
    speed,
    bookmark,
  }: {
    keyframe: KeyframeSlideDraft<KeyframeSlideTarget> | null;
    transform: KeyframeSlideDraft<KeyframeSlideTarget> | null;
    speed: KeyframeSlideDraft<ClipKeyframeTarget> | null;
    bookmark: KeyframeSlideDraft<KeyframeSlideTarget> | null;
  },
  error: string,
  plan: DropPlan | null,
  draft: ProjectDocument | null,
  selected: VideoClip | undefined,
): string {
  if (bookmark)
    return bookmark.error || `Bookmark · ${formatTimecode(bookmark.frame)} · release to apply · Esc cancels`;
  if (speed) return speed.error || `Speed keyframe · source frame ${speed.frame} · release to apply · Esc cancels`;
  if (transform)
    return (
      transform.error ||
      `Transform keyframe · ${formatTimecode(transform.frame)} · all its settings move together · release to apply · Esc cancels`
    );
  if (keyframe)
    return (
      keyframe.error ||
      `Track keyframe · ${formatTimecode(keyframe.frame)} · all animated settings move together · release to apply · Esc cancels`
    );
  return interactionMessage(error, plan, draft, selected);
}

/** Timeline-direction trim steps: positive moves the edge right. A reversed clip shows source OUT at its left. */
function keyboardTrimDelta(key: string, shift: boolean, clip: VideoClip, edge: TrimEdge, count: number): number | null {
  const head = clip.reverse ? count - clip.sourceOut : clip.sourceIn;
  const tail = clip.reverse ? clip.sourceIn : count - clip.sourceOut;
  const shrink = clip.sourceOut - 1 - clip.sourceIn;
  switch (key) {
    case 'ArrowLeft':
      return shift ? -10 : -1;
    case 'ArrowRight':
      return shift ? 10 : 1;
    case 'Home':
      return edge === 'in' ? -head : -shrink;
    case 'End':
      return edge === 'out' ? tail : shrink;
    default:
      return null;
  }
}

/** Output frames of omitted footage beyond the clip's left edge (after OUT when reversed). */
function recoverableHead(placed: PlacedClip | undefined, frameCount: number | undefined): number {
  if (!placed || frameCount === undefined) return 0;
  const restored = placed.clip.reverse ? { sourceOut: frameCount } : { sourceIn: 0 };
  return clipDuration({ ...placed.clip, ...restored }) - placed.duration;
}
/** Output frames of omitted footage beyond the clip's right edge (before IN when reversed). */
function recoverableTail(placed: PlacedClip, frameCount: number): number {
  const restored = placed.clip.reverse ? { sourceIn: 0 } : { sourceOut: frameCount };
  return clipDuration({ ...placed.clip, ...restored }) - placed.duration;
}

/** A trim handle reports the source endpoint it edits: OUT at the left edge of a reversed clip. */
function trimHandleValue(
  clip: VideoClip,
  edge: TrimEdge,
  frameCount = clip.sourceOut,
): { min: number; max: number; now: number } {
  if (clip.reverse === (edge === 'in')) return { min: clip.sourceIn + 1, max: frameCount, now: clip.sourceOut };
  return { min: 0, max: clip.sourceOut - 1, now: clip.sourceIn };
}

const FILMSTRIP_TILE_PIXELS = 116;
const FILMSTRIP_MAX_TILES = 60;

/** One tile per ~16:9 slot of the clip, each showing the prepared snapshot nearest the source frame it covers. */
function filmstrip(
  asset: MediaAsset | undefined,
  placed: PlacedClip,
  widthPixels: number,
): { frame: number; src: string }[] {
  const snapshots = asset?.prepared?.thumbnailFrames;
  if (!asset || !snapshots) return [];
  const tiles = Math.min(
    FILMSTRIP_MAX_TILES,
    placed.duration,
    Math.max(1, Math.round(widthPixels / FILMSTRIP_TILE_PIXELS)),
  );
  return Array.from({ length: tiles }, (_, tile) => {
    const frame = Math.floor(((tile + 0.5) / tiles) * placed.duration);
    const shown = placed.retiming.sourceAt(frame);
    let nearest = snapshots[0]!;
    for (const candidate of snapshots) {
      if (Math.abs(candidate - shown) < Math.abs(nearest - shown)) nearest = candidate;
    }
    return { frame, src: `/api/media/${asset.id}/thumbnail/${nearest}` };
  });
}

function speedLabel(clip: VideoClip): string {
  const direction = clip.reverse ? ' · reverse' : '';
  if (clip.speed.mode === 'curve') return ` · curve${direction}`;
  return (clip.speed.rate === 1 ? '' : ` · ${clip.speed.rate}×`) + direction;
}

function timelineEmptyMessage(project: ProjectDocument): string {
  return project.music.length
    ? 'No video clips · music plays over black. Add recordings from Media.'
    : 'Drop recordings here, or add them from Media.';
}

function timelineInteractionBlocked(
  draft: ProjectDocument | null,
  keyframeDrag: boolean,
  unavailable: boolean,
): boolean {
  return draft !== null || keyframeDrag || unavailable;
}

function timelineSurfaceClassName(error: string, draft: ProjectDocument | null, keyframeDrag: boolean): string {
  const classes = ['timeline-surface'];
  if (error) classes.push('invalid-trim');
  if (draft) classes.push('trim-drafting');
  if (keyframeDrag) classes.push('keyframe-drafting');
  return classes.join(' ');
}

function timelineMusicExtent(project: ProjectDocument, gesture: MusicTimelineGesture | null): number {
  return Math.max(
    0,
    ...musicClips((gesture?.document ?? project).music).map((clip) => clip.start + clip.duration),
    gesture ? gesture.start + gesture.duration : 0,
  );
}

function timelineMusicHeight(project: ProjectDocument): number {
  return project.music.length ? project.music.length * MUSIC_LANE_HEIGHT : 55;
}

/**
 * A ready music file dropped on a music track becomes a clip of that track at the drop frame (a Ripple
 * track takes it at the nearest place in its sequence); dropped on the empty music area it starts a track.
 */
function musicDrop(
  props: Readonly<
    Pick<Props, 'project' | 'audioAssets' | 'onEdit' | 'onError'> & {
      leading: number;
      scale: number;
      disabled: boolean;
      laneId: string | null;
    }
  >,
) {
  const accepts = (event: DragEvent<HTMLDivElement>): boolean =>
    !props.disabled && Array.from(event.dataTransfer.types).includes(MUSIC_DRAG_TYPE);
  return {
    onDragOver: (event: DragEvent<HTMLDivElement>): void => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (event: DragEvent<HTMLDivElement>): void => {
      if (!accepts(event)) return;
      event.preventDefault();
      const asset = props.audioAssets.find((item) => item.id === event.dataTransfer.getData(MUSIC_DRAG_TYPE));
      if (asset?.status !== 'ready') return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const start = Math.max(0, Math.round((event.clientX - bounds.left - props.leading) / props.scale));
      try {
        if (props.laneId === null) {
          const lane = createMusicLane(
            crypto.randomUUID(),
            crypto.randomUUID(),
            asset,
            videoTimelineDuration(props.project),
          );
          const clip = { ...lane.clips[0]!, start };
          props.onEdit({ type: 'music', music: [...props.project.music, { ...lane, clips: [clip] }] });
          return;
        }
        const clip = createMusicClip(crypto.randomUUID(), asset, start);
        props.onEdit(musicLaneEdit(props.project, props.laneId, (lane) => insertMusicClip(lane, clip)));
      } catch (cause) {
        props.onError(musicEditError(cause, 'This music cannot be added here.'));
      }
    },
  };
}

const MUSIC_TRANSITION_LABELS: Record<MusicTransition['type'], string> = {
  cut: 'Cut',
  crossfade: 'Crossfade',
  'fade-through-silence': 'Fade',
  'fade-silence-pause': 'Pause',
};

function TimelineMusicLanes(
  props: Readonly<
    Pick<
      Props,
      | 'project'
      | 'audioAssets'
      | 'selectedMusicId'
      | 'onSelectMusic'
      | 'onMusicBoundary'
      | 'frame'
      | 'onPause'
      | 'onEdit'
      | 'onPreview'
      | 'onError'
    > & {
      /** The document drawn: a music gesture's draft, else the project. */
      display: ProjectDocument;
      top: number;
      leading: number;
      scale: number;
      width: number;
      viewport: { current: HTMLDivElement | null };
      snapping: boolean;
      beats: BeatSnap;
      disabled: boolean;
      onGesture: (gesture: MusicTimelineGesture | null) => void;
    }
  >,
) {
  if (!props.display.music.length)
    return (
      <div className="music-lane-wrapper" style={{ top: props.top }} {...musicDrop({ ...props, laneId: null })}>
        <div className="music-track-empty">Drop music here or use Audio → Add music track</div>
      </div>
    );
  return props.display.music.map((lane, index) => {
    const sources = musicTracks([lane]);
    return (
      <div
        key={lane.id}
        className={`music-lane-wrapper music-instance-lane ${lane.clips.some((clip) => clip.id === props.selectedMusicId) ? 'selected' : ''}`}
        data-music-lane={lane.id}
        style={{ top: props.top + index * MUSIC_LANE_HEIGHT }}
        {...musicDrop({ ...props, laneId: lane.id })}
      >
        {sources.map((music, clipIndex) => (
          <MusicTimeline
            key={music.id}
            project={props.project}
            music={music}
            index={index}
            clipIndex={clipIndex}
            clipCount={lane.clips.length}
            selected={music.id === props.selectedMusicId}
            asset={props.audioAssets.find((asset) => asset.id === music.mediaId)}
            leading={props.leading}
            scale={props.scale}
            width={props.width}
            viewport={props.viewport}
            frame={props.frame}
            snapping={props.snapping}
            beats={props.beats}
            disabled={props.disabled}
            onSelect={props.onSelectMusic}
            onPause={props.onPause}
            onEdit={props.onEdit}
            onPreview={props.onPreview}
            onGesture={props.onGesture}
            onError={props.onError}
          />
        ))}
        {lane.transitions.map((transition, position) => {
          const left = lane.clips[position]!;
          const end = left.start + left.duration;
          // A crossfade's button sits in the middle of its overlap, a pause's in its slot, the others on the boundary.
          const offset = musicTransitionOffset(transition);
          const at = offset === 0 ? end : end + offset / 2;
          const label = MUSIC_TRANSITION_LABELS[transition.type];
          return (
            <Fragment key={`${transition.leftId}-${transition.rightId}`}>
              {transition.type === 'fade-silence-pause' && (
                <div
                  className="music-transition-slot"
                  aria-hidden="true"
                  style={{ left: props.leading + end * props.scale, width: transition.pause * props.scale }}
                />
              )}
              <button
                type="button"
                className="boundary-button music-boundary"
                data-music-transition={transition.leftId}
                disabled={props.disabled}
                style={{ left: props.leading + at * props.scale }}
                aria-label={`Transition after clip ${position + 1} on music track ${index + 1}`}
                title={`${label} on music track ${index + 1} · edit this boundary in Audio`}
                onClick={() => props.onMusicBoundary(transition.leftId)}
              >
                {label}
              </button>
            </Fragment>
          );
        })}
      </div>
    );
  });
}

/** What the Bookmark button does: bookmark the selected range's ends, else toggle one at the playhead. */
function bookmarkAction(project: ProjectDocument, frame: number, duration: number, range: TimelineRange | null) {
  const rangeCommands = range ? rangeBookmarkCommands(project.bookmarks, range) : [];
  const deleting = !range && project.bookmarks.includes(frame);
  let label = 'Add bookmark at playhead';
  let title = 'Add a bookmark at the playhead; edits snap to it · M';
  let commands: EditCommand[] = [{ type: 'bookmark-add', frame }];
  let blocked = !duration;
  if (range) {
    label = 'Add bookmarks at range ends';
    title = rangeCommands.length
      ? 'Add bookmarks at the start and end of the selected range · M'
      : 'The selected range already has bookmarks at both ends';
    commands = rangeCommands;
    blocked ||= !rangeCommands.length;
  } else if (deleting) {
    label = 'Delete bookmark at playhead';
    title = `Delete the bookmark at ${formatTimecode(frame)}`;
    commands = [{ type: 'bookmark-remove', frame }];
  }
  if (!duration) title = 'Add footage or music before adding a bookmark.';
  return { label, title, commands, blocked, deleting };
}

/** Adds a bookmark at the playhead, or deletes the one already there, between Previous/Next bookmark. */
function BookmarkButton(
  props: Readonly<{
    project: ProjectDocument;
    frame: number;
    duration: number;
    disabled: boolean;
    timeRange: TimelineRange | null;
    onEdit: (command: EditCommand | readonly EditCommand[]) => void;
    onSeek: (frame: number) => void;
  }>,
) {
  const action = bookmarkAction(props.project, props.frame, props.duration, props.timeRange);
  const previous = adjacentBookmark(props.project.bookmarks, props.frame, props.duration, -1);
  const next = adjacentBookmark(props.project.bookmarks, props.frame, props.duration, 1);
  return (
    <fieldset className="timeline-bookmark-actions rush-quick-actions">
      <legend className="sr-only">Bookmarks</legend>
      <button
        type="button"
        className="icon-button"
        aria-label="Previous bookmark"
        title={previous === null ? 'No bookmark before the playhead' : 'Go to the previous bookmark · Shift+↑'}
        disabled={props.disabled || previous === null}
        onClick={() => previous !== null && props.onSeek(previous)}
      >
        <Icon name="back" size={14} />
      </button>
      <button
        type="button"
        className={`secondary-button small timeline-view-action timeline-bookmark-action ${action.deleting ? 'active' : ''} ${props.timeRange ? 'range-accent' : ''}`}
        aria-label={action.label}
        title={action.title}
        disabled={props.disabled || action.blocked}
        onClick={() => props.onEdit(action.commands)}
      >
        <Icon name={action.deleting ? 'trash' : 'bookmark'} size={15} />
        <span className="timeline-action-label">Bookmark</span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Next bookmark"
        title={next === null ? 'No bookmark after the playhead' : 'Go to the next bookmark · Shift+↓'}
        disabled={props.disabled || next === null}
        onClick={() => next !== null && props.onSeek(next)}
      >
        <Icon name="forward" size={14} />
      </button>
    </fieldset>
  );
}

type ClipMarkerProps = Readonly<{
  placed: PlacedClip;
  name: string;
  blocked: () => boolean;
  speeds: KeyframeSlide<ClipKeyframeTarget>;
}>;

function clipMarkerView(props: ClipMarkerProps, marker: ClipKeyframeMarker, sourceFrame: number, at: number | null) {
  const displayedSource = props.placed.retiming.sourceAt(marker.seekFrame - props.placed.start);
  const speedKey =
    props.placed.clip.speed.mode === 'curve'
      ? props.placed.clip.speed.keyframes.find((key) => key.frame === marker.sourceFrame)
      : undefined;
  const titleSuffix = speedKey ? ` · ${speedKey.rate}×` : '';
  const output =
    at === null ? marker.outputFrame : Math.max(0, Math.min(props.placed.duration, at - props.placed.start));
  return {
    className: `timeline-clip-key ${marker.type}`,
    'data-clip-keyframe': marker.type,
    'data-source-frame': sourceFrame,
    'data-timeline-frame': marker.timelineFrame,
    'data-seek-frame': marker.seekFrame,
    'aria-label': `Speed keyframe source ${sourceFrame} on clip ${props.placed.clip.id}, ${props.name}`,
    title: `Speed · source frame ${sourceFrame}${titleSuffix} · timeline frame ${marker.timelineFrame} (${formatTimecode(marker.timelineFrame)}) · Preview source ${displayedSource} at timeline frame ${marker.seekFrame} · Drag to move; Arrow keys: 1 source frame, Shift: 10`,
    style: { '--clip-keyframe-position': `${(output / props.placed.duration) * 100}%` } as CSSProperties,
    children: (
      <span aria-hidden="true" className="keyframe-glyph circle">
        ●
      </span>
    ),
  };
}

/** Custom-speed keys slide like shared track keys. */
function ClipKeyframeMarkers(props: ClipMarkerProps) {
  const markers = clipKeyframeMarkers(props.placed);
  if (!markers.length) return null;
  return (
    <div className="clip-keyframe-markers">
      <KeyframeMarkers
        slide={props.speeds}
        targets={markers.map((marker) => clipKeyframeSlideTarget(props.placed, marker))}
        blocked={props.blocked}
        view={({ marker }, state) => clipMarkerView(props, marker, state.frame, state.at)}
      />
    </div>
  );
}

export function Timeline(props: Readonly<Props>) {
  const {
    project,
    assets,
    audioAssets,
    selectedClipId,
    selectedClipIds,
    onToggleClip,
    selectedLayerId,
    onSelectLayer,
    selectedMusicId,
    onSelectMusic,
    onMusicBoundary,
    selectedBoundaryId,
    frame,
    onSelect,
    onBoundary,
    onSeek,
    onPause,
    onEdit,
    onInsert,
    onPreview,
    onError,
    onSplit,
    onDelete,
    fitRequest,
    draggedMediaIds,
    ranges,
    onDuplicate,
    onScrub,
  } = props;
  const [snapping, setSnapping] = useState(true);
  const beatSnap = useBeatSnap(audioAssets, snapping);
  const beats = beatSnap.beats;
  const [clipMenu, setClipMenu] = useState<ClipMenuAnchor | null>(null);
  const closeClipMenu = useCallback((restoreFocus: boolean): void => {
    setClipMenu(null);
    if (restoreFocus) document.querySelector<HTMLElement>('.timeline-clip.selected .timeline-clip-body')?.focus();
  }, []);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const bypassSnap = useRef(false);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(48);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [draft, setDraft] = useState<ProjectDocument | null>(null);
  const [musicGesture, setMusicGesture] = useState<MusicTimelineGesture | null>(null);
  const [dragError, setDragError] = useState('');
  const [dropPlan, setDropPlan] = useState<DropPlan | null>(null);
  const [verticalScroll, setVerticalScroll] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<TrimDrag | null>(null);
  const movingClip = useRef(false);
  const movement = useRef<MoveContext | null>(null);
  const dropScroll = useRef(0);
  const dropPointer = useRef<{ x: number; y: number; alt: boolean } | null>(null);
  const latestDrop = useRef<() => DropPlan | null>(() => null);
  const autoScroll = useRef(0);
  const pointerX = useRef(0);
  const latestMove = useRef<(clientX: number) => void>(() => {});
  const restoreScroll = useRef<number | null>(null);
  const musicRevealReady = useRef(false);
  const revealTarget = useRef<'video' | 'music'>('video');
  const keyframeNavigation = useKeyframeNavigation();
  const scale = framesToSeconds(1, project.frameRate) * pixelsPerSecond;
  const baseLayout = useMemo(() => calculateLayout(project), [project]);
  const baselineWidth = Math.max(viewportWidth, 32 + baseLayout.duration * scale + 96);
  const keyframes = useKeyframeSlide({
    kind: trackKeyframeKind({
      onSelectLayer,
      onSeekKeyframe: keyframeNavigation.onSeekKeyframe,
      onOpenSection: props.onOpenSection,
    }),
    project,
    frame,
    scale,
    width: baselineWidth,
    disabled: keyframeNavigation.disabled || musicGesture !== null,
    snapping,
    beats,
    viewport: scroll,
    onPause,
    onPreview,
    onEdit,
    onError,
  });
  const clipKindOptions = {
    frameCountOf: (mediaId: string) => assets.find((asset) => asset.id === mediaId)?.metadata.frameCount ?? 0,
    onSelect,
    onSeek,
  };
  const transformKeys = useKeyframeSlide({
    kind: transformKeyframeKind({ onSelectLayer, onSeek, onOpenSection: props.onOpenSection }),
    project,
    frame,
    scale,
    width: baselineWidth,
    disabled: keyframeNavigation.disabled || musicGesture !== null || keyframes.active,
    snapping,
    beats,
    viewport: scroll,
    onPause,
    onPreview,
    onEdit,
    onError,
  });
  const speedKeys = useKeyframeSlide({
    kind: clipKeyframeKind('speed', { ...clipKindOptions, onOpen: () => props.onOpenSection('speed') }),
    project,
    frame,
    scale,
    width: baselineWidth,
    disabled: keyframeNavigation.disabled || musicGesture !== null || keyframes.active || transformKeys.active,
    snapping,
    beats,
    viewport: scroll,
    onPause,
    onPreview,
    onEdit,
    onError,
  });
  const gestureActive = keyframes.active || transformKeys.active || speedKeys.active;
  const bookmarks = useKeyframeSlide({
    kind: bookmarkKind(onSeek),
    project,
    frame,
    scale,
    width: baselineWidth,
    disabled: keyframeNavigation.disabled || musicGesture !== null || gestureActive,
    snapping,
    beats,
    viewport: scroll,
    onPause,
    onPreview,
    onEdit,
    onError,
  });
  const slideActive = gestureActive || bookmarks.active;

  // Extra recoverable head space exists only during a trim. Shift the scroll by
  // the identical amount before paint, so neither selection nor gesture start
  // moves a frame under the pointer. Edge scrolling can then expose the full head.
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const active = drag.current;
    if (active?.spacePending) {
      active.spacePending = false;
      element.scrollLeft = active.startScroll;
    }
    if (restoreScroll.current !== null) {
      element.scrollLeft = restoreScroll.current;
      restoreScroll.current = null;
    }
  });

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewportWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(autoScroll.current);
      cancelAnimationFrame(dropScroll.current);
    };
  }, []);

  const cancelTrim = (): void => {
    const active = drag.current;
    if (!active) return;
    restoreScroll.current = Math.max(0, active.startScroll - active.originShift);
    drag.current = null;
    cancelAnimationFrame(autoScroll.current);
    setDraft(null);
    setDragError('');
    setSnapGuide(null);
    onPreview(null);
  };
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelTrim();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  });

  const visible =
    keyframes.draft?.document ??
    transformKeys.draft?.document ??
    speedKeys.draft?.document ??
    bookmarks.draft?.document ??
    draft ??
    musicGesture?.document ??
    project;
  const layout = useMemo(
    () => (visible === project ? baseLayout : calculateLayout(visible)),
    [visible, project, baseLayout],
  );
  const selected = layout.clips.find((placed) => placed.clip.id === selectedClipId);
  const source = assets.find((asset) => asset.id === selected?.clip.mediaId);
  // Reserve access to omitted head/tail footage, including the first/last clip.
  // Outward trimming must not require dragging beyond the edge of the browser.
  const availableHead = recoverableHead(selected, source?.metadata.frameCount);
  // Selection must not move frame zero beneath the mouse. The timeline origin
  // stays fixed; omitted source is still recoverable through handles/Home/End.
  const leading = drag.current?.leading ?? movement.current?.leading ?? musicGesture?.leading ?? 32;
  const unusedTail =
    source && selected ? recoverableTail(selected, source.metadata.frameCount) - (layout.duration - selected.end) : 0;
  const trailing = Math.max(TRAILING_MIN, unusedTail * scale + 24);
  const musicEnd = timelineMusicExtent(project, musicGesture);
  // Stored points after video or music OUT stay reachable, without extending the playable duration.
  const lastKeyframe = Math.max(
    0,
    ...project.layers.flatMap((layer) => [
      ...layer.keyframes.map((point) => point.frame),
      ...layer.transform.keyframes.map((point) => point.frame),
    ]),
    project.bookmarks.at(-1) ?? 0,
  );
  const storedExtent = Math.max(layout.duration, musicEnd, lastKeyframe);
  const width = Math.max(
    viewportWidth,
    leading +
      Math.max(
        storedExtent,
        dropExtent(dropPlan),
        keyframes.draft?.frame ?? 0,
        transformKeys.draft?.frame ?? 0,
        bookmarks.draft?.frame ?? 0,
      ) *
        scale +
      trailing,
    drag.current?.width ?? 0,
    movement.current?.width ?? 0,
    keyframes.draft?.width ?? 0,
    transformKeys.draft?.width ?? 0,
    speedKeys.draft?.width ?? 0,
    bookmarks.draft?.width ?? 0,
    musicGesture?.width ?? 0,
  );
  const interactionBlocked =
    musicGesture !== null || timelineInteractionBlocked(draft, slideActive, keyframeNavigation.disabled);
  const clipMarkerBlocked = (): boolean =>
    interactionBlocked ||
    drag.current !== null ||
    movingClip.current ||
    movement.current !== null ||
    draggedMediaIds !== null ||
    dropPlan !== null;
  const geometry = drag.current?.edge === 'in' ? calculateLayout(drag.current.base) : layout;
  const rows = timelineRows(project.layers);
  const rowTop = (layerId: string): number => rows.find((row) => row.layer.id === layerId)!.top;
  const selectedRowTop = rows.find((row) => row.layer.id === selectedLayerId)?.top;
  const musicTop = musicLanesTop(project.layers.length);
  const surfaceHeight = musicTop + timelineMusicHeight(project);
  const seconds = framesToSeconds(Math.max(layout.duration, baseLayout.duration), project.frameRate);
  const tickStep = rulerTickStep(pixelsPerSecond);
  const ticks = Array.from({ length: Math.floor(seconds / tickStep) + 1 }, (_, index) => index * tickStep);
  // The scale at which the whole stored extent, playable duration, music and later stored points, fills the viewport.
  const fitScale = storedExtent
    ? Math.max(0, viewportWidth - leading - TRAILING_MIN) / framesToSeconds(storedExtent, project.frameRate)
    : ZOOM_MAX;
  const zoomMin = Math.min(ZOOM_MIN, fitScale);
  const fitTimeline = (): void => {
    if (storedExtent && !drag.current && !slideActive && !musicGesture)
      setPixelsPerSecond(Math.min(ZOOM_MAX, fitScale));
  };
  const zoomBy = (factor: number): void =>
    setPixelsPerSecond(Math.max(zoomMin, Math.min(ZOOM_MAX, pixelsPerSecond * factor)));
  const latestFit = useRef(fitTimeline);
  latestFit.current = fitTimeline;
  useEffect(() => {
    if (fitRequest > 0) latestFit.current();
  }, [fitRequest]);
  // A panel resize must retain the last selected lane, not reveal an unrelated video row over music.
  useLayoutEffect(() => {
    revealTarget.current = 'video';
  }, [selectedLayerId, selectedClipId, props.revealRequest]);
  useLayoutEffect(() => {
    if (musicRevealReady.current) revealTarget.current = 'music';
    musicRevealReady.current = true;
  }, [selectedMusicId]);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (
      !element ||
      revealTarget.current !== 'video' ||
      selectedRowTop === undefined ||
      drag.current ||
      movingClip.current ||
      slideActive ||
      musicGesture
    )
      return;
    const top = selectedRowTop - LANE_OFFSET;
    if (top < element.scrollTop + TIMELINE_RULER_HEIGHT) element.scrollTop = Math.max(0, top - TIMELINE_RULER_HEIGHT);
    else if (top + LANE_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = top + LANE_HEIGHT - element.clientHeight;
  }, [selectedLayerId, selectedClipId, props.revealRequest, selectedRowTop, viewportHeight]);
  useEffect(() => {
    const element = scroll.current;
    if (!element || drag.current || movingClip.current || movement.current || slideActive || musicGesture) return;
    const placed = calculateLayout(project).clips.find((item) => item.clip.id === selectedClipId);
    if (!placed) return;
    const left = 32 + placed.start * scale;
    const right = 32 + placed.end * scale;
    if (left < element.scrollLeft + 20) element.scrollLeft = Math.max(0, left - 32);
    else if (left > element.scrollLeft + element.clientWidth - 60 || right < element.scrollLeft)
      element.scrollLeft = Math.max(0, left - element.clientWidth / 3);
  }, [selectedClipId, props.revealRequest, project.id]);
  useLayoutEffect(() => {
    const element = scroll.current;
    const index = project.music.findIndex((lane) => lane.clips.some((clip) => clip.id === selectedMusicId));
    if (
      !element ||
      revealTarget.current !== 'music' ||
      index < 0 ||
      musicGesture ||
      drag.current ||
      movingClip.current ||
      slideActive
    )
      return;
    const top = musicTop + index * MUSIC_LANE_HEIGHT;
    if (top < element.scrollTop + TIMELINE_RULER_HEIGHT) element.scrollTop = Math.max(0, top - TIMELINE_RULER_HEIGHT);
    else if (top + MUSIC_LANE_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, top + MUSIC_LANE_HEIGHT - element.clientHeight);
    const music = project.music[index]!.clips.find((clip) => clip.id === selectedMusicId)!;
    const left = leading + music.start * scale;
    if (left < element.scrollLeft + 20) element.scrollLeft = Math.max(0, left - 32);
    else if (left > element.scrollLeft + element.clientWidth - 60)
      element.scrollLeft = Math.max(0, left - element.clientWidth / 3);
  }, [selectedMusicId, viewportHeight]);
  const clearMove = (): void => {
    movingClip.current = false;
    movement.current = null;
    dropPointer.current = null;
    cancelAnimationFrame(dropScroll.current);
    dropScroll.current = 0;
    setDropPlan(null);
  };
  const scrollLayers = (top: number): void => {
    const element = scroll.current;
    if (!element) return;
    if (element.scrollTop !== top) element.scrollTop = top;
    setVerticalScroll(element.scrollTop);
  };
  useEffect(() => {
    if (!draggedMediaIds && movement.current?.payload.kind === 'media') clearMove();
  }, [draggedMediaIds]);

  const previewCandidate = (candidate: ProjectDocument, id: string, edge: TrimEdge): void => {
    const placed = calculateLayout(candidate).clips.find((item) => item.clip.id === id)!;
    onPreview({ document: candidate, frame: edge === 'in' ? placed.start : placed.end - 1 });
  };
  latestMove.current = (clientX): void => {
    const active = drag.current;
    if (!active || !scroll.current) return;
    let delta = Math.round((clientX - active.startX + scroll.current.scrollLeft - active.startScroll) / active.scale);
    if (snapping && !bypassSnap.current) {
      const placed = calculateLayout(active.base).clips.find((item) => item.clip.id === active.clip.id)!;
      const edge = active.edge === 'in' ? placed.start : placed.end;
      const targets = snapPoints(active.base, beats)
        .filter((point) => point !== edge)
        .concat([active.playhead]);
      const snapped = snapFrame(edge + delta, targets, 8 / active.scale);
      setSnapGuide(snapped !== edge + delta ? snapped : null);
      delta = snapped - edge;
    }
    try {
      const command = trimOnTimeline(
        active.base,
        active.clip.id,
        active.edge,
        delta,
        active.sourceFrameCount,
        'output',
      ) as Extract<EditCommand, { type: 'trim' | 'trim-place' }>;
      const candidate = applyCommand(active.base, command);
      active.command = command;
      active.candidate = candidate;
      active.error = '';
      active.moved =
        command.sourceIn !== active.clip.sourceIn ||
        command.sourceOut !== active.clip.sourceOut ||
        ('start' in command && command.start !== active.clip.start);
      setDraft(candidate);
      setDragError('');
      previewCandidate(candidate, active.clip.id, active.edge);
    } catch (error) {
      active.error = error instanceof Error ? error.message : 'Invalid trim';
      setDragError(active.error);
    }
  };
  const startAutoScroll = (): void => {
    const advance = (): void => {
      if (!drag.current || !scroll.current) return;
      const viewport = scroll.current.getBoundingClientRect();
      const left = pointerX.current - viewport.left;
      const right = viewport.right - pointerX.current;
      let velocity = 0;
      if (left < 28) velocity = -Math.min(14, (28 - left) / 3);
      if (right < 28) velocity = Math.min(14, (28 - right) / 3);
      if (velocity) {
        const previous = scroll.current.scrollLeft;
        scroll.current.scrollLeft += velocity;
        if (scroll.current.scrollLeft !== previous) latestMove.current(pointerX.current);
      }
      autoScroll.current = requestAnimationFrame(advance);
    };
    autoScroll.current = requestAnimationFrame(advance);
  };
  const beginTrim = (event: PointerEvent<HTMLButtonElement>, clip: VideoClip, edge: TrimEdge): void => {
    if (event.button !== 0 || interactionBlocked) return;
    const asset = assets.find((item) => item.id === clip.mediaId);
    if (!asset || !scroll.current) return;
    const placed = baseLayout.clips.find((item) => item.clip.id === clip.id)!;
    const head = recoverableHead(placed, asset.metadata.frameCount);
    const originShift = edge === 'in' ? Math.max(0, Math.ceil((head - placed.start) * scale)) : 0;
    event.preventDefault();
    event.stopPropagation();
    onPause();
    onSelect(clip.id);
    drag.current = {
      pointerId: event.pointerId,
      clip,
      edge,
      sourceFrameCount: asset.metadata.frameCount,
      base: project,
      startX: event.clientX,
      startScroll: scroll.current.scrollLeft + originShift,
      scale,
      leading: leading + originShift,
      width: width + originShift,
      command: null,
      candidate: project,
      error: '',
      moved: false,
      playhead: frame,
      originShift,
      spacePending: originShift > 0,
    };
    bypassSnap.current = event.altKey;
    pointerX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(project);
    previewCandidate(project, clip.id, edge);
    startAutoScroll();
  };
  const moveTrim = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerId !== drag.current?.pointerId) return;
    event.preventDefault();
    bypassSnap.current = event.altKey;
    pointerX.current = event.clientX;
    latestMove.current(event.clientX);
  };
  const finishTrim = (event: PointerEvent<HTMLButtonElement>): void => {
    const active = drag.current;
    if (event.pointerId !== active?.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    bypassSnap.current = event.altKey;
    latestMove.current(event.clientX);
    restoreScroll.current = Math.max(0, (scroll.current?.scrollLeft ?? 0) - active.originShift);
    drag.current = null;
    cancelAnimationFrame(autoScroll.current);
    setDraft(null);
    setDragError('');
    setSnapGuide(null);
    onPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.error) onError(active.error);
    else if (active.moved && active.command) onEdit(active.command);
  };
  const keyboardTrim = (event: KeyboardEvent<HTMLButtonElement>, clip: VideoClip, edge: TrimEdge): void => {
    if (interactionBlocked) return;
    const count = assets.find((asset) => asset.id === clip.mediaId)?.metadata.frameCount;
    if (!count) return;
    const delta = keyboardTrimDelta(event.key, event.shiftKey, clip, edge, count);
    if (delta === null) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      onEdit(trimOnTimeline(project, clip.id, edge, delta, count, 'source'));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Cannot trim this range.');
    }
  };
  const frameAt = (clientX: number): number => {
    const element = surface.current;
    if (!element) return 0;
    return Math.round((clientX - element.getBoundingClientRect().left - leading) / scale);
  };
  const seekAt = (event: PointerEvent): void => {
    let position = frameAt(event.clientX);
    if (snapping && !event.altKey) position = snapFrame(position, snapPoints(visible, beats), 8 / scale);
    onSeek(Math.max(0, Math.min(layout.duration - 1, position)));
  };
  const beginSeek = (event: PointerEvent): void => {
    if (!layout.duration || event.button !== 0 || drag.current || interactionBlocked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onScrub?.(true);
    seekAt(event);
  };
  const endSeek = (): void => onScrub?.(false);
  const moveSeek = (event: PointerEvent): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !layout.duration) return;
    event.stopPropagation();
    seekAt(event);
  };
  const layerAt = (clientY: number): string | null => {
    const viewport = scroll.current;
    if (!viewport || clientY < viewport.getBoundingClientRect().top + TIMELINE_RULER_HEIGHT) return null;
    const y = clientY - (surface.current?.getBoundingClientRect().top ?? 0);
    return timelineLayerAt(rows, y);
  };
  const mediaPayload = (ids: readonly string[]): TimelinePayload => ({
    kind: 'media',
    clips: ids.map((id, index) => {
      const asset = assets.find((item) => item.id === id);
      if (asset?.status !== 'ready') throw new Error('Wait for the editing proxy before inserting this recording.');
      const range = resolveMediaSelection(id, asset.metadata.frameCount, ranges);
      let clipId = `drop-preview-${index}`;
      while (project.clips.some((clip) => clip.id === clipId)) clipId += '-x';
      return createClip(clipId, id, range.sourceIn, range.sourceOut, selectedLayerId);
    }),
  });
  latestDrop.current = (): DropPlan | null => {
    const context = movement.current;
    const pointer = dropPointer.current;
    if (!context || !pointer || !surface.current) return null;
    const layerId = layerAt(pointer.y);
    if (!layerId) {
      setDropPlan(null);
      return null;
    }
    const position = (pointer.x - surface.current.getBoundingClientRect().left - context.leading) / context.scale;
    const candidate = planTimelineDrop(
      context.base,
      context.payload,
      layerId,
      position,
      snapping && !pointer.alt && beats,
      8 / context.scale,
      context.playhead,
    );
    setDropPlan(candidate);
    return candidate;
  };
  const startDropScroll = (): void => {
    if (dropScroll.current) return;
    const advance = (): void => {
      const pointer = dropPointer.current;
      const viewport = scroll.current;
      if (!pointer || !viewport || !movement.current) {
        dropScroll.current = 0;
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const velocity = (position: number, low: number, high: number): number => {
        if (position < low + 28) return -Math.min(14, (low + 28 - position) / 3);
        return position > high - 28 ? Math.min(14, (position - high + 28) / 3) : 0;
      };
      const beforeX = viewport.scrollLeft;
      const beforeY = viewport.scrollTop;
      viewport.scrollLeft += velocity(pointer.x, bounds.left, bounds.right);
      viewport.scrollTop += velocity(pointer.y, bounds.top + TIMELINE_RULER_HEIGHT, bounds.bottom);
      if (viewport.scrollLeft !== beforeX || viewport.scrollTop !== beforeY) latestDrop.current();
      dropScroll.current = requestAnimationFrame(advance);
    };
    dropScroll.current = requestAnimationFrame(advance);
  };
  const dragOver = (event: DragEvent): void => {
    if (interactionBlocked) return;
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_TYPE) && !event.dataTransfer.types.includes(CLIP_DRAG_TYPE))
      return;
    event.preventDefault();
    try {
      if (!movement.current && draggedMediaIds)
        movement.current = {
          payload: mediaPayload(draggedMediaIds),
          scale,
          leading,
          width,
          base: project,
          playhead: frame,
        };
      dropPointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey };
      const candidate = latestDrop.current();
      let effect: 'none' | 'copy' | 'move' = movement.current?.payload.kind === 'media' ? 'copy' : 'move';
      if (!candidate || candidate.error) effect = 'none';
      event.dataTransfer.dropEffect = effect;
      startDropScroll();
    } catch {
      setDropPlan(null);
      event.dataTransfer.dropEffect = 'none';
    }
  };
  const drop = (event: DragEvent): void => {
    if (interactionBlocked) return;
    event.preventDefault();
    try {
      const media = event.dataTransfer.getData(MEDIA_DRAG_TYPE);
      const instance = event.dataTransfer.getData(CLIP_DRAG_TYPE);
      let ids: string[] = [];
      if (media) {
        const parsed: unknown = JSON.parse(media);
        if (!Array.isArray(parsed) || !parsed.length || parsed.some((id) => typeof id !== 'string'))
          throw new Error('Invalid media drag.');
        ids = parsed as string[];
        movement.current ??= { payload: mediaPayload(ids), scale, leading, width, base: project, playhead: frame };
      } else if (!movement.current && instance)
        movement.current = {
          payload: { kind: 'clip', clipId: instance, grabFrame: 0 },
          scale,
          leading,
          width,
          base: project,
          playhead: frame,
        };
      dropPointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey };
      const candidate = latestDrop.current();
      if (!candidate) throw new Error('Drop onto a video track.');
      if (candidate.error) throw new Error(candidate.error);
      if (candidate.command) onEdit(candidate.command);
      else onInsert(ids, candidate.index, candidate.layerId, candidate.start);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Cannot drop clip');
    } finally {
      clearMove();
    }
  };
  const rulerRange = useRulerRange({
    project,
    duration: layout.duration,
    frame,
    leading,
    scale,
    snapping,
    beats,
    disabled: interactionBlocked || drag.current !== null,
    surface,
    viewport: scroll,
    onPause,
    onSeek,
    onScrub,
    onRange: props.onTimeRange,
  });

  const groupDrag = movement.current?.payload.kind === 'group' ? movement.current.payload : null;
  const interactionStatus = musicGesture
    ? musicGesture.error || `Music track · ${formatTimecode(musicGesture.start)} · release to apply · Esc cancels`
    : timelineInteractionMessage(
        {
          keyframe: keyframes.draft,
          transform: transformKeys.draft,
          speed: speedKeys.draft,
          bookmark: bookmarks.draft,
        },
        dragError,
        dropPlan,
        draft,
        selected?.clip,
      );
  return (
    <section className="timeline-panel panel" id="timeline-pane" tabIndex={-1} aria-label="Video timeline">
      <div className="timeline-toolbar">
        <h2 className="sr-only">Timeline</h2>
        <button
          className={`secondary-button small timeline-view-action ${snapping ? 'active' : ''}`}
          aria-label="Toggle snapping"
          aria-pressed={snapping}
          title="Snap to nearby edges and the playhead · hold Alt to bypass"
          disabled={interactionBlocked}
          onClick={() => setSnapping(!snapping)}
        >
          <Icon name="magnet" size={15} />
          <span className="timeline-action-label">Snap</span>
        </button>
        <BeatSnapControl
          mode={beatSnap.mode}
          snapping={snapping}
          disabled={interactionBlocked}
          onChange={beatSnap.choose}
        />
        <BookmarkButton
          project={project}
          frame={frame}
          duration={layout.duration}
          disabled={interactionBlocked}
          timeRange={props.timeRange}
          onEdit={onEdit}
          onSeek={onSeek}
        />
        <RushEditBar
          project={project}
          selected={selected}
          frame={frame}
          disabled={interactionBlocked}
          timeRange={props.timeRange}
          selectedCount={selectedClipIds.length}
          onSplit={onSplit}
          onDelete={onDelete}
          onQuickTrim={props.onQuickTrim}
          onCutRange={props.onCutRange}
        />
        <div className="timeline-zoom">
          <label htmlFor="timeline-zoom">Zoom</label>
          <button
            className="icon-button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={interactionBlocked || pixelsPerSecond <= zoomMin}
            onClick={() => zoomBy(1 / ZOOM_FACTOR)}
          >
            <Icon name="minus" size={15} />
          </button>
          <input
            id="timeline-zoom"
            type="range"
            aria-label="Timeline zoom"
            min={zoomMin}
            max={ZOOM_MAX}
            step={zoomMin < ZOOM_MIN ? 'any' : 1}
            value={Math.max(zoomMin, pixelsPerSecond)}
            disabled={interactionBlocked}
            onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
          />
          <button
            className="icon-button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={interactionBlocked || pixelsPerSecond >= ZOOM_MAX}
            onClick={() => zoomBy(ZOOM_FACTOR)}
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            className="text-button"
            title="Fit timeline (F)"
            disabled={interactionBlocked || !storedExtent}
            onClick={fitTimeline}
          >
            Fit
          </button>
        </div>
      </div>
      <div className="timeline-lanes">
        <Layers
          project={project}
          selectedId={selectedLayerId}
          scrollTop={verticalScroll}
          surfaceHeight={surfaceHeight}
          viewportHeight={viewportHeight}
          disabled={interactionBlocked}
          onScroll={scrollLayers}
          onSelect={onSelectLayer}
          onSelectClips={props.onSelectTrackClips}
          onEdit={onEdit}
          onAdd={() => {
            const id = crypto.randomUUID();
            onEdit({ type: 'layer-add', layer: createLayer(id, nextLayerName(project)) });
            onSelectLayer(id);
          }}
        />
        <div
          className="timeline-scroll"
          ref={scroll}
          onScroll={(event) => setVerticalScroll(event.currentTarget.scrollTop)}
          onDragEnter={dragOver}
          onDragOver={dragOver}
          onDrop={drop}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropPlan(null);
              dropPointer.current = null;
              cancelAnimationFrame(dropScroll.current);
              dropScroll.current = 0;
            }
          }}
        >
          <div
            ref={surface}
            className={`${timelineSurfaceClassName(dragError, draft, slideActive)} ${musicGesture ? 'music-drafting' : ''}`}
            style={{ width, height: surfaceHeight }}
            data-pixels-per-frame={scale}
            data-leading={leading}
          >
            <div
              className="timeline-ruler"
              {...rulerRange.handlers}
              aria-label="Timeline ruler"
              title="Time ruler · click to seek, drag to select a range to cut; drag the playhead handle to scrub"
            >
              {ticks.map((second) => (
                <span
                  className="ruler-tick"
                  key={second}
                  style={{ left: leading + secondsToFrames(second, project.frameRate) * scale }}
                >
                  {durationLabel(second)}
                </span>
              ))}
              <RulerRange
                range={rulerRange.draft ? rulerRange.draft.range : props.timeRange}
                drafting={rulerRange.draft !== null}
                leading={leading}
                scale={scale}
              />
              {beatSnap.active && (
                <RulerBeats
                  project={visible}
                  beatsOf={beatSnap.beatsOf}
                  downbeatsOnly={beatSnap.mode === 'downbeats'}
                  leading={leading}
                  scale={scale}
                  width={width}
                />
              )}
              {layout.duration > 0 && (
                <div className="timeline-ruler-playhead" style={{ left: leading + frame * scale }}>
                  <button
                    aria-label="Drag playhead"
                    onPointerDown={beginSeek}
                    onPointerMove={moveSeek}
                    onLostPointerCapture={endSeek}
                  />
                  {(draft || slideActive) && <span className="playhead-readout">{formatTimecode(frame)} · draft</span>}
                </div>
              )}
              <KeyframeMarkers
                slide={bookmarks}
                targets={bookmarkTargets(visible)}
                blocked={() => interactionBlocked}
                view={(_target, state) => ({
                  className: 'timeline-bookmark',
                  'data-bookmark': state.frame,
                  'aria-label': `Bookmark at ${formatTimecode(state.frame)}`,
                  title: `Bookmark · ${formatTimecode(state.frame)} · Click to go here; drag to move, Arrow keys: 1 frame, Shift: 10; Delete removes. Alt bypasses snapping.`,
                  style: { left: leading + (state.at ?? state.frame) * scale },
                  children: (
                    <>
                      <svg className="timeline-bookmark-shape" viewBox="0 0 10 12" aria-hidden="true">
                        <path d="M1 1h8v5.6L5 11 1 6.6Z" />
                      </svg>
                      {state.moving && (
                        <span className="timeline-bookmark-time" aria-hidden="true">
                          {formatTimecode(state.frame)}
                        </span>
                      )}
                    </>
                  ),
                })}
              />
            </div>
            {visible.bookmarks.map((bookmark) => (
              <div
                key={`bookmark-line-${bookmark}`}
                className={`timeline-bookmark-line${bookmarks.draft?.frame === bookmark ? ' active' : ''}`}
                style={{ left: leading + bookmark * scale }}
              />
            ))}
            {project.layers.map((layer) => (
              <button
                className={`timeline-lane ${layer.id === selectedLayerId ? 'selected' : ''} ${layer.enabled ? '' : 'hidden-layer'}`}
                key={layer.id}
                data-layer-lane={layer.id}
                aria-label={`Timeline lane ${layer.name}`}
                disabled={interactionBlocked}
                style={{ top: rowTop(layer.id) - LANE_OFFSET }}
                onClick={() => onSelectLayer(layer.id)}
              >
                {layer.id === selectedLayerId && !layout.clips.some((item) => item.clip.layerId === layer.id) && (
                  <span className="timeline-lane-placeholder">Insert here</span>
                )}
              </button>
            ))}
            {selected && source && (
              <div
                className="available-source"
                aria-label="Available original recording"
                style={{
                  top: rowTop(selected.clip.layerId) - LANE_OFFSET,
                  left: leading + (selected.start - availableHead) * scale,
                  width: clipDuration({ ...selected.clip, sourceIn: 0, sourceOut: source.metadata.frameCount }) * scale,
                }}
              />
            )}
            {!geometry.clips.length && (
              <div className="timeline-empty" style={{ top: rows[0]!.top + 1 }}>
                <Icon name="plus" size={18} />
                {timelineEmptyMessage(project)}
              </div>
            )}
            {geometry.clips.map((placed, index) => {
              const asset = assets.find((item) => item.id === placed.clip.mediaId);
              const currentPlaced = layout.clips.find((item) => item.clip.id === placed.clip.id) ?? placed;
              const clip = currentPlaced.clip;
              const isSelected = clip.id === selectedClipId;
              const grouped = selectedClipIds.includes(clip.id);
              const offset =
                drag.current?.edge === 'in' && drag.current.clip.id === clip.id
                  ? placed.duration - currentPlaced.duration
                  : 0;
              const name = asset?.name ?? clip.mediaId;
              const clipLayer = project.layers.find((layer) => layer.id === clip.layerId);
              return (
                <div
                  className={clipClassName({
                    selected: isSelected,
                    grouped: grouped && !isSelected,
                    activeLayer: clip.layerId === selectedLayerId,
                    disabledLayer: !clipLayer?.enabled,
                    transformAnimated: !!clipLayer?.transform.keyframes.length,
                    moving: movingClipIds(movement.current?.payload).includes(clip.id),
                  })}
                  key={clip.id}
                  data-clip-id={clip.id}
                  style={{
                    top: rowTop(clip.layerId),
                    left: leading + (placed.start + offset) * scale,
                    width: currentPlaced.duration * scale,
                  }}
                  draggable={!interactionBlocked}
                  onDragStart={(event) => {
                    if (
                      interactionBlocked ||
                      drag.current ||
                      (event.target instanceof HTMLElement &&
                        event.target.closest('[data-trim-handle], [data-clip-keyframe]'))
                    ) {
                      event.preventDefault();
                      return;
                    }
                    // Selection feedback may reveal a row on a normal click, never
                    // move the scroll viewport beneath an in-progress native drag.
                    movingClip.current = true;
                    const grabFrame = Math.max(
                      0,
                      Math.min(
                        placed.duration - 1,
                        (event.clientX - event.currentTarget.getBoundingClientRect().left) / scale,
                      ),
                    );
                    // Dragging a clip of the selection moves every selected clip.
                    const group = grouped ? selectedClipIds : null;
                    movement.current = {
                      payload: group
                        ? { kind: 'group', clipIds: group, clipId: clip.id, grabFrame }
                        : { kind: 'clip', clipId: clip.id, grabFrame },
                      scale,
                      leading,
                      width,
                      base: project,
                      playhead: frame,
                    };
                    onPause();
                    if (!group) onSelect(clip.id);
                    event.dataTransfer.setData(CLIP_DRAG_TYPE, clip.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={clearMove}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (interactionBlocked) return;
                    onSelect(clip.id);
                    // The Menu key reports no pointer position; anchor to the clip instead.
                    const box = event.currentTarget.getBoundingClientRect();
                    const keyboard = event.clientX === 0 && event.clientY === 0;
                    setClipMenu({
                      clipId: clip.id,
                      x: keyboard ? box.left : event.clientX,
                      y: keyboard ? box.bottom : event.clientY,
                    });
                  }}
                >
                  <button
                    className="timeline-clip-body"
                    aria-label={`Select ${name}, clip ${index + 1}`}
                    aria-pressed={isSelected || grouped}
                    disabled={interactionBlocked}
                    title={`${name} · ${project.layers.find((layer) => layer.id === clip.layerId)?.name} · ${placed.duration} timeline frames · Ctrl-click to select several clips`}
                    onClick={(event) => {
                      if (event.ctrlKey || event.metaKey) {
                        onToggleClip(clip.id);
                        return;
                      }
                      onSelect(clip.id);
                      onSeek(
                        Math.max(
                          placed.start,
                          Math.min(placed.end - 1, event.detail ? frameAt(event.clientX) : placed.start),
                        ),
                      );
                    }}
                  >
                    <span className="clip-filmstrip">
                      {filmstrip(asset, currentPlaced, currentPlaced.duration * scale).map(({ frame, src }) => (
                        <img loading="lazy" draggable={false} key={frame} src={src} alt="" />
                      ))}
                    </span>
                    <span className="timeline-clip-label">
                      <strong>{shortName(name)}</strong>
                      <small>
                        {sourceSeconds(currentPlaced.duration)}
                        {speedLabel(clip)}
                      </small>
                    </span>
                  </button>
                  <ClipKeyframeMarkers
                    placed={currentPlaced}
                    name={name}
                    blocked={clipMarkerBlocked}
                    speeds={speedKeys}
                  />
                  {(['in', 'out'] as const).map((edge) => (
                    <button
                      key={edge}
                      className={`trim-handle ${edge}`}
                      data-trim-handle={edge}
                      role="slider"
                      aria-label={`Trim ${edge === 'in' ? 'start' : 'end'} of ${name}, clip ${index + 1}`}
                      disabled={keyframes.active || musicGesture !== null}
                      aria-valuemin={trimHandleValue(clip, edge, asset?.metadata.frameCount).min}
                      aria-valuemax={trimHandleValue(clip, edge, asset?.metadata.frameCount).max}
                      aria-valuenow={trimHandleValue(clip, edge, asset?.metadata.frameCount).now}
                      aria-valuetext={sourceSeconds(trimHandleValue(clip, edge, asset?.metadata.frameCount).now)}
                      title={`Trim ${edge === 'in' ? 'start' : 'end'}; drag outward to restore recording frames. Arrow keys: one frame; Shift: ten.`}
                      onPointerDown={(event) => beginTrim(event, placed.clip, edge)}
                      onPointerMove={moveTrim}
                      onPointerUp={finishTrim}
                      onPointerCancel={cancelTrim}
                      onLostPointerCapture={() => {
                        if (drag.current) cancelTrim();
                      }}
                      onKeyDown={(event) => keyboardTrim(event, placed.clip, edge)}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span />
                    </button>
                  ))}
                </div>
              );
            })}
            <TimelineCutOverlay
              range={rulerRange.draft ? rulerRange.draft.range : props.timeRange}
              selected={selected}
              top={rowTop(selected?.clip.layerId ?? project.layers[0]!.id)}
              leading={leading}
              scale={scale}
            />
            {visible.layers.map((layer) => (
              <KeyframeMarkers
                key={layer.id}
                slide={keyframes}
                targets={layer.keyframes.map((point) => ({ scope: layer.id, origin: point.frame }))}
                blocked={() => interactionBlocked}
                view={({ origin }, state) => {
                  const point = layer.keyframes.find((item) => item.frame === origin)!;
                  const settings = keySettings(point)
                    .map((setting) => KEYFRAME_SETTINGS.find((definition) => definition.key === setting)!.label)
                    .join(' · ');
                  const current =
                    layer.id === selectedLayerId &&
                    state.frame === keyframeNavigationFrame(keyframeNavigation.inspection, layer.id, frame);
                  return {
                    className: `timeline-layer-key${point.reset ? ' reset' : ''}${current ? ' active' : ''}`,
                    'data-layer-keyframe': state.frame,
                    'data-keyframe-layer': layer.id,
                    'aria-label': `Track keyframe ${state.frame} on ${layer.name}${point.reset ? ' (default)' : ''}`,
                    'aria-pressed': current,
                    title: `${layer.name} · ${formatTimecode(state.frame)} · ${point.reset ? 'Default keyframe: settings return to their defaults here' : settings} · Drag to move all animated settings; Arrow keys: 1 frame, Shift: 10; Delete removes. Alt bypasses snapping.`,
                    style: { top: rowTop(layer.id) + 48, left: leading + (state.at ?? origin) * scale },
                    children: (
                      <>
                        {point.reset ? (
                          <Icon name="default-key" size={14} />
                        ) : (
                          <span aria-hidden="true" className="keyframe-glyph diamond">
                            ◆
                          </span>
                        )}
                        {state.moving && (
                          <span className="timeline-layer-key-time" aria-hidden="true">
                            {formatTimecode(state.frame)}
                          </span>
                        )}
                      </>
                    ),
                  };
                }}
              />
            ))}
            {visible.layers.map((layer) => (
              <KeyframeMarkers
                key={`transform-${layer.id}`}
                slide={transformKeys}
                targets={layer.transform.keyframes.map((point) => ({ scope: layer.id, origin: point.frame }))}
                blocked={() => interactionBlocked}
                view={({ origin }, state) => {
                  const point = layer.transform.keyframes.find((item) => item.frame === origin)!;
                  const settings = spatialKeyChannels(point)
                    .map((channel) => SPATIAL_CONTROLS.find((control) => control.key === channel)!.label)
                    .join(' · ');
                  const described = point.reset ? 'default' : settings;
                  return {
                    className: `timeline-transform-key${point.reset ? ' reset' : ''}`,
                    'data-transform-keyframe': state.frame,
                    'data-transform-layer': layer.id,
                    'aria-label': `Transform keyframe ${state.frame} on ${layer.name} (${described})`,
                    title: `${layer.name} · Transform · ${formatTimecode(state.frame)} · ${point.reset ? 'Default keyframe: Transform returns to its defaults here' : settings} · Drag to move; Arrow keys: 1 frame, Shift: 10; Delete removes. Alt bypasses snapping.`,
                    style: { top: rowTop(layer.id) - 3, left: leading + (state.at ?? origin) * scale },
                    children: (
                      <>
                        {point.reset ? (
                          <Icon name="default-key" size={14} />
                        ) : (
                          <span aria-hidden="true" className="keyframe-glyph triangle">
                            ▼
                          </span>
                        )}
                        {state.moving && (
                          <span className="timeline-layer-key-time" aria-hidden="true">
                            {formatTimecode(state.frame)}
                          </span>
                        )}
                      </>
                    ),
                  };
                }}
              />
            ))}
            {geometry.transitions.flatMap((region) =>
              region.slot
                ? [
                    <div
                      key={`slot-${region.transition.leftId}-${region.transition.rightId}`}
                      className="timeline-transition-slot"
                      aria-hidden="true"
                      style={{
                        top: rowTop(region.layerId),
                        left: leading + region.slot.start * scale,
                        width: (region.slot.end - region.slot.start) * scale,
                      }}
                    />,
                  ]
                : [],
            )}
            {geometry.transitions.map((region, index) => {
              const left =
                assets.find(
                  (asset) => asset.id === project.clips.find((clip) => clip.id === region.transition.leftId)?.mediaId,
                )?.name ?? `Clip ${index + 1}`;
              const position =
                transitionOffset(region.transition) === 0 ? region.boundary : (region.start + region.end) / 2;
              const label = {
                cut: 'Cut',
                'cross-dissolve': 'Dissolve',
                'fade-through-black': 'Fade',
                'fade-black-pause': 'Pause',
              }[region.transition.type];
              const layerName = project.layers.find((layer) => layer.id === region.layerId)!.name;
              return (
                <button
                  key={`${region.transition.leftId}-${region.transition.rightId}`}
                  className={`boundary-button ${selectedBoundaryId === region.transition.leftId ? 'selected' : ''}`}
                  data-transition-layer={region.layerId}
                  disabled={interactionBlocked}
                  style={{ top: rowTop(region.layerId) + 4, left: leading + position * scale }}
                  aria-label={`Transition after ${left}, clip ${index + 1} on ${layerName}`}
                  title={`${label} on ${layerName} · edit this track’s boundary`}
                  onClick={() => onBoundary(region.transition.leftId)}
                >
                  {label}
                </button>
              );
            })}
            {layout.duration > 0 && (
              <div className="timeline-playhead" style={{ left: leading + frame * scale }}>
                <i />
              </div>
            )}
            {dropPlan && (
              <>
                <div
                  className={`timeline-drop-preview ${dropPlan.error ? 'invalid' : ''}`}
                  data-drop-start={dropPlan.start}
                  data-drop-layer={dropPlan.layerId}
                  data-drop-valid={!dropPlan.error}
                  data-drop-clip={groupDrag?.clipId}
                  style={{
                    top: rowTop(dropPlan.layerId),
                    left: leading + dropPlan.start * scale,
                    width: dropPlan.duration * scale,
                  }}
                >
                  <span>
                    {dropLabel(dropPlan)} · {formatTimecode(dropPlan.start)}
                  </span>
                </div>
                {dropPlan.ghosts
                  ?.filter((ghost) => ghost.clipId !== groupDrag?.clipId)
                  .map((ghost) => (
                    <div
                      key={ghost.clipId}
                      className={`timeline-drop-preview group-member ${dropPlan.error ? 'invalid' : ''}`}
                      data-drop-start={ghost.start}
                      data-drop-layer={ghost.layerId}
                      data-drop-valid={!dropPlan.error}
                      data-drop-clip={ghost.clipId}
                      style={{
                        top: rowTop(ghost.layerId),
                        left: leading + ghost.start * scale,
                        width: ghost.duration * scale,
                      }}
                    />
                  ))}
                <div
                  className={`timeline-drop-marker ${dropPlan.error ? 'invalid' : ''}`}
                  style={{
                    top: rowTop(dropPlan.layerId) - 6,
                    height: 80,
                    bottom: 'auto',
                    left: leading + dropPlan.start * scale,
                  }}
                />
                {dropPlan.guide !== null && !dropPlan.error && (
                  <div className="snap-guide" style={{ left: leading + dropPlan.guide * scale }} />
                )}
              </>
            )}
            {snapGuide !== null && draft && (
              <div className="snap-guide" style={{ left: leading + snapGuide * scale }} />
            )}
            {typeof rulerRange.draft?.guide === 'number' && (
              <div className="snap-guide" style={{ left: leading + rulerRange.draft.guide * scale }} />
            )}
            {(
              [
                ['track', keyframes.draft?.guide],
                ['transform', transformKeys.draft?.guide],
                ['speed', speedKeys.draft?.guide],
                ['bookmark', bookmarks.draft?.guide],
              ] as const
            ).map(
              ([type, guide]) =>
                guide !== null &&
                guide !== undefined && (
                  <div
                    key={`${type}-keyframe-guide`}
                    className={`snap-guide ${type}-keyframe-guide`}
                    style={{ left: leading + guide * scale }}
                  />
                ),
            )}
            {musicGesture?.guide !== null && musicGesture?.guide !== undefined && (
              <div className="snap-guide" style={{ left: leading + musicGesture.guide * scale }} />
            )}
            <TimelineMusicLanes
              project={project}
              display={musicGesture?.document ?? project}
              audioAssets={audioAssets}
              selectedMusicId={selectedMusicId}
              onSelectMusic={onSelectMusic}
              onMusicBoundary={onMusicBoundary}
              top={musicTop}
              leading={leading}
              scale={scale}
              width={width}
              viewport={scroll}
              frame={frame}
              snapping={snapping}
              beats={beats}
              disabled={interactionBlocked || dropPlan !== null}
              onPause={onPause}
              onEdit={onEdit}
              onPreview={onPreview}
              onGesture={setMusicGesture}
              onError={onError}
            />
          </div>
        </div>
      </div>
      {interactionStatus && (
        <div className="timeline-bottom">
          <span
            className={
              dragError ||
              dropPlan?.error ||
              keyframes.draft?.error ||
              transformKeys.draft?.error ||
              speedKeys.draft?.error ||
              bookmarks.draft?.error ||
              musicGesture?.error
                ? 'trim-error'
                : ''
            }
          >
            {interactionStatus}
          </span>
        </div>
      )}
      {clipMenu && (
        <ClipContextMenu
          anchor={clipMenu}
          onClose={closeClipMenu}
          onDuplicate={() => {
            setClipMenu(null);
            onDuplicate();
          }}
          project={project}
          onEdit={onEdit}
        />
      )}
    </section>
  );
}
