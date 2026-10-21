import type { FastifyInstance } from 'fastify';
import { operations, type Operation } from '../../shared/operations/index.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner, OperationRunners, ServiceContext, ServiceResources } from './context.js';
import { runDescribeProject } from './describe-project.js';
import { runDescribeRecording } from './describe-recording.js';
import { runDescribeTrack } from './describe-track.js';
import { runEdit } from './edit.js';
import { runEstimate } from './estimate.js';
import { runHandOffReadiness } from './hand-off.js';
import { runListProjects } from './list-projects.js';
import { runCheckAlignment, runMusicAnalysis, runSnapCutsToBeats } from './music.js';
import { runRecordingSheet, runStill, runTimelineSheet } from './pictures.js';
import {
  runCheckpoint,
  runCheckpointCopy,
  runCheckpointRestore,
  runPreviewEdits,
  runSessionEnd,
  runSessionStart,
  runSessionStatus,
} from './sessions.js';

export const runners: OperationRunners = {
  list_projects: runListProjects,
  describe_project: runDescribeProject,
  describe_track: runDescribeTrack,
  describe_recording: runDescribeRecording,
  music_analysis: runMusicAnalysis,
  check_alignment: runCheckAlignment,
  snap_cuts_to_beats: runSnapCutsToBeats,
  session_start: runSessionStart,
  session_status: runSessionStatus,
  session_end: runSessionEnd,
  edit: runEdit,
  preview_edits: runPreviewEdits,
  checkpoint: runCheckpoint,
  checkpoint_restore: runCheckpointRestore,
  checkpoint_copy: runCheckpointCopy,
  hand_off_readiness: runHandOffReadiness,
  still: runStill,
  timeline_sheet: runTimelineSheet,
  recording_sheet: runRecordingSheet,
  estimate: runEstimate,
};

export async function runOperation(operation: Operation, context: ServiceContext, input: unknown): Promise<unknown> {
  const run = runners[operation.name] as OperationRunner<Operation>;
  const output = operation.output.safeParse(await run(context, operation.input.parse(input)));
  if (!output.success)
    throw new ServiceError(`The ${operation.name} operation returned an invalid result: ${output.error.message}`, 500);
  return output.data;
}

/** `POST /api/ops/<name>` for every operation, behind the service's loopback and client guards. */
export function registerOperations(app: FastifyInstance, resources: ServiceResources): void {
  const context: ServiceContext = { ...resources, caller: 'editor' };
  for (const operation of operations) {
    app.post(`/api/ops/${operation.name}`, async (request) => runOperation(operation, context, request.body));
  }
}
