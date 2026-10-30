import type { describeRecording } from '../../shared/operations/describe-recording.js';
import { durationOf } from '../../shared/operations/timecode.js';
import { projectVideoIds } from '../../shared/projects.js';
import { recordingShots, type SteadyShot } from '../../shared/recording-shots.js';
import { SMOOTH_TOLERANCE } from '../../shared/motion-analysis.js';
import { formatTimecode, framesToSeconds, PROJECT_FPS } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner, ServiceContext } from './context.js';

const FPS = PROJECT_FPS.numerator / PROJECT_FPS.denominator;

/** The shots a contact sheet of `cells` shows: all of them, else the best-ranked, in source order. */
function pictured(shots: readonly SteadyShot[], cells: number): SteadyShot[] {
  return shots.filter((shot) => shot.rank <= cells);
}

/** The allowed movement asked for, else the active session's, else the editor's initial one. */
export async function allowedMovementFor(
  sessions: ServiceContext['sessions'],
  projectId: string,
  asked?: number,
): Promise<number> {
  const session = await sessions.current(projectId);
  return asked ?? (session?.endedAt === null ? session.brief.allowedMovement : null) ?? SMOOTH_TOLERANCE.initial;
}

export const runDescribeRecording: OperationRunner<typeof describeRecording> = async (
  { projects, library, sessions, stills, images },
  { projectId, mediaId, allowedMovement, sheet },
) => {
  const project = await projects.load(projectId);
  if (!projectVideoIds(project).has(mediaId))
    throw new ServiceError(`The project has no video recording ${mediaId}; read describe_project.`, 404);
  const asset = library.get(mediaId);
  if (asset.status !== 'ready')
    throw new ServiceError(`${asset.name} is not prepared yet, so it cannot be described or shown.`, 409);
  const tolerance = await allowedMovementFor(sessions, projectId, allowedMovement);
  const analysis = await library.motion(mediaId);
  const kept = project.selects[mediaId];
  const { shots, stillShare } = analysis
    ? recordingShots(analysis, asset.damage, kept, tolerance, FPS)
    : { shots: [], stillShare: null };
  const shown = sheet ? pictured(shots, images.sheetCells) : [];
  const middles = shown.map((shot) => Math.floor((shot.sourceIn + shot.sourceOut) / 2));
  return {
    revision: project.revision,
    recording: {
      id: asset.id,
      name: asset.name,
      duration: durationOf(asset.metadata.frameCount),
      damaged: asset.damage.map((range) => ({ sourceIn: range.start, sourceOut: range.end })),
      stillShare,
      flightData: (analysis?.telemetry.length ?? 0) > 0,
    },
    keptRanges: kept ?? null,
    allowedMovement: tolerance,
    motionAnalyzed: analysis !== null,
    steadyRanges: shots.map((shot) => ({
      ...shot,
      inTimecode: formatTimecode(shot.sourceIn),
      outTimecode: formatTimecode(shot.sourceOut),
      seconds: Math.round(framesToSeconds(shot.sourceOut - shot.sourceIn) * 100) / 100,
      cell: shown.includes(shot) ? shown.indexOf(shot) : null,
    })),
    ...(middles.length ? { image: await stills.recordingSheet(mediaId, middles, images) } : {}),
  };
};
