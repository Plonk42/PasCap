import type { EditCommand } from '../../shared/commands.js';
import type { ProjectDocument } from '../../shared/model.js';
import type { compareRecordings, recordingSheet, still, timelineSheet } from '../../shared/operations/pictures.js';
import { projectVideoIds } from '../../shared/projects.js';
import { recordingShots } from '../../shared/recording-shots.js';
import { forEachSerial } from '../../shared/serial.js';
import { calculateLayout, sampleTimeline } from '../../shared/timeline.js';
import { formatTimecode, framesToSeconds, PROJECT_FPS } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import { assertSourceRanges } from '../project-sources.js';
import type { OperationRunner, ServiceContext } from './context.js';
import { allowedMovementFor } from './describe-recording.js';
import { applyBatch } from './edit.js';

const FPS = PROJECT_FPS.numerator / PROJECT_FPS.denominator;
type CompareOutput = Awaited<ReturnType<OperationRunner<typeof compareRecordings>>>;

/** The saved project, with candidate commands applied in memory and validated like a save. */
async function renderedProject(
  { projects, library, audio }: ServiceContext,
  projectId: string,
  commands?: EditCommand[],
) {
  const saved = await projects.load(projectId);
  if (!commands) return { saved, document: saved };
  const document = applyBatch(saved, commands, 'Nothing was rendered.');
  assertSourceRanges(document, library, audio);
  return { saved, document };
}

function withinBudget(count: number, limit: number, what: string): void {
  if (count > limit) throw new ServiceError(`The service's image budget allows ${limit} ${what}; ask for fewer.`, 422);
}

function legend(document: Parameters<typeof sampleTimeline>[0], frames: readonly number[]) {
  const layout = calculateLayout(document);
  const order = new Map(document.layers.map((layer, index) => [layer.id, index]));
  return frames.map((frame, cell) => ({
    cell,
    frame,
    timecode: formatTimecode(frame),
    clipIds: sampleTimeline(document, frame, layout)
      .sort((left, right) => order.get(left.layerId)! - order.get(right.layerId)!)
      .map((sample) => sample.clipId),
  }));
}

export const runStill: OperationRunner<typeof still> = async (context, { projectId, frame, width, crop, commands }) => {
  const { images, stills } = context;
  const size = width ?? images.stillWidth;
  withinBudget(size, images.stillWidth, 'pixels of still width');
  if (crop) withinBudget(Math.max(crop.width, crop.height), images.stillWidth, 'pixels of crop width and height');
  const { saved, document } = await renderedProject(context, projectId, commands);
  return {
    revision: saved.revision,
    image: await stills.still(document, frame, size, crop ?? null),
    legend: legend(document, [frame]),
  };
};

export const runTimelineSheet: OperationRunner<typeof timelineSheet> = async (
  context,
  { projectId, frames, commands },
) => {
  withinBudget(frames.length, context.images.sheetCells, 'frames per sheet');
  const { saved, document } = await renderedProject(context, projectId, commands);
  return {
    revision: saved.revision,
    image: await context.stills.timelineSheet(document, frames, context.images),
    legend: legend(document, frames),
  };
};

export const runRecordingSheet: OperationRunner<typeof recordingSheet> = async (
  { stills, images },
  { mediaId, frames },
) => {
  withinBudget(frames.length, images.sheetCells, 'frames per sheet');
  return {
    image: await stills.recordingSheet(mediaId, frames, images),
    legend: frames.map((frame, cell) => ({ cell, frame, timecode: formatTimecode(frame) })),
  };
};

/** The range a candidate without one shows: the best steady range, else the first kept range or all of it. */
async function defaultRange(
  { library, sessions }: ServiceContext,
  project: ProjectDocument,
  mediaId: string,
): Promise<{ sourceIn: number; sourceOut: number }> {
  const asset = library.get(mediaId);
  const kept = project.selects[mediaId];
  const analysis = await library.motion(mediaId);
  if (analysis) {
    const tolerance = await allowedMovementFor(sessions, project.id);
    const { shots } = recordingShots(analysis, asset.damage, kept, tolerance, FPS);
    const best = shots.find((shot) => shot.rank === 1);
    if (best) return { sourceIn: best.sourceIn, sourceOut: best.sourceOut };
  }
  return kept?.[0] ?? { sourceIn: 0, sourceOut: asset.metadata.frameCount };
}

export const runCompareRecordings: OperationRunner<typeof compareRecordings> = async (context, input) => {
  const { projects, library, stills, images } = context;
  const perCandidate = input.frames ?? 1;
  withinBudget(input.candidates.length * perCandidate, images.sheetCells, 'cells per sheet');
  const project = await projects.load(input.projectId);
  const videoIds = projectVideoIds(project);
  const candidates: CompareOutput['candidates'] = [];
  await forEachSerial(input.candidates, async ({ mediaId, sourceIn, sourceOut }, index) => {
    if (!videoIds.has(mediaId))
      throw new ServiceError(`The project has no video recording ${mediaId}; read describe_project.`, 404);
    const asset = library.get(mediaId);
    if (asset.status !== 'ready')
      throw new ServiceError(`${asset.name} is not prepared yet, so it cannot be shown.`, 409);
    const range =
      sourceIn === undefined || sourceOut === undefined
        ? await defaultRange(context, project, mediaId)
        : { sourceIn, sourceOut };
    if (range.sourceIn >= range.sourceOut || range.sourceOut > asset.metadata.frameCount)
      throw new ServiceError(
        `Candidate ${index + 1} needs sourceIn before sourceOut, within the ${asset.metadata.frameCount} frames of ${asset.name}.`,
        422,
      );
    const length = range.sourceOut - range.sourceIn;
    candidates.push({
      cells: Array.from({ length: perCandidate }, (_, cell) => index * perCandidate + cell),
      mediaId,
      name: asset.name,
      ...range,
      seconds: Math.round(framesToSeconds(length) * 100) / 100,
      frames: Array.from(
        { length: perCandidate },
        (_, cell) => range.sourceIn + Math.floor(((cell + 0.5) * length) / perCandidate),
      ),
    });
  });
  const cells = candidates.flatMap(({ mediaId, frames }) => frames.map((frame) => ({ mediaId, frame })));
  const image = await stills.sourceSheet(cells, perCandidate > 1 ? perCandidate : null, images);
  return { revision: project.revision, image, candidates };
};
