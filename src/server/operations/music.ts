import {
  boundaries,
  mergeBeats,
  musicSampleRanges,
  nearestBeat,
  snapCutsToBeats,
  type SnapTargetKind,
} from '../../shared/beat-alignment.js';
import type { MusicTrack, ProjectDocument } from '../../shared/model.js';
import {
  musicBeatFrames,
  musicHitFrames,
  type MusicAnalysis,
  type PlacedBeat,
  type PlacedHit,
} from '../../shared/music-analysis.js';
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

/** The beats, strong hits and every hit of the project's analyzed music clips at project frames. */
async function projectBeats(
  { audio }: ServiceContext,
  project: ProjectDocument,
  musicClipId: string | undefined,
): Promise<{ beats: PlacedBeat[]; hits: number[]; allHits: number[] }> {
  const lists: PlacedBeat[][] = [];
  const hits = new Set<number>();
  const allHits = new Set<number>();
  await forEachSerial(musicClipsOf(project, musicClipId), async ({ track }) => {
    const analysis = await readAnalysis(audio, track.mediaId);
    if (!analysis) return;
    lists.push(musicBeatFrames(track, analysis.beats));
    for (const hit of musicHitFrames(track, analysis.hits)) {
      allHits.add(hit.frame);
      if (hit.strong) hits.add(hit.frame);
    }
  });
  const sorted = (frames: Set<number>) => [...frames].sort((a, b) => a - b);
  return { beats: mergeBeats(lists), hits: sorted(hits), allHits: sorted(allHits) };
}

