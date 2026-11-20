import type { Brief } from '../shared/assistant-session.js';
import {
  findCandidates,
  measurePictures,
  pictureFrames,
  pictureRisks,
  scoreCandidates,
  type AutoEditRecording,
  type Candidate,
} from '../shared/auto-edit/candidates.js';
import { candidateSimilarity } from '../shared/auto-edit/cluster.js';
import { buildCut, type AutoEditPlacement } from '../shared/auto-edit/commands.js';
import { AUTO_EDIT } from '../shared/auto-edit/constants.js';
import { followMusic, musicTimeline, type MusicTimeline } from '../shared/auto-edit/music.js';
import type { AutoEditChoices } from '../shared/auto-edit/options.js';
import { planAutoEdit, type AutoEditPlan } from '../shared/auto-edit/plan.js';
import { cutReport, type AutoEditReport } from '../shared/auto-edit/report.js';
import type { EditCommand } from '../shared/commands.js';
import { sceneLikeness } from '../shared/look-match.js';
import type { ProjectDocument } from '../shared/model.js';
import type { MotionAnalysis } from '../shared/motion-analysis.js';
import { steadyLimitsError, steadyLimitsFrom } from '../shared/motion-analysis.js';
import type { MusicAnalysis } from '../shared/music-analysis.js';
import { estimate, MAX_ESTIMATE_CLIPS } from '../shared/operations/estimate.js';
import { forEachSerial } from '../shared/serial.js';
import { PROJECT_FPS, secondsToFrames, videoRate } from '../shared/timing.js';
import { errorMessage, ServiceError } from './errors.js';
import type { ServiceContext } from './operations/context.js';
import { applyBatch } from './operations/edit.js';
import { runEstimate } from './operations/estimate.js';

export interface AutoEditRequest {
  brief: Brief;
  choices: AutoEditChoices;
}

export interface AutoEditOutcome {
  /** The project with the cut, graded. */
  document: ProjectDocument;
  /** The commands turning the project into it, in order. */
  commands: EditCommand[];
  report: AutoEditReport;
}

export type Progress = (share: number, message: string) => void;

const FPS = PROJECT_FPS.numerator / PROJECT_FPS.denominator;
/** Shares of the work: reading pictures, then grading. */
const PICTURES = 0.6;
/** Clips graded per estimate call, so progress moves and one failure costs little. */
const GRADE_CHUNK = 8;

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ServiceError('Auto edit canceled.', 499);
}

async function readMotion(context: ServiceContext, mediaId: string): Promise<MotionAnalysis | null> {
  try {
    return await context.library.motion(mediaId);
  } catch {
    return null;
  }
}

/** The bin's prepared, analyzed recordings, and why the others are skipped. */
async function readRecordings(context: ServiceContext, project: ProjectDocument) {
  const recordings: AutoEditRecording[] = [];
  const skipped: AutoEditReport['skipped'] = [];
  await forEachSerial(project.media.videoIds, async (mediaId) => {
    const asset = context.library.get(mediaId);
    if (asset.status !== 'ready' || !asset.prepared) {
      skipped.push({ mediaId, recording: asset.name, reason: 'Not prepared.' });
      return;
    }
    const analysis = await readMotion(context, mediaId);
    if (!analysis) {
      skipped.push({ mediaId, recording: asset.name, reason: 'Camera motion not analyzed.' });
      return;
    }
    recordings.push({
      mediaId,
      name: asset.name,
      frameCount: asset.metadata.frameCount,
      rate: videoRate(project, mediaId),
      analysis,
      damage: asset.damage,
      kept: project.selects[mediaId],
    });
  });
  return { recordings, skipped };
}

async function readMusicAnalysis(context: ServiceContext, mediaId: string): Promise<MusicAnalysis | null> {
  try {
    return await context.audio.analysis(mediaId);
  } catch {
    return null;
  }
}

/** The music the cut follows, at project frames, with its analyses; null without music. */
async function readMusic(context: ServiceContext, project: ProjectDocument, brief: Brief) {
  const analyses = new Map<string, MusicAnalysis | null>();
  const load = async (mediaId: string) => {
    if (!analyses.has(mediaId)) analyses.set(mediaId, await readMusicAnalysis(context, mediaId));
    return analyses.get(mediaId)!;
  };
  if (brief.musicId !== null && project.media.audioIds.includes(brief.musicId)) await load(brief.musicId);
  let followed;
  try {
    followed = followMusic(project, brief, (mediaId) => ({
      frameCount: context.audio.get(mediaId).metadata.frameCount,
      analysis: analyses.get(mediaId) ?? null,
    }));
  } catch (error) {
    throw new ServiceError(errorMessage(error), 404);
  }
  if (!followed) return { followed: null, timeline: null, description: null, notes: [] };
  await forEachSerial(followed.lane.clips, async (clip) => {
    await load(clip.mediaId);
  });
  const timeline = musicTimeline(followed.lane, (mediaId) => analyses.get(mediaId) ?? null);
  const first = followed.lane.clips[0]!;
  const name = context.audio.get(first.mediaId).name;
  const unanalyzed = followed.lane.clips.find((clip) => !analyses.get(clip.mediaId));
  if (unanalyzed)
    throw new ServiceError(
      `${context.audio.get(unanalyzed.mediaId).name} has no beat analysis yet: analyze it (Hand off → Analyze, or Audio → Music) before an auto edit.`,
      409,
    );
  const notes = timeline.beats.length
    ? []
    : [
        `${name} has no steady beat: the clips have even lengths${timeline.strongHits.length ? ' and cut on its strong hits' : ''}.`,
      ];
  return {
    followed,
    timeline,
    description: { trackId: followed.lane.id, recording: name, placed: !followed.placed, analyzed: true },
    notes,
  };
}

