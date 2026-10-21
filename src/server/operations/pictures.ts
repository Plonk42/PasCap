import type { EditCommand } from '../../shared/commands.js';
import type { recordingSheet, still, timelineSheet } from '../../shared/operations/pictures.js';
import { calculateLayout, sampleTimeline } from '../../shared/timeline.js';
import { formatTimecode } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import { assertSourceRanges } from '../project-sources.js';
import type { OperationRunner, ServiceContext } from './context.js';
import { applyBatch } from './edit.js';

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
