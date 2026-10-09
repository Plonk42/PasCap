import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { applyCommand, type EditCommand } from '../shared/commands.js';
import { KEYFRAME_SETTINGS, keySettings } from '../shared/keyframes.js';
import { compileLayerRetiming } from '../shared/layer-retiming.js';
import { resolveMediaSelection, type MediaSelections } from '../shared/media-selection.js';
import type { MediaAsset } from '../shared/media.js';
import { createClip, createLayer, MAX_VIDEO_LAYERS, type ProjectDocument, type VideoClip } from '../shared/model.js';
import type { ClipCutRange } from '../shared/rush-editing.js';
import { snapFrame, snapPoints } from '../shared/snap.js';
import { trimOnTimeline, type TrimEdge } from '../shared/source-range.js';
import { calculateLayout } from '../shared/timeline.js';
import { formatTimecode, framesToSeconds, secondsToFrames } from '../shared/timing.js';
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
import { clipStartRestriction } from './layer-actions.js';
import './declutter.css';
import './layers.css';
import { Layers } from './Layers.js';
import { createMusicInstance, videoTimelineDuration } from './music-ui.js';
import { MusicTimeline, type MusicTimelineGesture } from './MusicTimeline.js';
import { Popover } from './Popover.js';
import { RushEditBar, TimelineCutMarks } from './RushEditBar.js';
import { useTimelineKeyframes, type TimelineKeyframeDraft } from './timeline-keyframes.js';
import { planTimelineDrop, type DropPlan, type TimelinePayload } from './timeline-placement.js';
import { TIMELINE_RULER_HEIGHT, timelineLayerAt, timelineRows } from './timeline-rows.js';

export interface DraftPreview {
  document: ProjectDocument;
  frame: number;
}
interface Props {
  project: ProjectDocument;
  assets: MediaAsset[];
  audioAssets: AudioAsset[];
  selectedClipId: string | null;
  selectedLayerId: string;
  onSelectLayer: (id: string) => void;
  selectedMusicId: string | null;
  onSelectMusic: (id: string) => void;
  selectedBoundaryId: string | null;
  frame: number;
  onSelect: (id: string) => void;
  onBoundary: (leftId: string) => void;
  onSeek: (frame: number) => void;
  onPause: () => void;
  onEdit: (command: EditCommand) => void;
  onInsert: (mediaIds: string[], index: number, layerId: string, start: number) => void;
  onPreview: (draft: DraftPreview | null, restoreFrame?: number) => void;
  onError: (message: string) => void;
  onSplit: () => void;
  onDelete: () => void;
  fitRequest: number;
  draggedMediaIds: readonly string[] | null;
  ranges: MediaSelections;
  onDuplicate: () => void;
  onNudge: (delta: number) => void;
  onQuickTrim: (edge: TrimEdge) => void;
  cutRange: ClipCutRange | null;
  onMarkCut: (edge: TrimEdge) => void;
  onCutMarked: () => void;
  onClearCut: () => void;
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

function dropLabel(plan: DropPlan): string {
  if (plan.error) return 'Placement cannot fit';
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
  keyframe: TimelineKeyframeDraft | null,
  error: string,
  plan: DropPlan | null,
  draft: ProjectDocument | null,
  selected: VideoClip | undefined,
): string {
  if (keyframe)
    return (
      keyframe.error ||
      `Track keyframe · ${formatTimecode(keyframe.frame)} · all animated settings move together · release to apply · Esc cancels`
    );
  return interactionMessage(error, plan, draft, selected);
}

function keyboardTrimDelta(key: string, shift: boolean, clip: VideoClip, edge: TrimEdge, count: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return shift ? -10 : -1;
    case 'ArrowRight':
      return shift ? 10 : 1;
    case 'Home':
      return edge === 'in' ? -clip.sourceIn : clip.sourceIn + 1 - clip.sourceOut;
    case 'End':
      return edge === 'out' ? count - clip.sourceOut : clip.sourceOut - 1 - clip.sourceIn;
    default:
      return null;
  }
}

function speedLabel(clip: VideoClip): string {
  switch (clip.speed.mode) {
    case 'constant':
      return clip.speed.rate === 1 ? '' : ` · ${clip.speed.rate}×`;
    case 'ramp':
      return ' · ramp';
    case 'curve':
      return ' · curve';
  }
}

