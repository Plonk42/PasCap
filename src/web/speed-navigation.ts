import { useMemo, useState } from 'react';
import type { ProjectDocument, VideoClip, VideoLayer } from '../shared/model.js';
import { calculateLayout, type PlacedClip } from '../shared/timeline.js';
import {
  keyframeNavigationFrame,
  previewFrameFor,
  useKeyframeNavigation,
  type KeyframeInspection,
} from './keyframe-navigation.js';

export interface SpeedNavigationTarget {
  id: string;
  /** Stored project time for track keys; nearest actual preview time for clip keys. */
  frame: number;
  source: number | null;
}

export interface SpeedNavigationContext {
  projectId: string;
  layerId: string;
  clipId: string | null;
  resetKey: string | number;
}

/** Clip-only editor cursor. Track inspection remains owned by the central context. */
export interface SpeedInspection {
  context: SpeedNavigationContext;
  source: number;
  sources: readonly number[];
  observedFrame: number;
  expectedFrame: number;
}

/** Same nearest-image rule as previewClipSource, using the already compiled map. */
export function previewPlacedSpeedSource(placed: PlacedClip, sourceFrame: number): number {
  if (sourceFrame <= placed.clip.sourceIn) return placed.start;
  if (sourceFrame >= placed.clip.sourceOut) return placed.end - 1;
  const before = placed.retiming.outputAt(sourceFrame);
  const after = Math.min(placed.duration - 1, before + 1);
  const beforeDistance = Math.abs(placed.retiming.sourceAt(before) - sourceFrame);
  const afterDistance = Math.abs(placed.retiming.sourceAt(after) - sourceFrame);
  return placed.start + (afterDistance < beforeDistance ? after : before);
}

function compareTargets(left: SpeedNavigationTarget, right: SpeedNavigationTarget): number {
  if (left.frame !== right.frame) return left.frame - right.frame;
  if (left.source === null) return right.source === null ? 0 : -1;
  if (right.source === null) return 1;
  return left.source - right.source;
}

/** At most 256 track + 256 retained clip keys; never enumerate output frames. */
export function buildSpeedNavigationTargets(
  project: ProjectDocument,
  clip: VideoClip | null,
  layer: VideoLayer,
): SpeedNavigationTarget[] {
  const targets: SpeedNavigationTarget[] = layer.keyframes
    .filter((key) => key.values.speed !== null)
    .map((key) => ({ id: `track:${key.frame}`, frame: key.frame, source: null }));
  if (clip?.layerId === layer.id && clip.speed.mode === 'curve') {
    const placed = calculateLayout(project).clips.find((item) => item.clip.id === clip.id);
    if (placed) {
      for (const key of clip.speed.keyframes)
        targets.push({
          id: `clip:${key.frame}`,
          frame: previewPlacedSpeedSource(placed, key.frame),
          source: key.frame,
        });
    }
  }
  return targets.sort(compareTargets);
}

function clipSources(targets: readonly SpeedNavigationTarget[]): number[] {
  return targets.flatMap((target) => (target.source === null ? [] : [target.source]));
}

export function inspectSpeedTarget(
  context: SpeedNavigationContext,
  targets: readonly SpeedNavigationTarget[],
  target: SpeedNavigationTarget,
  frame: number,
  duration: number,
): SpeedInspection | null {
  if (target.source === null || !targets.some((item) => item.id === target.id)) return null;
  return {
    context,
    source: target.source,
    sources: clipSources(targets),
    observedFrame: frame,
    expectedFrame: previewFrameFor(target.frame, duration),
  };
}

function sameContext(left: SpeedNavigationContext, right: SpeedNavigationContext): boolean {
  return (
    left.projectId === right.projectId &&
    left.layerId === right.layerId &&
    left.clipId === right.clipId &&
    left.resetKey === right.resetKey
  );
}

function retainedSource(inspection: SpeedInspection, sources: readonly number[]): number | null {
  const current = new Set(sources);
  if (current.has(inspection.source)) return inspection.source;
  const previous = new Set(inspection.sources);
  const removed = inspection.sources.filter((source) => !current.has(source));
  const added = sources.filter((source) => !previous.has(source));
  return removed.length === 1 && removed[0] === inspection.source && added.length === 1 ? added[0]! : null;
}

