import { applyCommand, type EditCommand } from '../commands.js';
import { createDetailSettings } from '../detail.js';
import { MAX_VIDEO_LAYERS, type MusicLane, type ProjectDocument } from '../model.js';
import { musicClipEnd, validateMusicLane } from '../music-lanes.js';
import { NORMAL_SPEED } from '../speed.js';
import type { AutoEditPlan } from './plan.js';

/**
 * Where the cut goes. replace: the project becomes the cut (its video tracks and adjustments removed, only the
 * followed music kept), for a copy of a project; track: a new track above the others, which are hidden, and the
 * adjustments turned off, for an assistant editing the user's project.
 */
export type AutoEditPlacement = 'replace' | 'track';
export const AUTO_EDIT_TRACK_NAME = 'Auto edit';

/** The music the cut follows: a track of the project, or a new one placing a recording. */
export type FollowedMusic = { lane: MusicLane; placed: boolean } | null;

export interface BuiltCut {
  commands: EditCommand[];
  document: ProjectDocument;
  layerId: string;
  clipIds: string[];
  /** What could not be done as planned, in words. */
  notes: string[];
}

/** `base`, else `base-2`, `base-3`…, unused by `taken`. */
export function unusedId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/** A music track ending at `end` (its later clips removed, the last shortened) with a closing fade; unchanged when it ends sooner. */
export function laneEndingAt(lane: MusicLane, end: number, closingFade: number): MusicLane {
  const last = lane.clips.at(-1)!;
  if (musicClipEnd(last) <= end) return lane;
  const clips = lane.clips
    .filter((clip, index) => index === 0 || clip.start < end)
    .map((clip) => (musicClipEnd(clip) > end ? { ...clip, duration: Math.max(1, end - clip.start) } : clip));
  const ids = new Set(clips.map((clip) => clip.id));
  const trimmed: MusicLane = {
    ...lane,
    clips,
    transitions: lane.transitions.filter((transition) => ids.has(transition.leftId) && ids.has(transition.rightId)),
    closingFade,
  };
  for (const fade of [closingFade, 0]) {
    const candidate = { ...trimmed, closingFade: fade };
    try {
      validateMusicLane(candidate);
      return candidate;
    } catch {
      // A fade that does not fit the shortened clip is left out.
    }
  }
  return lane;
}

function musicLanes(
  project: ProjectDocument,
  music: FollowedMusic,
  plan: AutoEditPlan,
  placement: AutoEditPlacement,
): MusicLane[] | null {
  if (!music) return placement === 'replace' && project.music.length ? [] : null;
  const lane = laneEndingAt(music.lane, plan.span.end, plan.closingFade);
  if (placement === 'replace') return [lane];
  if (!music.placed) return [...project.music, lane];
  return lane === music.lane ? null : project.music.map((item) => (item.id === lane.id ? lane : item));
}

/** Commands making room for the cut's track: removing (replace) or hiding (track) what was there. */
function clearingCommands(project: ProjectDocument, layerId: string, placement: AutoEditPlacement): EditCommand[] {
  if (placement === 'replace') {
    const [first, ...others] = project.layers;
    return [
      ...others.map((layer) => ({ type: 'layer-remove' as const, layerId: layer.id })),
      { type: 'layer-create', layerId, name: AUTO_EDIT_TRACK_NAME },
      { type: 'layer-remove', layerId: first!.id },
      ...project.adjustments.map((item) => ({ type: 'adjustment-remove' as const, adjustmentId: item.id })),
    ];
  }
  if (project.layers.length >= MAX_VIDEO_LAYERS)
    throw new Error(
      `The project already has ${MAX_VIDEO_LAYERS} video tracks, the most it can hold: remove one for the auto edit's track.`,
    );
  const enabled = project.adjustments.filter((item) => item.enabled).map((item) => item.id);
  return [
    { type: 'layer-create', layerId, name: AUTO_EDIT_TRACK_NAME },
    ...project.layers
      .filter((layer) => layer.enabled)
      .map((layer) => ({ type: 'layer-options' as const, layerId: layer.id, enabled: false })),
    ...(enabled.length ? [{ type: 'adjustment-enable' as const, adjustmentIds: enabled, enabled: false }] : []),
  ];
}

/**
 * The edit commands building a planned cut on `project`, and the project they give: the track, the music, one clip
 * per planned clip at normal speed, the transitions (dissolves keeping the cut on the beat; one that the footage
 * cannot extend stays a cut) and the track's fades. Throws when the project cannot hold the cut.
 */
export function buildCut(
  project: ProjectDocument,
  plan: AutoEditPlan,
  music: FollowedMusic,
  placement: AutoEditPlacement,
): BuiltCut {
  const taken = new Set([...project.layers.map((layer) => layer.id), ...project.clips.map((clip) => clip.id)]);
  const layerId = unusedId('auto-edit', taken);
  taken.add(layerId);
  const clipIds = plan.clips.map((_, index) => {
    const id = unusedId(`auto-${index + 1}`, taken);
    taken.add(id);
    return id;
  });
  const notes: string[] = [];
  const lanes = musicLanes(project, music, plan, placement);
  const commands: EditCommand[] = [
    ...clearingCommands(project, layerId, placement),
    ...(lanes ? [{ type: 'music' as const, music: lanes }] : []),
  ];
  let document = commands.reduce((current, command) => applyCommand(current, command), project);
  // Inserts go after the clips that remain once tracks are removed.
  const kept = document.clips.length;
  plan.clips.forEach((planned, index) => {
    const command: EditCommand = {
      type: 'insert',
      index: kept + index,
      clip: {
        id: clipIds[index]!,
        mediaId: planned.candidate.mediaId,
        layerId,
        start: plan.span.start,
        sourceIn: planned.sourceIn,
        sourceOut: planned.sourceOut,
        speed: { ...NORMAL_SPEED },
        reverse: false,
        detail: createDetailSettings(),
      },
    };
    document = applyCommand(document, command);
    commands.push(command);
  });
  const tryCommand = (command: EditCommand, failure: string): void => {
    try {
      document = applyCommand(document, command);
      commands.push(command);
    } catch (error) {
      notes.push(`${failure}: ${error instanceof Error ? error.message : 'refused'}`);
    }
  };
  plan.transitions.forEach((transition, index) => {
    if (transition.type === 'cut') return;
    const leftId = clipIds[index]!;
    const rightId = clipIds[index + 1]!;
    tryCommand(
      {
        type: 'transition',
        transition: { ...transition, leftId, rightId },
        ...(transition.type === 'cross-dissolve' && { keepCut: true }),
      },
      `Clips ${index + 1} and ${index + 2} keep a cut instead of a ${transition.type === 'cross-dissolve' ? 'dissolve' : 'fade through black'}`,
    );
  });
  if (plan.openingFade || plan.closingFade)
    tryCommand(
      { type: 'fades', layerId, opening: plan.openingFade || null, closing: plan.closingFade || null },
      'The track has no fades',
    );
  return { commands, document, layerId, clipIds, notes };
}
