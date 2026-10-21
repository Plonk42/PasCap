import type { describeProject } from '../../shared/operations/describe-project.js';
import { durationOf } from '../../shared/operations/timecode.js';
import { calculateLayout } from '../../shared/timeline.js';
import { formatTimecode } from '../../shared/timing.js';
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

export const runDescribeProject: OperationRunner<typeof describeProject> = async (
  { projects, library, audio }: ServiceContext,
  { projectId },
) => {
  const project = await projects.load(projectId);
  const layout = calculateLayout(project);
  const videoName = (id: string) => known(() => library.get(id).name);
  const musicName = (id: string) => known(() => audio.get(id).name);
  return {
    id: project.id,
    title: project.title,
    revision: project.revision,
    duration: durationOf(layout.duration),
    videoTracks: project.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      enabled: layer.enabled,
      ripple: layer.ripple,
      opacity: layer.opacity,
      colourKeyframes: layer.keyframes.length,
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
            clip.speed.mode === 'constant' ? `${clip.speed.rate}×` : `curve, ${clip.speed.keyframes.length} keyframes`,
          reverse: clip.reverse,
        })),
      transitions: layer.transitions,
    })),
    musicTracks: project.music.map((track) => ({
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
    })),
    recordings: project.media.videoIds.map((id) => {
      const asset = known(() => library.get(id));
      return {
        id,
        name: asset?.name ?? null,
        frameCount: asset?.metadata.frameCount ?? null,
        ready: asset?.status === 'ready',
        kept: project.selects[id] ?? null,
      };
    }),
    musicRecordings: project.media.audioIds.map((id) => ({ id, name: musicName(id) })),
    bookmarks: project.bookmarks,
  };
};
