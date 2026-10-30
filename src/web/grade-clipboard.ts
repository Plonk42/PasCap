import type { EditCommand } from '../shared/commands.js';
import type { ColorSettings } from '../shared/color.js';
import type { ProjectDocument } from '../shared/model.js';

/** A clip's grade or an adjustment, as right-clicked or selected on the timeline. */
export interface GradeTarget {
  kind: 'clip' | 'adjustment';
  id: string;
}

function gradeOf(project: ProjectDocument, target: GradeTarget) {
  if (target.kind === 'clip') return project.clips.find((clip) => clip.id === target.id)?.grade;
  return project.adjustments.find((item) => item.id === target.id);
}

/** Why a grade cannot be copied, or null. A right-click points at no frame, so keyed grades have no single value. */
export function copyGradeBlocked(project: ProjectDocument, target: GradeTarget): string | null {
  const grade = gradeOf(project, target);
  const noun = target.kind === 'clip' ? 'clip' : 'adjustment';
  if (!grade) return `This ${noun} no longer exists.`;
  return grade.keyframes.length
    ? `This ${noun}’s grade has keyframes; only a grade without keyframes can be copied.`
    : null;
}

/** The Color a copy takes, or null when it cannot be copied. */
export function copiedColor(project: ProjectDocument, target: GradeTarget): ColorSettings | null {
  const grade = gradeOf(project, target);
  return grade && !copyGradeBlocked(project, target) ? structuredClone(grade.color) : null;
}

const same = (left: GradeTarget, right: GradeTarget): boolean => left.kind === right.kind && left.id === right.id;

/** What a paste on `target` grades: the whole selection when it includes that target. */
export function pasteTargets(target: GradeTarget, selected: readonly GradeTarget[]): GradeTarget[] {
  return selected.some((item) => same(item, target)) ? [...selected] : [target];
}

/** "1 clip", "3 adjustments". */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "this clip", "these 3 adjustments", "2 clips and 1 adjustment". */
export function pasteTargetsLabel(targets: readonly GradeTarget[]): string {
  const clips = targets.filter((target) => target.kind === 'clip').length;
  const adjustments = targets.length - clips;
  if (targets.length === 1) return clips ? 'this clip' : 'this adjustment';
  if (!adjustments) return `these ${countOf(clips, 'clip')}`;
  if (!clips) return `these ${countOf(adjustments, 'adjustment')}`;
  return `${countOf(clips, 'clip')} and ${countOf(adjustments, 'adjustment')}`;
}

/** Replace each target's grade with the copied one, removing its keyframes, in one Undo step. */
export function pasteGradeCommands(
  project: ProjectDocument,
  targets: readonly GradeTarget[],
  color: ColorSettings,
): EditCommand[] {
  const clipIds = targets.filter((target) => target.kind === 'clip').map((target) => target.id);
  const adjustmentIds = new Set(targets.filter((target) => target.kind === 'adjustment').map((target) => target.id));
  const commands: EditCommand[] = project.clips
    .filter((clip) => clipIds.includes(clip.id))
    .flatMap((clip) =>
      clip.grade.keyframes.map((key): EditCommand => ({ type: 'layer-key-remove', clipId: clip.id, frame: key.frame })),
    );
  if (clipIds.length) commands.push({ type: 'color', clipIds, color: structuredClone(color) });
  for (const item of project.adjustments.filter((entry) => adjustmentIds.has(entry.id))) {
    for (const key of item.keyframes)
      commands.push({ type: 'layer-key-remove', adjustmentId: item.id, frame: key.frame });
    commands.push({ type: 'color', adjustmentId: item.id, color: structuredClone(color) });
  }
  return commands;
}
