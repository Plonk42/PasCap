import { analyseAutoAdjust, autoAdjustFrames, scaleCorrection } from '../../shared/auto-adjust.js';
import {
  animatedSettings,
  autoAdjustCommand,
  captureCommands,
  keyframeLimitReason,
  trackSamples,
  whiteBalanceCommands,
  windowSourceFrames,
} from '../../shared/auto-colour.js';
import type { EditCommand } from '../../shared/commands.js';
import { detailFrames, measureDetail, suggestDetail } from '../../shared/detail-estimate.js';
import { hasLayerKeys, type Interpolation, type KeyframeSetting } from '../../shared/keyframes.js';
import type { ProjectDocument, VideoLayer } from '../../shared/model.js';
import type { estimate } from '../../shared/operations/estimate.js';
import { projectVideoIds } from '../../shared/projects.js';
import { forEachSerial } from '../../shared/serial.js';
import { calculateLayout, type PlacedClip, type PlacedTransition } from '../../shared/timeline.js';
import {
  frameIlluminant,
  poolWhiteBalance,
  whiteBalanceWindow,
  type AnalysisFrame,
  type WhiteBalance,
} from '../../shared/white-balance.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner, ServiceContext } from './context.js';

type Input = Parameters<OperationRunner<typeof estimate>>[1];

/** Source frames read from one recording's proxy, in sample order; a frame shown twice counts twice. */
interface Read {
  mediaId: string;
  sourceFrames: number[];
}

/** What an estimate analyses, and the track (or clip) its commands edit. */
interface Target {
  description: string;
  reads: Read[];
  layer: VideoLayer | null;
  clip: PlacedClip | null;
}

const invalid = (message: string): ServiceError => new ServiceError(message, 422);

function clipTarget(project: ProjectDocument, input: Input): Target {
  const clip = calculateLayout(project).clips.find((item) => item.clip.id === input.clipId);
  if (!clip) throw new ServiceError(`The project has no clip ${input.clipId}; read describe_project.`, 404);
  const layer = project.layers.find((item) => item.id === clip.clip.layerId)!;
  const { mediaId, sourceIn, sourceOut } = clip.clip;
  if (input.frame === undefined) {
    const sourceFrames =
      input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
    return { description: `the whole clip ${clip.clip.id}`, reads: [{ mediaId, sourceFrames }], layer, clip };
  }
  const frame = input.frame;
  if (frame < clip.start || frame >= clip.end)
    throw invalid(`Frame ${frame} is outside clip ${clip.clip.id}, which plays frames ${clip.start}–${clip.end - 1}.`);
  // Auto white balance weighs each project frame of the window, Auto adjust each source frame once.
  const sourceFrames =
    input.kind === 'white-balance'
      ? whiteBalanceWindow(clip, frame).map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start))
      : windowSourceFrames(clip, frame);
  return {
    description: `1 s around frame ${frame} in clip ${clip.clip.id}`,
    reads: [{ mediaId, sourceFrames }],
    layer,
    clip,
  };
}

function trackTarget(project: ProjectDocument, input: Input): Target {
  const layer = project.layers.find((item) => item.id === input.layerId);
  if (!layer) throw new ServiceError(`The project has no video track ${input.layerId}; read describe_project.`, 404);
  if (input.kind === 'detail') throw invalid('Detail belongs to each clip: estimate it with clipId.');
  const clips = calculateLayout(project).clips.filter((item) => item.clip.layerId === layer.id);
  if (!clips.length) throw invalid(`${layer.name} has no clips to analyse.`);
  const reads = new Map<string, Read>();
  for (const { clip, sourceFrame } of trackSamples(clips)) {
    const read = reads.get(clip.clip.mediaId) ?? { mediaId: clip.clip.mediaId, sourceFrames: [] };
    if (!read.sourceFrames.includes(sourceFrame)) read.sourceFrames.push(sourceFrame);
    reads.set(read.mediaId, read);
  }
  const clipsWord = clips.length === 1 ? 'clip' : `${clips.length} clips`;
  return { description: `the ${clipsWord} of ${layer.name}`, reads: [...reads.values()], layer, clip: null };
}

function rangeTarget(project: ProjectDocument, input: Input, context: ServiceContext): Target {
  const mediaId = input.mediaId!;
  if (!projectVideoIds(project).has(mediaId))
    throw new ServiceError(`The project has no video recording ${mediaId}; read describe_project.`, 404);
  const { sourceIn, sourceOut } = input;
  if (sourceIn === undefined || sourceOut === undefined)
    throw invalid('A recording range needs sourceIn and sourceOut.');
  const asset = context.library.get(mediaId);
  if (sourceOut <= sourceIn || sourceOut > asset.metadata.frameCount)
    throw invalid(`The range must hold at least one frame within ${asset.name}'s ${asset.metadata.frameCount} frames.`);
  const sourceFrames =
    input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
  return {
    description: `${asset.name} from ${sourceIn} to ${sourceOut}`,
    reads: [{ mediaId, sourceFrames }],
    layer: null,
    clip: null,
  };
}

