import type { handOffReadiness } from '../../shared/operations/hand-off.js';
import type { OperationOutput } from '../../shared/operations/index.js';
import { projectAudioIds, projectVideoIds } from '../../shared/projects.js';
import { forEachSerial } from '../../shared/serial.js';
import type { OperationRunner, ServiceContext } from './context.js';

type Readiness = OperationOutput<'hand_off_readiness'>;
type Preparation = Readiness['recordings'][number]['preparation'];
type Analysis = Readiness['recordings'][number]['cameraMotion'];

function preparation(status: string): Preparation {
  if (status === 'ready') return 'ready';
  return status === 'queued' || status === 'preparing' ? 'preparing' : 'unprepared';
}

async function analysis(job: unknown, read: () => Promise<unknown>): Promise<Analysis> {
  if (job !== null) return 'analyzing';
  try {
    return (await read()) === null ? 'missing' : 'analyzed';
  } catch {
    // An unreadable cache is analyzed again like a missing one.
    return 'missing';
  }
}

export const runHandOffReadiness: OperationRunner<typeof handOffReadiness> = async (
  { projects, library, audio, jobs, assistant }: ServiceContext,
  { projectId },
) => {
  const project = await projects.load(projectId);
  const recordings: Readiness['recordings'] = [];
  const music: Readiness['music'] = [];
  await forEachSerial(projectVideoIds(project), async (id) => {
    const asset = library.get(id);
    recordings.push({
      id,
      name: asset.name,
      preparation: preparation(asset.status),
      cameraMotion: await analysis(library.motionJob(id), () => library.motion(id)),
    });
  });
  await forEachSerial(projectAudioIds(project), async (id) => {
    const asset = audio.get(id);
    music.push({
      id,
      name: asset.name,
      preparation: preparation(asset.status),
      beats: await analysis(audio.analysisJob(id), () => audio.analysis(id)),
    });
  });
  return {
    recordings,
    music,
    exportRunning: jobs.list().some((job) => job.kind === 'export' && ['queued', 'running'].includes(job.state)),
    connection: {
      url: assistant.url,
      tokenFile: assistant.tokenFile,
      lastCall: assistant.lastClient()?.at ?? null,
      client: assistant.lastClient()?.name ?? null,
    },
  };
};