/** Each candidate's pictures: three analysis frames and the middle one as luma, one recording at a time. */
async function readPictures(
  context: ServiceContext,
  candidates: readonly Candidate[],
  progress: Progress,
  signal: AbortSignal | undefined,
): Promise<Candidate[]> {
  const byRecording = new Map<string, Candidate[]>();
  for (const candidate of candidates)
    byRecording.set(candidate.mediaId, [...(byRecording.get(candidate.mediaId) ?? []), candidate]);
  const measured = new Map<string, Candidate>();
  let done = 0;
  await forEachSerial([...byRecording], async ([mediaId, group]) => {
    checkSignal(signal);
    const frames = group.flatMap(pictureFrames);
    const middles = group.map((candidate) => pictureFrames(candidate)[1]!);
    const decoded = await context.stills.analysisFrames(mediaId, frames);
    const luma = await context.stills.lumaFrames(mediaId, middles);
    group.forEach((candidate, index) => {
      const pictures = pictureFrames(candidate).map((frame) => decoded.get(frame)!);
      measured.set(candidate.id, { ...candidate, pictures: measurePictures(pictures, [luma[index]!]) });
    });
    done += group.length;
    progress((PICTURES * done) / candidates.length, `Looked at ${done} of ${candidates.length} steady ranges`);
  });
  return candidates.map((candidate) => measured.get(candidate.id)!);
}

/** The clip whose look the others match: the best of those most alike the rest of the cut; null for one clip. */
export function chooseHero(plan: AutoEditPlan): number | null {
  const { clips } = plan;
  if (clips.length < 2) return null;
  const means = clips.map((clip, i) => {
    const others = clips.filter((_, j) => j !== i);
    return (
      others.reduce((sum, other) => sum + sceneLikeness(candidateSimilarity(clip.candidate, other.candidate)), 0) /
      others.length
    );
  });
  const most = Math.max(...means);
  let hero: number | null = null;
  let value = Number.NEGATIVE_INFINITY;
  clips.forEach((clip, index) => {
    if (means[index]! < AUTO_EDIT.heroShare * most) return;
    const worth = clip.candidate.quality * (1 - pictureRisks(clip.candidate).exposure);
    if (worth > value) {
      value = worth;
      hero = index;
    }
  });
  return hero;
}

interface Graded {
  document: ProjectDocument;
  commands: EditCommand[];
  report: AutoEditReport['grade'];
}

/** Commands of estimates on the in-memory cut, chunk by chunk; a chunk that fails is retried clip by clip. */
async function estimateChunks(
  context: ServiceContext,
  document: () => ProjectDocument,
  clipIds: readonly string[],
  input: Record<string, unknown>,
  onChunk: (done: number) => void,
): Promise<{ commands: EditCommand[]; failed: string[] }> {
  const commands: EditCommand[] = [];
  const failed: string[] = [];
  const local: ServiceContext = { ...context, projects: { ...context.projects, load: async () => document() } };
  const run = async (ids: readonly string[]) => {
    const parsed = estimate.input.parse({ projectId: document().id, applyAs: 'shots', clipIds: ids, ...input });
    return (await runEstimate(local, parsed)).commands;
  };
  const chunks: string[][] = [];
  for (let index = 0; index < clipIds.length; index += Math.min(GRADE_CHUNK, MAX_ESTIMATE_CLIPS))
    chunks.push(clipIds.slice(index, index + GRADE_CHUNK));
  let done = 0;
  await forEachSerial(chunks, async (chunk) => {
    try {
      commands.push(...(await run(chunk)));
    } catch {
      await forEachSerial(chunk, async (clipId) => {
        try {
          commands.push(...(await run([clipId])));
        } catch (error) {
          failed.push(`${clipId}: ${errorMessage(error)}`);
        }
      });
    }
    done += chunk.length;
    onChunk(done);
  });
  return { commands, failed };
}