function checkChoice(input: Input): void {
  const chosen = [input.clipId, input.clipIds, input.layerId, input.mediaId].filter(
    (value) => value !== undefined,
  ).length;
  if (chosen !== 1)
    throw invalid('Give exactly one of clipId, clipIds, layerId or mediaId (with sourceIn and sourceOut).');
  if (input.frame !== undefined && input.clipId === undefined) throw invalid('frame needs the clipId it lies in.');
}

function targetOf(project: ProjectDocument, input: Input, context: ServiceContext): Target {
  if (input.applyAs === 'keyframe' && (input.kind === 'detail' || input.frame === undefined))
    throw invalid('A keyframe takes the light at one frame: give clipId and frame, for a Colour kind.');
  if (input.clipId !== undefined) return clipTarget(project, input);
  if (input.layerId !== undefined) return trackTarget(project, input);
  return rangeTarget(project, input, context);
}

/** The clips analysed each on its own, in timeline order, or null for one analysis. */
function separateClips(project: ProjectDocument, input: Input): PlacedClip[] | null {
  const shots = input.applyAs === 'shots';
  if (shots && input.kind === 'detail') throw invalid('applyAs shots keys Colour: use it with a Colour kind.');
  if (shots && (input.frame !== undefined || input.mediaId !== undefined))
    throw invalid('applyAs shots analyses whole clips: give clipId, clipIds or layerId, without frame.');
  const each = input.clipIds !== undefined || shots || (input.layerId !== undefined && input.kind === 'detail');
  if (!each) return null;
  if (input.kind !== 'detail' && !shots)
    throw invalid(
      'A track has one Colour: several clips get a grade each only as keyframes (applyAs shots); layerId alone fits one grade to the whole track.',
    );
  const layout = calculateLayout(project).clips;
  if (input.layerId !== undefined) {
    if (!project.layers.some((layer) => layer.id === input.layerId))
      throw new ServiceError(`The project has no video track ${input.layerId}; read describe_project.`, 404);
    const clips = layout.filter((item) => item.clip.layerId === input.layerId);
    if (!clips.length) throw invalid('This track has no clips to analyse.');
    return clips;
  }
  const ids = input.clipIds ?? [input.clipId!];
  if (new Set(ids).size !== ids.length) throw invalid('List each clip once.');
  const missing = ids.find((id) => !layout.some((item) => item.clip.id === id));
  if (missing !== undefined) throw new ServiceError(`The project has no clip ${missing}; read describe_project.`, 404);
  return layout.filter((item) => ids.includes(item.clip.id)).sort((left, right) => left.start - right.start);
}

/** The analysed frames in sample order, each distinct source frame decoded once. */
async function colourFrames(stills: ServiceContext['stills'], reads: readonly Read[]): Promise<AnalysisFrame[]> {
  const frames: AnalysisFrame[] = [];
  await forEachSerial(reads, async ({ mediaId, sourceFrames }) => {
    const decoded = await stills.analysisFrames(mediaId, sourceFrames);
    for (const source of sourceFrames) frames.push(decoded.get(source)!);
  });
  return frames;
}

/** Temperature and Tint as track values, leaving an animated one unchanged. */
function whiteBalanceValues(layer: VideoLayer, balance: WhiteBalance): EditCommand[] {
  const settings = (['temperature', 'tint'] as const).filter((setting) => !hasLayerKeys(layer, setting));
  if (!settings.length) return [];
  const colour = { ...layer.colour };
  for (const setting of settings) colour[setting] = balance[setting];
  return [{ type: 'colour', layerId: layer.id, colour }];
}

const tooUniform = (): ServiceError =>
  invalid('These frames are too dark, clipped or uniform to analyse; try other frames.');

interface Estimated {
  fields: object;
  commands: EditCommand[];
  /** Settings the track animates, which applying as values leaves unchanged. */
  unchanged: string[];
}

async function estimateDetail({ stills }: ServiceContext, { reads, clip }: Target): Promise<Estimated> {
  const read = reads[0]!;
  const measure = measureDetail(await stills.lumaFrames(read.mediaId, read.sourceFrames));
  const suggested = suggestDetail(measure);
  const commands: EditCommand[] = clip ? [{ type: 'detail', clipId: clip.clip.id, detail: suggested }] : [];
  return { fields: { detail: { ...measure, suggested } }, commands, unchanged: [] };
}

async function estimateWhiteBalance(
  context: ServiceContext,
  { reads, layer }: Target,
  input: Input,
): Promise<Estimated> {
  const balance = poolWhiteBalance((await colourFrames(context.stills, reads)).map(frameIlluminant));
  if (!balance) throw tooUniform();
  const fields = { whiteBalance: balance };
  if (!layer) return { fields, commands: [], unchanged: [] };
  if (input.applyAs === 'keyframe')
    return { fields, commands: whiteBalanceCommands(layer, input.frame!, balance), unchanged: [] };
  const unchanged = (['temperature', 'tint'] as const).filter((setting) => hasLayerKeys(layer, setting));
  return { fields, commands: whiteBalanceValues(layer, balance), unchanged };
}

