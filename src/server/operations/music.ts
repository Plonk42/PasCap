import {
  boundaries,
  mergeBeats,
  musicSampleFrames,
  musicSampleRanges,
  nearestBeat,
  snapCutsToBeats,
} from '../../shared/beat-alignment.js';
import type { MusicTrack, ProjectDocument } from '../../shared/model.js';
import { musicBeatFrames, type MusicAnalysis, type PlacedBeat } from '../../shared/music-analysis.js';
import { musicTracks } from '../../shared/music-lanes.js';
import {
  MAX_LISTED_BEATS,
  type checkAlignment,
  type musicAnalysis,
  type snapCutsToBeats as snapOperation,
} from '../../shared/operations/music.js';
import { formatTimecode, PROJECT_FPS } from '../../shared/timing.js';
import { forEachSerial } from '../../shared/serial.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner, ServiceContext } from './context.js';
import { runEdit } from './edit.js';

interface PlacedMusicClip {
  trackId: string;
  track: MusicTrack;
}

function musicClipsOf(project: ProjectDocument, musicClipId: string | undefined): PlacedMusicClip[] {
  const clips = project.music.flatMap((lane) => musicTracks([lane]).map((track) => ({ trackId: lane.id, track })));
  if (musicClipId === undefined) return clips;
  const chosen = clips.filter((clip) => clip.track.id === musicClipId);
  if (!chosen.length)
    throw new ServiceError(`The project has no music clip ${musicClipId}; read describe_project.`, 404);
  return chosen;
}

async function readAnalysis(audio: ServiceContext['audio'], mediaId: string): Promise<MusicAnalysis | null> {
  try {
    return await audio.analysis(mediaId);
  } catch {
    return null;
  }
}

/** The beats of the project's analysed music clips at project frames. */
async function projectBeats(
  { audio }: ServiceContext,
  project: ProjectDocument,
  musicClipId: string | undefined,
): Promise<PlacedBeat[]> {
  const lists: PlacedBeat[][] = [];
  await forEachSerial(musicClipsOf(project, musicClipId), async ({ track }) => {
    const analysis = await readAnalysis(audio, track.mediaId);
    if (analysis) lists.push(musicBeatFrames(track, analysis.beats));
  });
  return mergeBeats(lists);
}

function rounded(value: number, digits: number): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function analysisState(analysis: MusicAnalysis | null, job: unknown): 'analysed' | 'analysing' | 'missing' {
  if (analysis) return 'analysed';
  return job ? 'analysing' : 'missing';
}

function describeMusicClip(
  { trackId, track }: PlacedMusicClip,
  asset: { id: string; name: string },
  analysis: MusicAnalysis | null,
  job: unknown,
  window: { from: number; to: number },
) {
  const inWindow = (frame: number) => frame >= window.from && frame < window.to;
  const beats = analysis ? musicBeatFrames(track, analysis.beats).filter((beat) => inWindow(beat.frame)) : [];
  return {
    musicClipId: track.id,
    trackId,
    recording: { id: asset.id, name: asset.name },
    start: track.start,
    end: track.start + track.duration,
    analysis: analysisState(analysis, job),
    tempo: analysis?.tempo
      ? { bpm: rounded(analysis.tempo.bpm, 1), confidence: rounded(analysis.tempo.confidence, 2) }
      : null,
    meter: analysis?.meter
      ? { beatsPerBar: analysis.meter.beatsPerBar, confidence: rounded(analysis.meter.confidence, 2) }
      : null,
    beats: beats.slice(0, MAX_LISTED_BEATS).map((beat) => ({
      frame: beat.frame,
      timecode: formatTimecode(beat.frame),
      downbeat: beat.downbeat,
      strength: rounded(beat.strength, 2),
    })),
    beatsTruncated: beats.length > MAX_LISTED_BEATS,
    accents: (analysis?.accents ?? [])
      .flatMap((accent) =>
        musicSampleFrames(track, accent.sample).map((frame) => ({ frame, strength: rounded(accent.strength, 2) })),
      )
      .filter((accent) => inWindow(accent.frame))
      .sort((left, right) => left.frame - right.frame)
      .slice(0, MAX_LISTED_BEATS),
    key: analysis?.key ?? null,
    sections: (analysis?.sections ?? [])
      .flatMap((section) =>
        musicSampleRanges(track, section.fromSample, section.toSample).map((range) => ({
          ...range,
          kind: section.kind,
          loudnessDb: rounded(section.loudnessDb, 1),
          tone: sectionTone(analysis!, section),
        })),
      )
      .filter((section) => section.end > window.from && section.start < window.to)
      .sort((left, right) => left.start - right.start),
    swells: (analysis?.swells ?? [])
      .flatMap(({ fromSample, toSample, kind, changeDb, sudden }) =>
        musicSampleRanges(track, fromSample, toSample).map((range) => ({ ...range, kind, changeDb, sudden })),
      )
      .filter((swell) => swell.end > window.from && swell.start < window.to)
      .sort((left, right) => left.start - right.start),
    silences: (analysis?.silences ?? [])
      .flatMap(({ fromSample, toSample }) => musicSampleRanges(track, fromSample, toSample))
      .filter((silence) => silence.end > window.from && silence.start < window.to)
      .sort((left, right) => left.start - right.start),
  };
}