/** The grade the choice asks for, on the in-memory cut: Auto per clip, then a match to the style or the hero. */
async function gradeCut(
  context: ServiceContext,
  cut: { document: ProjectDocument; clipIds: readonly string[]; plan: AutoEditPlan },
  request: AutoEditRequest,
  progress: Progress,
): Promise<Graded> {
  const { grade } = request.choices;
  const style = request.brief.style;
  let document = cut.document;
  const commands: EditCommand[] = [];
  const report: AutoEditReport['grade'] = { choice: grade, clips: 0, hero: null, style: null, failed: null };
  if (grade === 'none') return { document, commands, report };
  const failures: string[] = [];
  const pass = async (
    ids: readonly string[],
    input: Record<string, unknown>,
    from: number,
    share: number,
    label: string,
  ) => {
    const result = await estimateChunks(
      context,
      () => document,
      ids,
      input,
      (done) => progress(from + (share * done) / Math.max(1, ids.length), `${label} ${done} of ${ids.length} clips`),
    );
    document = applyBatch(document, result.commands, '');
    commands.push(...result.commands);
    failures.push(...result.failed);
  };
  const graded = 1 - PICTURES - 0.05;
  const matched = grade === 'match' && style !== null;
  if (!matched)
    await pass(cut.clipIds, { kind: 'auto-adjust' }, PICTURES, grade === 'match' ? graded / 2 : graded, 'Auto on');
  if (grade === 'match') {
    if (style !== null) {
      const found = await context.styles.get(style);
      report.style = { id: found.id, name: found.name };
      await pass(cut.clipIds, { kind: 'match', style }, PICTURES, graded, 'Matched');
    } else {
      const hero = chooseHero(cut.plan);
      if (hero !== null) {
        const heroId = cut.clipIds[hero]!;
        report.hero = { clipId: heroId, recording: cut.plan.clips[hero]!.candidate.name };
        const others = cut.clipIds.filter((id) => id !== heroId);
        await pass(others, { kind: 'match', referenceClipId: heroId }, PICTURES + graded / 2, graded / 2, 'Matched');
      }
    }
  }
  report.clips = new Set(commands.flatMap((command) => ('clipIds' in command && command.clipIds) || [])).size;
  if (failures.length)
    report.failed = `${failures.length} clip${failures.length === 1 ? '' : 's'} kept a neutral or Auto grade: ${failures.slice(0, 3).join('; ')}`;
  return { document, commands, report };
}

/**
 * An auto edit of `project`: the bin's steady ranges inside the kept ranges, their pictures measured, alike takes
 * clustered, the music's slots filled, transitions and fades, then the grade; nothing is saved.
 */
export async function buildAutoEdit(
  context: ServiceContext,
  project: ProjectDocument,
  request: AutoEditRequest,
  placement: AutoEditPlacement,
  progress: Progress = () => {},
  signal?: AbortSignal,
): Promise<AutoEditOutcome> {
  const { brief, choices } = request;
  const limits = steadyLimitsFrom(brief);
  const limitError = steadyLimitsError(limits);
  if (limitError) throw new ServiceError(limitError, 422);
  progress(0, 'Reading recordings and music');
  const { recordings, skipped } = await readRecordings(context, project);
  const music = await readMusic(context, project, brief);
  const minimum = Math.round(AUTO_EDIT.minimumSeconds * FPS);
  const found = findCandidates(recordings, limits, minimum);
  if (!found.candidates.length)
    throw new ServiceError(
      recordings.length
        ? 'No steady range inside the kept ranges is long enough for a clip: keep more footage or allow more movement.'
        : 'No recording of the project is prepared with its camera motion analyzed: prepare and analyze them first.',
      409,
    );
  const pictured = await readPictures(context, found.candidates, progress, signal);
  const candidates = scoreCandidates(pictured, limits.maxJolts);
  checkSignal(signal);
  progress(PICTURES, 'Choosing shots on the music');
  let plan: AutoEditPlan;
  try {
    plan = planAutoEdit({
      candidates,
      music: music.timeline,
      targetFrames: brief.targetSeconds === null ? null : secondsToFrames(brief.targetSeconds),
      choices,
      maxClips: brief.maxClips,
      fps: FPS,
    });
  } catch (error) {
    throw new ServiceError(errorMessage(error), 409);
  }
  let cut;
  try {
    cut = buildCut(
      project,
      plan,
      music.followed,
      placement,
      (mediaId) => context.library.get(mediaId).metadata.frameCount,
    );
  } catch (error) {
    throw new ServiceError(errorMessage(error), 409);
  }
  const report = cutReport({
    plan,
    candidates,
    leftOut: found.leftOut,
    document: cut.document,
    layerId: cut.layerId,
    clipIds: cut.clipIds,
    music: music.description,
    timeline: music.timeline as MusicTimeline | null,
    targetSeconds: brief.targetSeconds,
    choices,
    skipped,
    notes: [...music.notes, ...cut.notes],
  });
  checkSignal(signal);
  const graded = await gradeCut(context, { document: cut.document, clipIds: cut.clipIds, plan }, request, progress);
  return {
    document: graded.document,
    commands: [...cut.commands, ...graded.commands],
    report: { ...report, grade: graded.report },
  };
}

/** A one-line summary of an auto edit, as a job's message. */
export function autoEditSummary(report: AutoEditReport): string {
  const music = report.music ? ` on ${report.music.recording}` : '';
  return `${report.clips.length} clips, ${report.duration.timecode}${music}`;
}