async function estimateAutoAdjust(context: ServiceContext, { reads, layer }: Target, input: Input): Promise<Estimated> {
  const fitted = analyseAutoAdjust(await colourFrames(context.stills, reads));
  if (!fitted) throw tooUniform();
  const intensity = input.intensity / 100;
  const fields = { correction: scaleCorrection(fitted, intensity) };
  if (!layer) return { fields, commands: [], unchanged: [] };
  if (input.applyAs === 'keyframe')
    return { fields, commands: captureCommands(layer, input.frame!, fields.correction), unchanged: [] };
  const command = autoAdjustCommand(layer, fitted, intensity);
  return { fields, commands: command ? [command] : [], unchanged: animatedSettings(layer) };
}

const estimators = {
  detail: estimateDetail,
  'white-balance': estimateWhiteBalance,
  'auto-adjust': estimateAutoAdjust,
} satisfies Record<Input['kind'], (context: ServiceContext, target: Target, input: Input) => Promise<Estimated>>;

type ShotValues = Partial<Record<KeyframeSetting, number>>;

/**
 * Each shot's values keyed at its first frame with Hold; across a cross-dissolve between two shots, the left
 * shot's values at the overlap's start and the right shot's at its end, so the grade blends over the dissolve.
 */
export function shotCommands(
  transitions: readonly PlacedTransition[],
  shots: readonly { clip: PlacedClip; values: ShotValues }[],
): EditCommand[] {
  const byId = new Map(shots.map((shot) => [shot.clip.clip.id, shot]));
  const keys = new Map<string, Map<number, { values: ShotValues; easing: Interpolation }>>();
  for (const shot of shots) {
    const layerId = shot.clip.clip.layerId;
    const layer = keys.get(layerId) ?? new Map<number, { values: ShotValues; easing: Interpolation }>();
    keys.set(layerId, layer);
    const dissolve = transitions.find(
      (item) =>
        item.layerId === layerId &&
        item.transition.type === 'cross-dissolve' &&
        item.transition.rightId === shot.clip.clip.id &&
        byId.has(item.transition.leftId),
    );
    if (!dissolve) {
      layer.set(shot.clip.start, { values: shot.values, easing: 'hold' });
      continue;
    }
    layer.set(dissolve.start, { values: byId.get(dissolve.transition.leftId)!.values, easing: 'linear' });
    layer.set(dissolve.end, { values: shot.values, easing: 'hold' });
  }
  return [...keys].flatMap(([layerId, layer]) =>
    [...layer]
      .sort(([left], [right]) => left - right)
      .map(([frame, { values, easing }]): EditCommand => ({ type: 'layer-key-set', layerId, frame, values, easing })),
  );
}

/** Each clip analysed whole on its own: its result, and the detail edits or shot keyframes applying them. */
async function estimateClips(
  context: ServiceContext,
  clips: readonly PlacedClip[],
  project: ProjectDocument,
  input: Input,
) {
  const results: { clipId: string; frames: number }[] = [];
  const commands: EditCommand[] = [];
  const shots: { clip: PlacedClip; values: ShotValues }[] = [];
  let frames = 0;
  await forEachSerial(clips, async (clip) => {
    const { mediaId, sourceIn, sourceOut } = clip.clip;
    const sourceFrames =
      input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
    const target = { description: '', reads: [{ mediaId, sourceFrames }], layer: null, clip };
    const estimated = await estimators[input.kind](context, target, input);
    const count = new Set(sourceFrames).size;
    frames += count;
    results.push({ clipId: clip.clip.id, frames: count, ...estimated.fields });
    commands.push(...estimated.commands);
    const values = estimated.fields as { correction?: ShotValues; whiteBalance?: ShotValues };
    if (input.applyAs === 'shots') shots.push({ clip, values: (values.correction ?? values.whiteBalance)! });
  });
  if (shots.length) commands.push(...shotCommands(calculateLayout(project).transitions, shots));
  const clipsWord = clips.length === 1 ? `clip ${clips[0]!.clip.id}` : `${clips.length} clips`;
  return { analysed: { description: `each of the ${clipsWord} on its own, whole`, frames }, results, commands };
}

export const runEstimate: OperationRunner<typeof estimate> = async (context, input) => {
  const project = await context.projects.load(input.projectId);
  checkChoice(input);
  const clips = separateClips(project, input);
  if (clips) {
    const { analysed, results, commands } = await estimateClips(context, clips, project, input);
    return { kind: input.kind, analysed, unchanged: [], commands: input.commands ? commands : [], clips: results };
  }
  const target = targetOf(project, input, context);
  if (input.applyAs === 'keyframe') {
    const full = keyframeLimitReason(target.layer!, input.frame!);
    if (full !== null) throw new ServiceError(full, 409);
  }
  const { fields, commands, unchanged } = await estimators[input.kind](context, target, input);
  const frames = target.reads.reduce((sum, read) => sum + new Set(read.sourceFrames).size, 0);
  return {
    kind: input.kind,
    analysed: { description: target.description, frames },
    unchanged,
    commands: input.commands ? commands : [],
    ...fields,
  };
};