function rounded(value: number, digits: number): number {
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function analysisState(analysis: MusicAnalysis | null, job: unknown): 'analyzed' | 'analyzing' | 'missing' {
  if (analysis) return 'analyzed';
  return job ? 'analyzing' : 'missing';
}

function describeMusicClip(
  { trackId, track }: PlacedMusicClip,
  asset: { id: string; name: string },
  analysis: MusicAnalysis | null,
  job: unknown,
  window: { from: number; to: number },
  summary: boolean,
) {
  const inWindow = (frame: number) => frame >= window.from && frame < window.to;
  const beats = analysis ? musicBeatFrames(track, analysis.beats).filter((beat) => inWindow(beat.frame)) : [];
  const hits = analysis ? musicHitFrames(track, analysis.hits).filter((hit) => inWindow(hit.frame)) : [];
  const listedBeats = summary ? [] : beats;
  const listedHits = summary ? hits.filter((hit) => hit.strong) : hits;
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
    beats: listedBeats.slice(0, MAX_LISTED_BEATS).map((beat) => ({
      frame: beat.frame,
      timecode: formatTimecode(beat.frame),
      downbeat: beat.downbeat,
      strength: rounded(beat.strength, 2),
    })),
    beatCount: beats.length,
    beatsTruncated: listedBeats.length > MAX_LISTED_BEATS,
    hits: listedHits.slice(0, MAX_LISTED_BEATS).map((hit: PlacedHit) => ({
      frame: hit.frame,
      timecode: formatTimecode(hit.frame),
      band: hit.band,
      strong: hit.strong,
      strength: rounded(hit.strength, 2),
    })),
    hitCount: hits.length,
    hitsTruncated: listedHits.length > MAX_LISTED_BEATS,
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
  { projectId, musicClipId, fromFrame, toFrame, detail },
) => {
  const project = await projects.load(projectId);
  const window = { from: fromFrame ?? 0, to: toFrame ?? Number.MAX_SAFE_INTEGER };
  const clips: ReturnType<typeof describeMusicClip>[] = [];
  await forEachSerial(musicClipsOf(project, musicClipId), async (placed) => {
    const { mediaId } = placed.track;
    const analysis = await readAnalysis(audio, mediaId);
    clips.push(
      describeMusicClip(placed, audio.get(mediaId), analysis, audio.analysisJob(mediaId), window, detail === 'summary'),
    );
  });
  return { revision: project.revision, clips };
};

function requireBeats({ beats, hits }: { beats: readonly PlacedBeat[]; hits: readonly number[] }): void {
  if (!beats.length && !hits.length)
    throw new ServiceError(
      'No analyzed music beats or hits fall on the timeline: place music and have it analyzed in Audio → Music first.',
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
  const music = await projectBeats(context, project, musicClipId);
  requireBeats(music);
  const { beats } = music;
  const downbeats = beats.filter((beat) => beat.downbeat);
  const hits = music.hits.map((frame) => ({ frame }));
  const near = (offset: { beat: number; offset: number } | null) =>
    offset && { frame: offset.beat, offset: offset.offset };
  const report = boundaries(project, layerId).map((boundary) => ({
    ...boundary,
    timecode: formatTimecode(boundary.frame),
    beat: near(nearestBeat(beats, boundary.frame)),
    downbeat: near(nearestBeat(downbeats, boundary.frame)),
    hit: near(nearestBeat(hits, boundary.frame)),
  }));
  const within = (offset: { offset: number } | null): boolean => offset !== null && Math.abs(offset.offset) <= 1;
  const offsets = report.flatMap((item) => (item.beat ? [Math.abs(item.beat.offset)] : []));
  return {
    revision: project.revision,
    beats: beats.length,
    hits: hits.length,
    boundaries: report,
    summary: {
      boundaries: report.length,
      onBeat: report.filter((item) => within(item.beat)).length,
      onDownbeat: report.filter((item) => within(item.downbeat)).length,
      onHit: report.filter((item) => within(item.hit)).length,
      meanOffset: offsets.length ? rounded(offsets.reduce((sum, value) => sum + value, 0) / offsets.length, 1) : null,
    },
  };
};

function snapTargets(
  { beats, hits }: { beats: readonly PlacedBeat[]; hits: readonly number[] },
  prefer: 'beat' | 'downbeat' | 'hit' | 'beat-or-hit',
): number[] {
  if (prefer === 'hit') return [...hits];
  const frames = beats.filter((beat) => prefer !== 'downbeat' || beat.downbeat).map((beat) => beat.frame);
  if (prefer === 'beat-or-hit') frames.push(...hits);
  return [...new Set(frames)].sort((a, b) => a - b);
}

/** What a snap target is; a frame that is both a beat and a hit counts as the beat unless only hits are wanted. */
function targetKinds(
  { beats, hits }: { beats: readonly PlacedBeat[]; hits: readonly number[] },
  prefer: 'beat' | 'downbeat' | 'hit' | 'beat-or-hit',
): (frame: number) => SnapTargetKind {
  const beatAt = new Map(beats.map((beat) => [beat.frame, beat]));
  const hitFrames = new Set(hits);
  return (frame) => {
    const beat = beatAt.get(frame);
    if (prefer === 'hit' || (hitFrames.has(frame) && !beat)) return 'hit';
    return beat?.downbeat ? 'downbeat' : 'beat';
  };
}

export const runSnapCutsToBeats: OperationRunner<typeof snapOperation> = async (context, input) => {
  const { projectId, layerId, prefer, minimumSeconds, musicClipId, apply, expectedRevision } = input;
  if (apply && expectedRevision === undefined)
    throw new ServiceError('Applying the snapped cuts needs expectedRevision, from describe_project.', 422);
  const project = await context.projects.load(projectId);
  const music = await projectBeats(context, project, musicClipId);
  const targets = snapTargets(music, prefer);
  if (!targets.length)
    throw new ServiceError(
      `No analyzed music ${prefer === 'hit' ? 'strong hits' : 'beats'} fall on the timeline: place music and have it analyzed in Audio → Music first.`,
      409,
    );
  const fps = PROJECT_FPS.numerator / PROJECT_FPS.denominator;
  let result;
  try {
    result = snapCutsToBeats(
      project,
      layerId,
      targets,
      Math.round(minimumSeconds * fps),
      {
        frameCount: (mediaId) => context.library.get(mediaId).metadata.frameCount,
        kept: (mediaId) => project.selects[mediaId],
      },
      {
        kindOf: targetKinds(music, prefer),
        ...(input.maxShift !== undefined && { maxShift: input.maxShift }),
        keep: new Set((input.keep ?? []).map(({ leftId, rightId }) => `${leftId}>${rightId}`)),
        ...(input.keepOnHit && { keepOnHits: music.allHits }),
      },
    );
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message : 'Cannot snap the cuts of this track.', 422);
  }
  const applied =
    apply && result.commands.length
      ? await runEdit(context, { projectId, expectedRevision: expectedRevision!, commands: result.commands })
      : null;
  return { revision: project.revision, boundaries: result.boundaries, commands: result.commands, applied };
};
