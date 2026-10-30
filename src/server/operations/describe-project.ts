import { isNeutralClipGrade, type ClipGrade } from '../../shared/grade.js';
import { projectParts, type describeProject } from '../../shared/operations/describe-project.js';
import { gradeSummary } from '../../shared/operations/grade-summary.js';
import { durationOf } from '../../shared/operations/timecode.js';
import { calculateLayout } from '../../shared/timeline.js';
import { formatTimecode } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner, ServiceContext } from './context.js';

/** Unregistered media is described as unknown rather than failing the whole summary. */
function known<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function span(start: number, end: number) {
  const { seconds } = durationOf(end - start);
  return { start, end, startTimecode: formatTimecode(start), endTimecode: formatTimecode(end), seconds };
}

/** "none", "static" or "N keyframes". */
function gradeLabel(grade: Pick<ClipGrade, 'color' | 'keyframes'>): string {
  if (grade.keyframes.length) return `${grade.keyframes.length} keyframe${grade.keyframes.length === 1 ? '' : 's'}`;
  return isNeutralClipGrade(grade) ? 'none' : 'static';
}

export const runDescribeProject: OperationRunner<typeof describeProject> = async (
  { projects, library, audio }: ServiceContext,
  { projectId, include = projectParts, layerId },
) => {
  const project = await projects.load(projectId);
  if (layerId !== undefined && !project.layers.some((layer) => layer.id === layerId))
    throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  const layout = calculateLayout(project);
  const parts = new Set(include);
  const videoName = (id: string) => known(() => library.get(id).name);
  const musicName = (id: string) => known(() => audio.get(id).name);
  const videoTracks = () =>
    project.layers
      .filter((layer) => layerId === undefined || layer.id === layerId)
      .map((layer) => ({
        id: layer.id,
        name: layer.name,
        enabled: layer.enabled,
        ripple: layer.ripple,
        opacity: layer.transform.base.opacity,
        transformKeyframes: layer.transform.keyframes.length,
        openingFade: layer.openingFade,
        closingFade: layer.closingFade,
        clips: layout.clips
          .filter((placed) => placed.clip.layerId === layer.id)
          .map(({ clip, start, end }) => ({
            id: clip.id,
            recording: { id: clip.mediaId, name: videoName(clip.mediaId) },
            ...span(start, end),
            sourceIn: clip.sourceIn,
            sourceOut: clip.sourceOut,
            speed:
              clip.speed.mode === 'constant'
                ? `${clip.speed.rate}×`
                : `curve, ${clip.speed.keyframes.length} keyframes`,
            reverse: clip.reverse,
            grade: gradeLabel(clip.grade),
          })),
        transitions: layer.transitions,
      }));
  const musicTracks = () =>
    project.music.map((track) => ({
      id: track.id,
      gainDb: track.gainDb,
      ripple: track.ripple,
      openingFade: track.openingFade,
      closingFade: track.closingFade,
      clips: track.clips.map((clip) => ({
        id: clip.id,
        recording: { id: clip.mediaId, name: musicName(clip.mediaId) },
        ...span(clip.start, clip.start + clip.duration),
        sourceIn: clip.sourceIn,
        sourceOut: clip.sourceOut,
        loop: clip.loop,
      })),
      transitions: track.transitions,
    }));
  const recordings = () =>
    project.media.videoIds.map((id) => {
      const asset = known(() => library.get(id));
      return {
        id,
        name: asset?.name ?? null,
        frameCount: asset?.metadata.frameCount ?? null,
        ready: asset?.status === 'ready',
        kept: project.selects[id] ?? null,
      };
    });
  return {
    id: project.id,
    title: project.title,
    revision: project.revision,
    duration: durationOf(layout.duration),
    ...(parts.has('videoTracks') && { videoTracks: videoTracks() }),
    ...(parts.has('adjustments') && {
      adjustments: project.adjustments.map((item) => ({
        id: item.id,
        ...span(item.start, item.start + item.duration),
        grade: gradeSummary(item),
      })),
    }),
    ...(parts.has('musicTracks') && { musicTracks: musicTracks() }),
    ...(parts.has('recordings') && {
      recordings: recordings(),
      musicRecordings: project.media.audioIds.map((id) => ({ id, name: musicName(id) })),
    }),
    ...(parts.has('bookmarks') && { bookmarks: project.bookmarks }),
  };
};
