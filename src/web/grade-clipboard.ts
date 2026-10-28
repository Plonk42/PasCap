import type { EditCommand } from '../shared/commands.js';
import type { ColourSettings } from '../shared/colour.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';

/** Why a clip's grade cannot be copied, or null. Keyframes are source frames of one recording. */
export function copyGradeBlocked(clip: VideoClip): string | null {
  return clip.grade.keyframes.length
    ? 'This clip’s grade has keyframes; only a grade without keyframes can be copied.'
    : null;
}

/** Clips a paste on `clipId` grades: the whole selection when it includes that clip. */
export function pasteTargets(clipId: string, selected: readonly string[]): string[] {
  return selected.includes(clipId) ? [...selected] : [clipId];
}

/** Replace each target's grade with the copied one, removing its keyframes, in one Undo step. */
export function pasteGradeCommands(
  project: ProjectDocument,
  targets: readonly string[],
  colour: ColourSettings,
): EditCommand[] {
  const removals: EditCommand[] = project.clips
    .filter((clip) => targets.includes(clip.id))
    .flatMap((clip) =>
      clip.grade.keyframes.map((key): EditCommand => ({ type: 'layer-key-remove', clipId: clip.id, frame: key.frame })),
    );
  return [...removals, { type: 'colour', clipIds: [...targets], colour: structuredClone(colour) }];
}
