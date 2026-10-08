import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { layerClips } from '../shared/timeline.js';

/** Composition order constrains only stack edges, never track editing capabilities. */
export function layerActionRestrictions(index: number, count: number, unavailable: boolean) {
  const busy = unavailable ? 'Finish or cancel the active edit, or wait until the project preview is ready.' : null;
  return {
    raise: index === count - 1 ? 'This track is already the top composition layer.' : busy,
    lower: index === 0 ? 'This track is already the bottom composition layer.' : busy,
    remove: count === 1 ? 'Keep at least one video track. Delete its excerpts instead.' : busy,
  };
}

/** The first Ripple clip sets its anchor; later starts are authoritative derived slots. */
export function clipStartRestriction(project: ProjectDocument, clip: VideoClip): string | null {
  const layer = project.layers.find((item) => item.id === clip.layerId);
  if (!layer) return 'The video track no longer exists.';
  return layer.ripple && layerClips(project, layer.id)[0]?.id !== clip.id
    ? 'Later clips follow the first one while Ripple is on. Drag to reorder, or turn Ripple off in Layer options.'
    : null;
}
