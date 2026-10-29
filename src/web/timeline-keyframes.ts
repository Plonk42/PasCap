import { applyCommand, type EditCommand } from '../shared/commands.js';
import type { ProjectDocument } from '../shared/model.js';
import { calculateLayout } from '../shared/timeline.js';
import { previewFrameFor } from './keyframe-navigation.js';
import type { KeyframeMove, KeyframeSlideKind, KeyframeSlideTarget } from './keyframe-slide.js';
import type { InspectorSectionTarget } from './InspectorSection.js';
import { removeSpatialKey, replaceSpatialKey } from './spatial-editor.js';

/** Track Transform keyframes and bookmarks live at timeline frames 0–2,147,483,647. */
export function trackKeyframeFrame(origin: number, travel: number): number {
  return Math.max(0, Math.min(2_147_483_647, origin + travel));
}

/** Moves one track Transform keyframe to another timeline frame; an occupied frame rejects the move. */
export function planTransformKeyframeMove(
  project: ProjectDocument,
  layerId: string,
  frame: number,
  nextFrame: number,
): KeyframeMove {
  const fail = (error: string): KeyframeMove => ({ frame: nextFrame, document: project, command: null, error });
  const layer = project.layers.find((item) => item.id === layerId);
  if (!layer) return fail('Track no longer exists.');
  try {
    const command: EditCommand = {
      type: 'transform',
      layerId,
      transform: replaceSpatialKey(layer.transform, frame, { frame: nextFrame }),
    };
    return {
      frame: nextFrame,
      document: applyCommand(project, command),
      command: nextFrame === frame ? null : command,
      error: '',
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : 'Cannot move this Transform keyframe.');
  }
}

/** Track Transform keyframes move in timeline frames. */
export function transformKeyframeKind(options: {
  onSelectLayer: (id: string) => void;
  onSeek: (frame: number) => void;
  onOpenSection: (section: InspectorSectionTarget) => void;
}): KeyframeSlideKind<KeyframeSlideTarget> {
  const seekFrame = (document: ProjectDocument, frame: number): number =>
    previewFrameFor(frame, calculateLayout(document).duration);
  return {
    at: ({ origin }, travel) => trackKeyframeFrame(origin, travel),
    planAt: (project, { scope, origin }, at) => planTransformKeyframeMove(project, scope, origin, at),
    step: (project, { scope, origin }, delta) =>
      planTransformKeyframeMove(project, scope, origin, trackKeyframeFrame(origin, delta)),
    seekFrame: (document, _target, frame) => seekFrame(document, frame),
    select: ({ scope }) => options.onSelectLayer(scope),
    reveal: (document, _target, frame, open) => {
      options.onSeek(seekFrame(document, frame));
      if (open) options.onOpenSection('transform');
    },
    selector: ({ scope }, frame) => `[data-transform-layer="${CSS.escape(scope)}"][data-transform-keyframe="${frame}"]`,
    remove: (project, { scope, origin }) => ({
      type: 'transform',
      layerId: scope,
      transform: removeSpatialKey(project.layers.find((layer) => layer.id === scope)!.transform, origin),
    }),
  };
}
