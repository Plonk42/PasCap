import type { AutoEditChoices } from '../shared/auto-edit/options.js';
import type { AutoEditReport } from '../shared/auto-edit/report.js';
import { readPreference, writePreference } from './preferences.js';

/** The auto edit result whose report a project shows, remembered by this browser per project. */
const RESULT_PREFERENCE = 'pascap-auto-edit-';

export function autoEditResultOf(projectId: string): string | null {
  return readPreference(`${RESULT_PREFERENCE}${projectId}`);
}

export function rememberAutoEditResult(projectId: string, resultId: string): void {
  writePreference(`${RESULT_PREFERENCE}${projectId}`, resultId);
}

export const PACE_LABELS: Readonly<Record<AutoEditChoices['pace'], string>> = {
  calm: 'Calm',
  balanced: 'Balanced',
  energetic: 'Energetic',
};
export const ORDER_LABELS: Readonly<Record<AutoEditChoices['order'], string>> = {
  flight: 'As filmed',
  energy: 'By energy',
};
export const TRANSITION_LABELS: Readonly<Record<AutoEditChoices['transitions'], string>> = {
  auto: 'Mixed',
  cuts: 'Cuts only',
  soft: 'Soft',
};
export const GRADE_LABELS: Readonly<Record<AutoEditChoices['grade'], string>> = {
  match: 'Auto + match',
  auto: 'Auto only',
  none: 'None',
};

/** "18 clips · 01:02:15 on Song.mp3", as the report and Activity summarize a cut. */
export function autoEditHeadline(report: AutoEditReport): string {
  const music = report.music ? ` on ${report.music.recording}` : '';
  return `${report.clips.length} clip${report.clips.length === 1 ? '' : 's'} · ${report.duration.timecode}${music}`;
}

/** "14 of 17 cuts on a downbeat or strong hit", or null without music. */
export function alignmentLine(report: AutoEditReport): string | null {
  const alignment = report.alignment;
  if (!alignment?.boundaries) return null;
  const strong = Math.max(alignment.onDownbeat, alignment.onHit);
  return `${alignment.onBeat} of ${alignment.boundaries} cuts on a beat, ${strong} on a downbeat or strong hit`;
}

/** How the cut was graded, in words. */
export function gradeLine(report: AutoEditReport): string {
  const { grade } = report;
  if (grade.choice === 'none') return 'Clip grades left neutral';
  if (grade.style) return `Every clip matched to the style ${grade.style.name}`;
  if (grade.hero)
    return `Auto per clip, then matched to clip ${report.clips.findIndex((clip) => clip.clipId === grade.hero!.clipId) + 1} (${grade.hero.recording})`;
  return 'Auto per clip';
}