function nextLayerName(project: ProjectDocument): string {
  let number = 2;
  while (project.layers.some((layer) => layer.name === `Video track ${number}`)) number++;
  return `Video track ${number}`;
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
    ...project.music.map((track) => track.start + track.duration),
    gesture ? gesture.start + gesture.duration : 0,
  );
}

function timelineMusicHeight(project: ProjectDocument): number {
  return project.music.length ? project.music.length * 70 : 55;
}

/** A ready music file dropped from Media becomes a new music track starting at the drop frame. */
function musicDrop(
  props: Readonly<
    Pick<Props, 'project' | 'audioAssets' | 'onEdit'> & { leading: number; scale: number; disabled: boolean }
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
      const music = { ...createMusicInstance(crypto.randomUUID(), asset, videoTimelineDuration(props.project)), start };
      props.onEdit({ type: 'music', music: [...props.project.music, music] });
    },
  };
}

function TimelineMusicLanes(
  props: Readonly<
    Pick<
      Props,
      | 'project'
      | 'audioAssets'
      | 'selectedMusicId'
      | 'onSelectMusic'
      | 'frame'
      | 'onPause'
      | 'onEdit'
      | 'onPreview'
      | 'onError'
    > & {
      top: number;
      leading: number;
      scale: number;
      width: number;
      viewport: { current: HTMLDivElement | null };
      snapping: boolean;
      disabled: boolean;
      onGesture: (gesture: MusicTimelineGesture | null) => void;
    }
  >,
) {
  if (!props.project.music.length)
    return (
      <div className="music-lane-wrapper" style={{ top: props.top }} {...musicDrop(props)}>
        <div className="music-track-empty">Drop music here or use Audio → Add music track</div>
      </div>
    );
  return props.project.music.map((music, index) => (
    <div
      key={music.id}
      className={`music-lane-wrapper music-instance-lane ${music.id === props.selectedMusicId ? 'selected' : ''}`}
      data-music-lane={music.id}
      style={{ top: props.top + index * 70 }}
      {...musicDrop(props)}
    >
      <MusicTimeline
        project={props.project}
        music={music}
        index={index}
        selected={music.id === props.selectedMusicId}
        asset={props.audioAssets.find((asset) => asset.id === music.mediaId)}
        leading={props.leading}
        scale={props.scale}
        width={props.width}
        viewport={props.viewport}
        frame={props.frame}
        snapping={props.snapping}
        disabled={props.disabled}
        onSelect={props.onSelectMusic}
        onPause={props.onPause}
        onEdit={props.onEdit}
        onPreview={props.onPreview}
        onGesture={props.onGesture}
        onError={props.onError}
      />
    </div>
  ));
}

