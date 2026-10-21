import type { z } from 'zod';
import { describeProject } from './describe-project.js';
import { describeTrack } from './describe-track.js';
import { edit } from './edit.js';
import { recordingSheet, still, timelineSheet } from './pictures.js';

/** Every operation of the service; one that is not listed here does not exist. */
export const operations = [describeProject, describeTrack, edit, still, timelineSheet, recordingSheet] as const;

export type Operation = (typeof operations)[number];
export type OperationName = Operation['name'];
export type OperationNamed<N extends OperationName> = Extract<Operation, { name: N }>;
export type OperationInput<N extends OperationName> = z.input<OperationNamed<N>['input']>;
export type OperationOutput<N extends OperationName> = z.output<OperationNamed<N>['output']>;

export function operationNamed<N extends OperationName>(name: N): OperationNamed<N> {
  return operations.find((operation) => operation.name === name) as OperationNamed<N>;
}