/** Energy-mean low, mid and high levels over a section's seconds. */
function sectionTone(
  analysis: MusicAnalysis,
  section: { fromSample: number; toSample: number },
): { lowDb: number; midDb: number; highDb: number } {
  const seconds = analysis.tone.slice(
    Math.floor(section.fromSample / analysis.sampleRate),
    Math.max(
      Math.floor(section.fromSample / analysis.sampleRate) + 1,
      Math.ceil(section.toSample / analysis.sampleRate),
    ),
  );
  const level = (band: number): number => {
    if (!seconds.length) return -120;
    const power = seconds.reduce((sum, second) => sum + 10 ** (second[band]! / 10), 0) / seconds.length;
    return rounded(Math.max(-120, 10 * Math.log10(power)), 1);
  };
  return { lowDb: level(0), midDb: level(1), highDb: level(2) };
}

export const runMusicAnalysis: OperationRunner<typeof musicAnalysis> = async (
  { projects, audio },
  { projectId, musicClipId, fromFrame, toFrame },
) => {
  const project = await projects.load(projectId);
  const window = { from: fromFrame ?? 0, to: toFrame ?? Number.MAX_SAFE_INTEGER };
  const clips: ReturnType<typeof describeMusicClip>[] = [];
  await forEachSerial(musicClipsOf(project, musicClipId), async (placed) => {
    const { mediaId } = placed.track;
    const analysis = await readAnalysis(audio, mediaId);
    clips.push(describeMusicClip(placed, audio.get(mediaId), analysis, audio.analysisJob(mediaId), window));
  });
  return { clips };
};

function requireBeats(beats: readonly PlacedBeat[]): void {
  if (!beats.length)
    throw new ServiceError(
      'No analysed music beats fall on the timeline: place music and have it analysed in Audio → Music first.',
      409,
    );
}

export const runCheckAlignment: OperationRunner<typeof checkAlignment> = async (
  context,
  { projectId, layerId, musicClipId },
) => {
  const project = await context.projects.load(projectId);
  if (layerId !== undefined && !project.layers.some((layer) => layer.id === layerId))
    throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  const beats = await projectBeats(context, project, musicClipId);
  requireBeats(beats);
  const downbeats = beats.filter((beat) => beat.downbeat);
  const report = boundaries(project, layerId).map((boundary) => {
    const beat = nearestBeat(beats, boundary.frame);
    const downbeat = nearestBeat(downbeats, boundary.frame);
    return {
      ...boundary,
      timecode: formatTimecode(boundary.frame),
      beat: beat && { frame: beat.beat, offset: beat.offset },
      downbeat: downbeat && { frame: downbeat.beat, offset: downbeat.offset },
    };
  });
  const offsets = report.flatMap((item) => (item.beat ? [Math.abs(item.beat.offset)] : []));
  return {
    beats: beats.length,
    boundaries: report,
    summary: {
      boundaries: report.length,
      onBeat: report.filter((item) => item.beat && Math.abs(item.beat.offset) <= 1).length,
      onDownbeat: report.filter((item) => item.downbeat && Math.abs(item.downbeat.offset) <= 1).length,
      meanOffset: offsets.length ? rounded(offsets.reduce((sum, value) => sum + value, 0) / offsets.length, 1) : null,
    },
  };
};

export const runSnapCutsToBeats: OperationRunner<typeof snapOperation> = async (context, input) => {
  const { projectId, layerId, prefer, minimumSeconds, musicClipId, apply, expectedRevision } = input;
  if (apply && expectedRevision === undefined)
    throw new ServiceError('Applying the snapped cuts needs expectedRevision, from describe_project.', 422);
  const project = await context.projects.load(projectId);
  const beats = await projectBeats(context, project, musicClipId);
  requireBeats(beats);
  const fps = PROJECT_FPS.numerator / PROJECT_FPS.denominator;
  let result;
  try {
    result = snapCutsToBeats(project, layerId, beats, prefer === 'downbeat', Math.round(minimumSeconds * fps), {
      frameCount: (mediaId) => context.library.get(mediaId).metadata.frameCount,
      kept: (mediaId) => project.selects[mediaId],
    });
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : 'Cannot snap the cuts of this track.', 422);
  }
  const applied =
    apply && result.commands.length
      ? await runEdit(context, { projectId, expectedRevision: expectedRevision!, commands: result.commands })
      : null;
  return { boundaries: result.boundaries, commands: result.commands, applied };
};
