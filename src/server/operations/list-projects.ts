import type { listProjects } from '../../shared/operations/list-projects.js';
import { durationOf } from '../../shared/operations/timecode.js';
import type { OperationRunner, ServiceContext } from './context.js';

export const runListProjects: OperationRunner<typeof listProjects> = async ({ projects }: ServiceContext) => ({
  projects: (await projects.list()).map((project) => ({
    id: project.id,
    title: project.title,
    revision: project.revision,
    clipCount: project.clipCount,
    duration: durationOf(project.duration),
    updatedAt: project.updatedAt,
    error: project.compatible ? null : project.error,
  })),
});