/** Follow a single source-key move/Undo, but not deletion, foreign contexts or distinct external seeks. */
export function reconcileSpeedInspection(
  inspection: SpeedInspection | null,
  context: SpeedNavigationContext,
  targets: readonly SpeedNavigationTarget[],
  frame: number,
  duration: number,
  centralInspection: KeyframeInspection | null,
): SpeedInspection | null {
  if (!inspection || !sameContext(inspection.context, context) || centralInspection) return null;
  const sources = clipSources(targets);
  const source = retainedSource(inspection, sources);
  const target = targets.find((item) => item.source === source && item.source !== null);
  if (!target) return null;
  const expectedFrame = previewFrameFor(target.frame, duration);
  // Keep old diagnostics only until the asynchronous navigation seek is observed.
  if (frame !== inspection.observedFrame && frame !== inspection.expectedFrame && frame !== expectedFrame) return null;
  const unchangedSources =
    sources.length === inspection.sources.length &&
    sources.every((value, index) => value === inspection.sources[index]);
  if (
    unchangedSources &&
    source === inspection.source &&
    frame === inspection.observedFrame &&
    expectedFrame === inspection.expectedFrame
  )
    return inspection;
  return { ...inspection, source: target.source!, sources, observedFrame: frame, expectedFrame };
}

function previousTarget(
  targets: readonly SpeedNavigationTarget[],
  reference: number,
): SpeedNavigationTarget | undefined {
  for (let index = targets.length - 1; index >= 0; index--)
    if (targets[index]!.frame < reference) return targets[index];
  return undefined;
}

/** Central track selection and local clip selection are distinct, even at identical preview times. */
export function speedNavigationPosition(
  targets: readonly SpeedNavigationTarget[],
  context: SpeedNavigationContext,
  frame: number,
  inspection: SpeedInspection | null,
  centralInspection: KeyframeInspection | null,
) {
  const central =
    centralInspection?.projectId === context.projectId && centralInspection.layerId === context.layerId
      ? centralInspection
      : null;
  let cursor = -1;
  if (central) cursor = targets.findIndex((target) => target.source === null && target.frame === central.frame);
  else if (inspection && sameContext(inspection.context, context))
    cursor = targets.findIndex((target) => target.source === inspection.source);
  const reference = keyframeNavigationFrame(central, context.layerId, frame);
  return {
    cursor,
    previous: cursor >= 0 ? targets[cursor - 1] : previousTarget(targets, reference),
    next: cursor >= 0 ? targets[cursor + 1] : targets.find((target) => target.frame > reference),
    inspectedFrame: cursor >= 0 ? targets[cursor]!.source : null,
  };
}

interface SpeedNavigationProps {
  project: ProjectDocument;
  clip: VideoClip | null;
  layer: VideoLayer;
  frame: number;
  projectDuration: number;
  onSeek: (frame: number) => void;
  resetKey?: string | number;
}

export function useSpeedNavigation({
  project,
  clip,
  layer,
  frame,
  projectDuration,
  onSeek,
  resetKey,
}: Readonly<SpeedNavigationProps>) {
  const navigation = useKeyframeNavigation();
  const targets = useMemo(() => buildSpeedNavigationTargets(project, clip, layer), [project, clip, layer]);
  const context: SpeedNavigationContext = {
    projectId: project.id,
    layerId: layer.id,
    clipId: clip?.id ?? null,
    resetKey: `${resetKey ?? project.id}:${navigation.sourceEpoch ?? 0}`,
  };
  const [storedInspection, setStoredInspection] = useState<SpeedInspection | null>(null);
  const inspection = reconcileSpeedInspection(
    navigation.playing ? null : storedInspection,
    context,
    targets,
    frame,
    projectDuration,
    navigation.inspection,
  );
  if (inspection !== storedInspection) setStoredInspection(inspection);
  const position = speedNavigationPosition(targets, context, frame, inspection, navigation.inspection);
  const seekTarget = (target: SpeedNavigationTarget | undefined): void => {
    if (!target || navigation.disabled) return;
    setStoredInspection(inspectSpeedTarget(context, targets, target, frame, projectDuration));
    if (target.source === null) navigation.onSeekKeyframe(layer.id, target.frame);
    else {
      navigation.onFollowPlayhead();
      (navigation.onSeekSourceKeyframe ?? onSeek)(target.frame);
    }
  };
  /** Parent may call alongside stored clip selection/preview; this callback itself never seeks. */
  const onSelectStored = (sourceFrame: number): void => {
    if (navigation.disabled) return;
    const target = targets.find((item) => item.source === sourceFrame);
    if (!target) return;
    navigation.onFollowPlayhead();
    setStoredInspection(inspectSpeedTarget(context, targets, target, frame, projectDuration));
  };
  return { navigation, targets, ...position, seekTarget, onSelectStored };
}
