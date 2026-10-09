import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { snapFrame } from '../shared/snap.js';
import { calculateLayout } from '../shared/timeline.js';
import { previewFrameFor } from './keyframe-navigation.js';
import type { KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';
import type { InspectorSectionTarget } from './InspectorSection.js';

/** A shared keyframe opens Colour when it enables any colour or Opacity setting, otherwise Speed. */
export function keyframeSection(values: Readonly<Record<string, number | null>>): InspectorSectionTarget {
  return Object.entries(values).some(([setting, value]) => setting !== 'speed' && value !== null) ? 'colour' : 'speed';
}

type MoveKey = Extract<EditCommand, { type: 'layer-key-move' }>;
export interface KeyframeDragPlan {
  frame: number;
  document: ProjectDocument;
  command: MoveKey | null;
  guide: number | null;
  error: string;
}

/** Track keyframes live at timeline frames 0–2,147,483,647. */
export function trackKeyframeFrame(origin: number, travel: number): number {
  return Math.max(0, Math.min(2_147_483_647, origin + travel));
}

export function planKeyframeDrag(
  project: ProjectDocument,
  layerId: string,
  frame: number,
  nextFrame: number,
  targets: readonly number[],
  tolerance: number,
): KeyframeDragPlan {
  const snapped = snapFrame(nextFrame, targets, tolerance);
  const command: MoveKey = { type: 'layer-key-move', layerId, frame, nextFrame: snapped };
  try {
    const document = applyCommand(project, command);
    return {
      frame: snapped,
      document,
      command: snapped === frame ? null : command,
      guide: snapped === nextFrame ? null : snapped,
      error: '',
    };
  } catch (cause) {
    return {
      frame: snapped,
      document: project,
      command: null,
      guide: null,
      error: cause instanceof Error ? cause.message : 'Cannot move this track keyframe.',
    };
  }
}

/** Shared track keyframes move in timeline frames. */
export function trackKeyframeKind(options: {
  onSelectLayer: (id: string) => void;
  onSeekKeyframe: (layerId: string, frame: number) => void;
  onOpenSection: (section: InspectorSectionTarget) => void;
}): KeyframeSlideKind<KeyframeSlideTarget> {
  return {
    at: ({ origin }, travel) => trackKeyframeFrame(origin, travel),
    planAt: (project, { scope, origin }, at) => planKeyframeDrag(project, scope, origin, at, [], 0),
    step: (project, { scope, origin }, delta) =>
      planKeyframeDrag(project, scope, origin, trackKeyframeFrame(origin, delta), [], 0),
    seekFrame: (document, _target, frame) => previewFrameFor(frame, calculateLayout(document).duration),
    select: ({ scope }) => options.onSelectLayer(scope),
    reveal: (document, { scope }, frame, open) => {
      options.onSeekKeyframe(scope, frame);
      const point = document.layers.find((layer) => layer.id === scope)?.keyframes.find((item) => item.frame === frame);
      if (open && point) options.onOpenSection(keyframeSection(point.values));
    },
    selector: ({ scope }, frame) => `[data-keyframe-layer="${CSS.escape(scope)}"][data-layer-keyframe="${frame}"]`,
  };
}
