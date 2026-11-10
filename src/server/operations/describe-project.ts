import { isNeutralClipGrade, type ClipGrade } from '../../shared/grade.js';
import {
  projectParts,
  type describeProject,
  type ProjectDescription,
} from '../../shared/operations/describe-project.js';
import { detailSummary, gradeSummary } from '../../shared/operations/grade-summary.js';
import { durationOf, recordingFps } from '../../shared/operations/timecode.js';
import { calculateLayout, type PlacedClip } from '../../shared/timeline.js';
import type { MusicLane, ProjectDocument, VideoClip, VideoLayer } from '../../shared/model.js';
import { formatTimecode, videoRate } from '../../shared/timing.js';
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

/** "static" or "N keyframes"; undefined when neutral. */
function gradeLabel(grade: Pick<ClipGrade, 'color' | 'keyframes'>): string | undefined {
  if (grade.keyframes.length) return `${grade.keyframes.length} keyframe${grade.keyframes.length === 1 ? '' : 's'}`;
  return isNeutralClipGrade(grade) ? undefined : 'static';
}

/** "2×" or "curve, N keyframes"; undefined at normal speed. */
function speedLabel({ speed }: VideoClip): string | undefined {
  if (speed.mode === 'curve') return `curve, ${speed.keyframes.length} keyframes`;
  return speed.rate === 1 ? undefined : `${speed.rate}×`;
}

/** The value under its key, unless it is the default. */
function unlessDefault<K extends string, V>(key: K, value: V | undefined, fallback?: V): Partial<Record<K, V>> {
  return value === undefined || value === fallback ? {} : ({ [key]: value } as Record<K, V>);
}

const notCut = <T extends { type: string }>(transitions: readonly T[]): T[] =>
  transitions.filter((transition) => transition.type !== 'cut');

type Name = (id: string) => string | null;

function describeClip({ clip, start, end }: PlacedClip, videoName: Name) {
  return {
    id: clip.id,
    recording: { id: clip.mediaId, name: videoName(clip.mediaId) },
    ...span(start, end),
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    ...unlessDefault('speed', speedLabel(clip)),
    ...(clip.reverse && { reverse: true as const }),
    ...unlessDefault('grade', gradeLabel(clip.grade)),
    ...unlessDefault('detail', detailSummary(clip.detail)),
  };
}

function describeVideoTrack(layer: VideoLayer, clips: readonly PlacedClip[], videoName: Name) {
  return {
    id: layer.id,
    name: layer.name,
    ...(!layer.enabled && { enabled: false as const }),
    ...(!layer.ripple && { ripple: false as const }),
    ...unlessDefault('opacity', layer.transform.base.opacity, 1),
    ...unlessDefault('transformKeyframes', layer.transform.keyframes.length, 0),
    ...unlessDefault('openingFade', layer.openingFade, 0),
    ...unlessDefault('closingFade', layer.closingFade, 0),
    clips: clips.filter((placed) => placed.clip.layerId === layer.id).map((placed) => describeClip(placed, videoName)),
    transitions: notCut(layer.transitions),
  };
}

function describeMusicTrack(track: MusicLane, musicName: Name) {
  return {
    id: track.id,
    ...unlessDefault('gainDb', track.gainDb, 0),
    ...(track.ripple && { ripple: true as const }),
    ...unlessDefault('openingFade', track.openingFade, 0),
    ...unlessDefault('closingFade', track.closingFade, 0),
    clips: track.clips.map((clip) => ({
      id: clip.id,
      recording: { id: clip.mediaId, name: musicName(clip.mediaId) },
      ...span(clip.start, clip.start + clip.duration),
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      ...(clip.loop && { loop: true as const }),
    })),
    transitions: notCut(track.transitions),
  };
}

function describeRecording(project: ProjectDocument, id: string, library: ServiceContext['library']) {
  const asset = known(() => library.get(id));
  return {
    id,
    name: asset?.name ?? null,
    frameCount: asset?.metadata.frameCount ?? null,
    ...unlessDefault('fps', recordingFps(videoRate(project, id))),
    ...(asset?.status !== 'ready' && { ready: false as const }),
    ...unlessDefault('kept', project.selects[id]),
    ...(project.selectsDone.includes(id) && { selectionDone: true as const }),
  };
}

export const runDescribeProject: OperationRunner<typeof describeProject> = async (
  context: ServiceContext,
  { projectId, include = projectParts, layerId },
) => {
  const project = await context.projects.load(projectId);
  if (layerId !== undefined && !project.layers.some((layer) => layer.id === layerId))
    throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  return describeDocument(project, context, include, layerId);
};

/** The describe_project summary of a project document, for its parts (and one video track). */
export function describeDocument(
  project: ProjectDocument,
  { library, audio }: Pick<ServiceContext, 'library' | 'audio'>,
  include: readonly (typeof projectParts)[number][] = projectParts,
  layerId?: string,
): ProjectDescription {
  const layout = calculateLayout(project);
  const parts = new Set(include);
  const videoName = (id: string) => known(() => library.get(id).name);
  const musicName = (id: string) => known(() => audio.get(id).name);
  const videoTracks = () =>
    project.layers
      .filter((layer) => layerId === undefined || layer.id === layerId)
      .map((layer) => describeVideoTrack(layer, layout.clips, videoName));
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
    ...(parts.has('musicTracks') && {
      musicTracks: project.music.map((track) => describeMusicTrack(track, musicName)),
    }),
    ...(parts.has('recordings') && {
      recordings: project.media.videoIds.map((id) => describeRecording(project, id, library)),
      musicRecordings: project.media.audioIds.map((id) => ({ id, name: musicName(id) })),
    }),
    ...(parts.has('bookmarks') && { bookmarks: project.bookmarks }),
  };
}