export function Timeline(props: Readonly<Props>) {
  const {
    project,
    assets,
    audioAssets,
    selectedClipId,
    selectedLayerId,
    onSelectLayer,
    selectedMusicId,
    onSelectMusic,
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
    onNudge,
  } = props;
  const [snapping, setSnapping] = useState(true);
  const nudgeReasonId = useId();
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
  const baselineWidth = Math.max(viewportWidth, 32 + calculateLayout(project).duration * scale + 96);
  const keyframes = useTimelineKeyframes({
    project,
    frame,
    scale,
    width: baselineWidth,
    disabled: keyframeNavigation.disabled || musicGesture !== null,
    snapping,
    viewport: scroll,
    onPause,
    onSelectLayer,
    onPreview,
    onEdit,
    onSeekKeyframe: keyframeNavigation.onSeekKeyframe,
    onError,
  });

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

  const visible = keyframes.draft?.document ?? draft ?? musicGesture?.document ?? project;
  const layout = calculateLayout(visible);
  const baseLayout = calculateLayout(project);
  const selected = layout.clips.find((placed) => placed.clip.id === selectedClipId);
  const source = assets.find((asset) => asset.id === selected?.clip.mediaId);
  const selectedLayer = project.layers.find((layer) => layer.id === selected?.clip.layerId);
  const nudgeRestriction = selected ? clipStartRestriction(project, selected.clip) : null;
  // Reserve access to omitted head/tail footage, including the first/last clip.
  // Outward trimming must not require dragging beyond the edge of the browser.
  const availableHead =
    selected && selectedLayer
      ? compileLayerRetiming({ ...selected.clip, sourceIn: 0 }, selectedLayer, selected.start).duration -
        selected.duration
      : 0;
  // Selection must not move frame zero beneath the mouse. The timeline origin
  // stays fixed; omitted source is still recoverable through handles/Home/End.
  const leading = drag.current?.leading ?? movement.current?.leading ?? musicGesture?.leading ?? 32;
  const unusedTail =
    source && selected && selectedLayer
      ? compileLayerRetiming({ ...selected.clip, sourceOut: source.metadata.frameCount }, selectedLayer, selected.start)
          .duration -
        selected.duration -
        (layout.duration - selected.end)
      : 0;
  const trailing = Math.max(96, unusedTail * scale + 24);
  const musicEnd = timelineMusicExtent(project, musicGesture);
  // Stored points after video or music OUT stay reachable, without extending the playable duration.
  const lastKeyframe = Math.max(0, ...project.layers.flatMap((layer) => layer.keyframes.map((point) => point.frame)));
  const width = Math.max(
    viewportWidth,
    leading +
      Math.max(
        layout.duration,
        musicEnd,
        (dropPlan?.start ?? 0) + (dropPlan?.duration ?? 0),
        keyframes.draft?.frame ?? 0,
        lastKeyframe,
      ) *
        scale +
      trailing,
    drag.current?.width ?? 0,
    movement.current?.width ?? 0,
    keyframes.draft?.width ?? 0,
    musicGesture?.width ?? 0,
  );
  const interactionBlocked =
    musicGesture !== null || timelineInteractionBlocked(draft, keyframes.active, keyframeNavigation.disabled);
  const geometry = drag.current?.edge === 'in' ? calculateLayout(drag.current.base) : layout;
  const rows = timelineRows(project.layers);
  const rowTop = (layerId: string): number => rows.find((row) => row.layer.id === layerId)!.top;
  const selectedRowTop = rows.find((row) => row.layer.id === selectedLayerId)?.top;
  const musicTop = 55 + project.layers.length * 88;
  const surfaceHeight = musicTop + timelineMusicHeight(project);
  const seconds = framesToSeconds(Math.max(layout.duration, baseLayout.duration), project.frameRate);
  let tickStep = 10;
  if (pixelsPerSecond >= 24) tickStep = 5;
  if (pixelsPerSecond >= 60) tickStep = 1;
  const ticks = Array.from({ length: Math.ceil(seconds / tickStep) + 1 }, (_, index) => index * tickStep);
  const fitTimeline = (): void => {
    if (layout.duration && !drag.current && !keyframes.active && !musicGesture)
      setPixelsPerSecond(
        Math.max(12, Math.min(180, (viewportWidth - leading - 64) / framesToSeconds(layout.duration))),
      );
  };
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
      keyframes.active ||
      musicGesture
    )
      return;
    const top = selectedRowTop;
    if (top < element.scrollTop + 34) element.scrollTop = Math.max(0, top - 40);
    else if (top + 78 > element.scrollTop + element.clientHeight) element.scrollTop = top + 88 - element.clientHeight;
  }, [selectedLayerId, selectedClipId, props.revealRequest, selectedRowTop, viewportHeight]);
  useEffect(() => {
    const element = scroll.current;
    if (!element || drag.current || movingClip.current || movement.current || keyframes.active || musicGesture) return;
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
    const index = project.music.findIndex((track) => track.id === selectedMusicId);
    if (
      !element ||
      revealTarget.current !== 'music' ||
      index < 0 ||
      musicGesture ||
      drag.current ||
      movingClip.current ||
      keyframes.active
    )
      return;
    const top = musicTop + index * 70;
    if (top < element.scrollTop + TIMELINE_RULER_HEIGHT) element.scrollTop = Math.max(0, top - TIMELINE_RULER_HEIGHT);
    else if (top + 64 > element.scrollTop + element.clientHeight)
      element.scrollTop = Math.max(0, top + 70 - element.clientHeight);
    const music = project.music[index]!;
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
      const targets = snapPoints(active.base)
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
    const layer = project.layers.find((item) => item.id === clip.layerId)!;
    const recoverableHead =
      compileLayerRetiming({ ...clip, sourceIn: 0 }, layer, placed.start).duration - placed.duration;
    const originShift = edge === 'in' ? Math.max(0, Math.ceil((recoverableHead - placed.start) * scale)) : 0;
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
    if (snapping && !event.altKey) position = snapFrame(position, snapPoints(visible), 8 / scale);
    onSeek(Math.max(0, Math.min(layout.duration - 1, position)));
  };
  const beginSeek = (event: PointerEvent): void => {
    if (!layout.duration || event.button !== 0 || drag.current || interactionBlocked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekAt(event);
  };
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
      snapping && !pointer.alt,
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

  const interactionStatus = musicGesture
    ? musicGesture.error || `Music track · ${formatTimecode(musicGesture.start)} · release to apply · Esc cancels`
    : timelineInteractionMessage(keyframes.draft, dragError, dropPlan, draft, selected?.clip);
  return (
    <section className="timeline-panel panel" id="timeline-pane" tabIndex={-1} aria-label="Video timeline">
      <div className="timeline-toolbar">
        <h2 className="declutter-sr-only">Timeline</h2>
        <Popover label="Clip actions" className="timeline-clip-actions">
          {(close) => (
            <>
              <button
                className="secondary-button small"
                aria-label="Duplicate selected clip"
                disabled={!selectedClipId || interactionBlocked}
                onClick={() => {
                  close();
                  onDuplicate();
                }}
              >
                <Icon name="plus" size={15} />
                Duplicate <kbd>Ctrl+D</kbd>
              </button>
              <div className="clip-nudge-controls">
                <button
                  className="secondary-button small"
                  aria-label="Move clip one frame earlier"
                  aria-describedby={nudgeRestriction ? nudgeReasonId : undefined}
                  title={
                    nudgeRestriction ??
                    (selected?.start === 0
                      ? 'Already at timeline frame 0'
                      : 'Move this start or first Ripple anchor · Alt+Left')
                  }
                  disabled={!selected || selected.start === 0 || nudgeRestriction !== null || interactionBlocked}
                  onClick={() => onNudge(-1)}
                >
                  ← 1 frame
                </button>
                <button
                  className="secondary-button small"
                  aria-label="Move clip one frame later"
                  aria-describedby={nudgeRestriction ? nudgeReasonId : undefined}
                  title={nudgeRestriction ?? 'Move this start or first Ripple anchor · Alt+Right'}
                  disabled={!selected || nudgeRestriction !== null || interactionBlocked}
                  onClick={() => onNudge(1)}
                >
                  1 frame →
                </button>
              </div>
              {nudgeRestriction && (
                <p className="control-hint" id={nudgeReasonId}>
                  {nudgeRestriction}
                </p>
              )}
            </>
          )}
        </Popover>
        <RushEditBar
          project={project}
          selected={selected}
          frame={frame}
          disabled={interactionBlocked}
          cutRange={props.cutRange}
          onSplit={onSplit}
          onDelete={onDelete}
          onQuickTrim={props.onQuickTrim}
          onMarkCut={props.onMarkCut}
          onCutMarked={props.onCutMarked}
          onClearCut={props.onClearCut}
        />
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
        <button
          className="secondary-button small timeline-view-action"
          aria-label="Add video track"
          title="Add a video track with Ripple on, independent transitions and fades"
          disabled={interactionBlocked || project.layers.length >= MAX_VIDEO_LAYERS}
          onClick={() => {
            const id = crypto.randomUUID();
            onEdit({ type: 'layer-add', layer: createLayer(id, nextLayerName(project)) });
            onSelectLayer(id);
          }}
        >
          <Icon name="plus" size={15} />
          <span className="timeline-action-label">Track</span>
        </button>
        <div className="timeline-zoom">
          <label htmlFor="timeline-zoom">Zoom</label>
          <input
            id="timeline-zoom"
            type="range"
            aria-label="Timeline zoom"
            min={12}
            max={180}
            step={1}
            value={pixelsPerSecond}
            disabled={interactionBlocked}
            onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
          />
          <button
            className="text-button"
            title="Fit timeline (F)"
            disabled={interactionBlocked || !layout.duration}
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
          onEdit={onEdit}
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
            className={`${timelineSurfaceClassName(dragError, draft, keyframes.active)} ${musicGesture ? 'music-drafting' : ''}`}
            style={{ width, height: surfaceHeight }}
            data-pixels-per-frame={scale}
            data-leading={leading}
          >
            <div
              className="timeline-ruler"
              onPointerDown={beginSeek}
              onPointerMove={moveSeek}
              aria-label="Timeline ruler"
              title="Time ruler · click or drag to seek; separators mark time, not keyframes"
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
              {layout.duration > 0 && (
                <div className="timeline-ruler-playhead" style={{ left: leading + frame * scale }}>
                  <button aria-label="Drag playhead" onPointerDown={beginSeek} onPointerMove={moveSeek} />
                  {(draft || keyframes.active) && (
                    <span className="playhead-readout">{formatTimecode(frame)} · draft</span>
                  )}
                </div>
              )}
            </div>
            {project.layers.map((layer) => (
              <button
                className={`timeline-lane ${layer.id === selectedLayerId ? 'selected' : ''} ${layer.enabled ? '' : 'hidden-layer'}`}
                key={layer.id}
                data-layer-lane={layer.id}
                aria-label={`Timeline lane ${layer.name}`}
                disabled={interactionBlocked}
                style={{ top: rowTop(layer.id) - 5 }}
                onClick={() => onSelectLayer(layer.id)}
              >
                {layer.id === selectedLayerId && !layout.clips.some((item) => item.clip.layerId === layer.id) && (
                  <span className="timeline-lane-placeholder">Insert here</span>
                )}
              </button>
            ))}
            {selected && source && selectedLayer && (
              <div
                className="available-source"
                aria-label="Available original recording"
                style={{
                  top: rowTop(selected.clip.layerId) - 5,
                  left: leading + (selected.start - availableHead) * scale,
                  width:
                    compileLayerRetiming(
                      { ...selected.clip, sourceIn: 0, sourceOut: source.metadata.frameCount },
                      selectedLayer,
                      selected.start,
                    ).duration * scale,
                }}
              />
            )}
            {!geometry.clips.length && (
              <div className="timeline-empty">
                <Icon name="plus" size={18} />
                {timelineEmptyMessage(project)}
              </div>
            )}
            {geometry.clips.map((placed, index) => {
              const asset = assets.find((item) => item.id === placed.clip.mediaId);
              const currentPlaced = layout.clips.find((item) => item.clip.id === placed.clip.id) ?? placed;
              const clip = currentPlaced.clip;
              const isSelected = clip.id === selectedClipId;
              const offset =
                drag.current?.edge === 'in' && drag.current.clip.id === clip.id
                  ? placed.duration - currentPlaced.duration
                  : 0;
              const name = asset?.name ?? clip.mediaId;
              return (
                <div
                  className={`timeline-clip ${isSelected ? 'selected' : ''} ${clip.layerId === selectedLayerId ? 'active-layer' : ''} ${project.layers.find((layer) => layer.id === clip.layerId)?.enabled ? '' : 'disabled-layer'} ${movement.current?.payload.kind === 'clip' && movement.current.payload.clipId === clip.id ? 'moving' : ''}`}
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
                      (event.target instanceof HTMLElement && event.target.closest('[data-trim-handle]'))
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
                    movement.current = {
                      payload: { kind: 'clip', clipId: clip.id, grabFrame },
                      scale,
                      leading,
                      width,
                      base: project,
                      playhead: frame,
                    };
                    onPause();
                    onSelect(clip.id);
                    event.dataTransfer.setData(CLIP_DRAG_TYPE, clip.id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={clearMove}
                >
                  <button
                    className="timeline-clip-body"
                    aria-label={`Select ${name}, clip ${index + 1}`}
                    aria-pressed={isSelected}
                    disabled={interactionBlocked}
                    title={`${name} · ${project.layers.find((layer) => layer.id === clip.layerId)?.name} · ${placed.duration} timeline frames`}
                    onClick={(event) => {
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
                      {asset?.prepared?.thumbnailFrames.slice(0, 4).map((sourceFrame) => (
                        <img
                          loading="lazy"
                          draggable={false}
                          key={sourceFrame}
                          src={`/api/media/${asset.id}/thumbnail/${sourceFrame}`}
                          alt=""
                        />
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
                  {(['in', 'out'] as const).map((edge) => (
                    <button
                      key={edge}
                      className={`trim-handle ${edge}`}
                      data-trim-handle={edge}
                      role="slider"
                      aria-label={`Trim ${edge === 'in' ? 'start' : 'end'} of ${name}, clip ${index + 1}`}
                      disabled={keyframes.active || musicGesture !== null}
                      aria-valuemin={edge === 'in' ? 0 : clip.sourceIn + 1}
                      aria-valuemax={
                        edge === 'in' ? clip.sourceOut - 1 : (asset?.metadata.frameCount ?? clip.sourceOut)
                      }
                      aria-valuenow={edge === 'in' ? clip.sourceIn : clip.sourceOut}
                      aria-valuetext={sourceSeconds(edge === 'in' ? clip.sourceIn : clip.sourceOut)}
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
            <TimelineCutMarks
              marks={props.cutRange}
              selected={selected}
              top={rowTop(selected?.clip.layerId ?? project.layers[0]!.id)}
              leading={leading}
              scale={scale}
            />
            {project.layers.flatMap((layer) =>
              layer.keyframes.map((point) => {
                const settings = keySettings(point)
                  .map((setting) => KEYFRAME_SETTINGS.find((definition) => definition.key === setting)!.label)
                  .join(' · ');
                const active = keyframes.draft?.layerId === layer.id && keyframes.draft.origin === point.frame;
                const displayedFrame = active ? keyframes.draft!.frame : point.frame;
                const current =
                  layer.id === selectedLayerId &&
                  displayedFrame === keyframeNavigationFrame(keyframeNavigation.inspection, layer.id, frame);
                return (
                  <button
                    type="button"
                    key={`${layer.id}-${point.frame}`}
                    className={`timeline-layer-key ${current ? 'active' : ''} ${active ? 'moving' : ''} ${active && keyframes.draft!.error ? 'invalid' : ''}`}
                    data-layer-keyframe={displayedFrame}
                    data-keyframe-origin={point.frame}
                    data-keyframe-layer={layer.id}
                    aria-label={`Track keyframe ${displayedFrame} on ${layer.name}`}
                    aria-pressed={current}
                    title={`${layer.name} · ${formatTimecode(displayedFrame)} · ${settings} · Drag to move all animated settings; Arrow keys: 1 frame, Shift: 10. Alt bypasses snapping.`}
                    style={{ top: rowTop(layer.id) + 48, left: leading + displayedFrame * scale }}
                    draggable={false}
                    disabled={interactionBlocked && !active}
                    onPointerDown={(event) => keyframes.begin(event, layer.id, point.frame)}
                    onPointerMove={keyframes.move}
                    onPointerUp={keyframes.finish}
                    onPointerCancel={keyframes.cancel}
                    onLostPointerCapture={keyframes.cancel}
                    onKeyDown={(event) => keyframes.keyboard(event, layer.id, point.frame)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (event.detail === 0) keyframeNavigation.onSeekKeyframe(layer.id, point.frame);
                    }}
                  >
                    ◆
                    {active && (
                      <span className="timeline-layer-key-time" aria-hidden="true">
                        {formatTimecode(displayedFrame)}
                      </span>
                    )}
                  </button>
                );
              }),
            )}
            {geometry.transitions.map((region, index) => {
              const left =
                assets.find(
                  (asset) => asset.id === project.clips.find((clip) => clip.id === region.transition.leftId)?.mediaId,
                )?.name ?? `Clip ${index + 1}`;
              const position =
                region.transition.type === 'cross-dissolve' ? (region.start + region.end) / 2 : region.boundary;
              const label = { cut: 'Cut', 'cross-dissolve': 'Dissolve', 'fade-through-black': 'Fade' }[
                region.transition.type
              ];
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
            {keyframes.draft?.guide !== null && keyframes.draft?.guide !== undefined && (
              <div className="snap-guide" style={{ left: leading + keyframes.draft.guide * scale }} />
            )}
            {musicGesture?.guide !== null && musicGesture?.guide !== undefined && (
              <div className="snap-guide" style={{ left: leading + musicGesture.guide * scale }} />
            )}
            <TimelineMusicLanes
              project={project}
              audioAssets={audioAssets}
              selectedMusicId={selectedMusicId}
              onSelectMusic={onSelectMusic}
              top={musicTop}
              leading={leading}
              scale={scale}
              width={width}
              viewport={scroll}
              frame={frame}
              snapping={snapping}
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
              dragError || dropPlan?.error || keyframes.draft?.error || musicGesture?.error ? 'trim-error' : ''
            }
          >
            {interactionStatus}
          </span>
        </div>
      )}
    </section>
  );
}
