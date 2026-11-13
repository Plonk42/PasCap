import {
  analyzeAutoAdjust,
  AUTO_ADJUST,
  autoAdjustFrames,
  scaleCorrection,
  type AutoCorrection,
} from '../../shared/auto-adjust.js';
import {
  animatedSettings,
  autoAdjustCommand,
  captureCommands,
  keyframeLimitReason,
  trackSamples,
  whiteBalanceCommands,
  windowSourceFrames,
  type AutoOwner,
  type GradeValues,
} from '../../shared/auto-color.js';
import type { EditCommand } from '../../shared/commands.js';
import { detailFrames, measureDetail, suggestDetail } from '../../shared/detail-estimate.js';
import { createColorSettings, type ColorSettings, type ScalarColorSetting } from '../../shared/color.js';
import { gradeColorAt, gradeKeyAsLayerKey } from '../../shared/grade.js';
import { hasLayerKeys } from '../../shared/keyframes.js';
import {
  matchFrame,
  matchStyle,
  measureLook,
  towardsMatch,
  type FrameMatch,
  type GradedFrame,
  type LookProfile,
} from '../../shared/look-match.js';
import type { ProjectDocument } from '../../shared/model.js';
import type { estimate } from '../../shared/operations/estimate.js';
import { projectVideoIds } from '../../shared/projects.js';
import { forEachSerial } from '../../shared/serial.js';
import { calculateLayout, gradePosition, type PlacedClip } from '../../shared/timeline.js';
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

/** The clip grade an estimate's Color commands edit, and the source frame a keyframe goes to. */
interface GradeTarget {
  owner: AutoOwner;
  values: GradeValues;
  keyFrame: number | null;
}

/** What an estimate analyzes, and the clip grade its commands edit. */
interface Target {
  description: string;
  reads: Read[];
  grade: GradeTarget | null;
  clip: PlacedClip | null;
  /** A match's one frame: the grade's settings there (neutral for a recording as shot). */
  color?: ColorSettings;
}

/** The frame a match reads in a clip: at `frame` when given, else the clip's middle frame. */
function matchedFrame(clip: PlacedClip, frame?: number): { sourceFrame: number; color: ColorSettings } {
  const offset = frame === undefined ? (clip.end - clip.start) >> 1 : frame - clip.start;
  return {
    sourceFrame: clip.retiming.sourceAt(offset),
    color: gradeColorAt(clip.clip.grade, gradePosition(clip, offset)),
  };
}

function clipGrade(clip: PlacedClip, keyFrame: number | null): GradeTarget {
  const { grade } = clip.clip;
  return {
    owner: { kind: 'clip', clipId: clip.clip.id },
    values: { color: grade.color, keyframes: grade.keyframes.map(gradeKeyAsLayerKey) },
    keyFrame,
  };
}

const invalid = (message: string): ServiceError => new ServiceError(message, 422);

function clipTarget(project: ProjectDocument, input: Input, hero: Hero | null): Target {
  const clip = calculateLayout(project).clips.find((item) => item.clip.id === input.clipId);
  if (!clip) throw new ServiceError(`The project has no clip ${input.clipId}; read describe_project.`, 404);
  if (input.frame !== undefined && (input.frame < clip.start || input.frame >= clip.end))
    throw invalid(
      `Frame ${input.frame} is outside clip ${clip.clip.id}, which plays frames ${clip.start}–${clip.end - 1}.`,
    );
  const { mediaId, sourceIn, sourceOut } = clip.clip;
  if (input.kind === 'match') {
    const { sourceFrame, color } = matchedFrame(clip, input.frame);
    if (hero?.clipId === clip.clip.id && hero.sourceFrame === sourceFrame)
      throw invalid(`Frame ${sourceFrame} of clip ${clip.clip.id} is the reference itself: match another frame.`);
    return {
      description: `source frame ${sourceFrame} of clip ${clip.clip.id}`,
      reads: [{ mediaId, sourceFrames: [sourceFrame] }],
      grade: clipGrade(clip, input.frame === undefined ? null : sourceFrame),
      clip,
      color,
    };
  }
  if (input.frame === undefined) {
    const sourceFrames =
      input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
    return {
      description: `the whole clip ${clip.clip.id}`,
      reads: [{ mediaId, sourceFrames }],
      grade: clipGrade(clip, null),
      clip,
    };
  }
  const frame = input.frame;
  // Auto white balance weighs each project frame of the window, Auto adjust each source frame once.
  const sourceFrames =
    input.kind === 'white-balance'
      ? whiteBalanceWindow(clip, frame).map((projectFrame) => clip.retiming.sourceAt(projectFrame - clip.start))
      : windowSourceFrames(clip, frame);
  return {
    description: `1 s around frame ${frame} in clip ${clip.clip.id}`,
    reads: [{ mediaId, sourceFrames }],
    grade: clipGrade(clip, clip.retiming.sourceAt(frame - clip.start)),
    clip,
  };
}

function trackTarget(project: ProjectDocument, input: Input): Target {
  const layer = project.layers.find((item) => item.id === input.layerId);
  if (!layer) throw new ServiceError(`The project has no video track ${input.layerId}; read describe_project.`, 404);
  if (input.kind === 'detail') throw invalid('Detail belongs to each clip: estimate it with clipId.');
  if (input.kind === 'match')
    throw invalid('A match reads one frame per clip: match the clips of a track with applyAs shots.');
  const clips = calculateLayout(project).clips.filter((item) => item.clip.layerId === layer.id);
  if (!clips.length) throw invalid(`${layer.name} has no clips to analyze.`);
  const reads = new Map<string, Read>();
  for (const { clip, sourceFrame } of trackSamples(clips)) {
    const read = reads.get(clip.clip.mediaId) ?? { mediaId: clip.clip.mediaId, sourceFrames: [] };
    if (!read.sourceFrames.includes(sourceFrame)) read.sourceFrames.push(sourceFrame);
    reads.set(read.mediaId, read);
  }
  const clipsWord = clips.length === 1 ? 'clip' : `${clips.length} clips`;
  return { description: `the ${clipsWord} of ${layer.name}`, reads: [...reads.values()], grade: null, clip: null };
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
  if (input.kind === 'match') {
    const sourceFrame = (sourceIn + sourceOut) >> 1;
    return {
      description: `source frame ${sourceFrame} of ${asset.name}, as shot`,
      reads: [{ mediaId, sourceFrames: [sourceFrame] }],
      grade: null,
      clip: null,
      color: createColorSettings(),
    };
  }
  const sourceFrames =
    input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
  return {
    description: `${asset.name} from ${sourceIn} to ${sourceOut}`,
    reads: [{ mediaId, sourceFrames }],
    grade: null,
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
  const references = [
    input.referenceClipId !== undefined || input.referenceFrame !== undefined,
    input.referenceMediaId !== undefined,
    input.style !== undefined,
  ].filter(Boolean).length;
  if (input.kind === 'match' && references !== 1)
    throw invalid(
      'A match needs one reference: a hero frame (referenceClipId and/or referenceFrame), a recording frame (referenceMediaId with referenceSourceFrame) or a style.',
    );
  if (input.kind !== 'match' && references > 0)
    throw invalid('referenceClipId, referenceFrame, referenceMediaId and style belong to kind match.');
  if ((input.referenceMediaId === undefined) !== (input.referenceSourceFrame === undefined))
    throw invalid('A recording reference needs both referenceMediaId and referenceSourceFrame.');
}

/** The clip whose frame is the reference of a match: never changed, left out of the clips matched each on their own. */
interface Hero {
  clipId: string;
  sourceFrame: number;
}

/** What a match aims at: a reference frame as its grade shows it, or a registered style; and how outputs name it. */
type MatchAim =
  | {
      frame: GradedFrame;
      hero: Hero | null;
      fields: { reference: { clipId?: string; mediaId: string; sourceFrame: number } };
    }
  | { look: LookProfile; hero: null; fields: { style: { id: string; name: string } } };

const noReference = (what: string): ServiceError =>
  invalid(`The reference ${what} is too dark, clipped or uniform to match; choose another.`);

/** The hero clip of a match and its frame: at referenceFrame, else its middle frame. */
function heroOf(project: ProjectDocument, input: Input): { clip: PlacedClip; frame: number | undefined } {
  const layout = calculateLayout(project).clips;
  const frame = input.referenceFrame;
  let clip: PlacedClip | undefined;
  if (input.referenceClipId !== undefined) {
    clip = layout.find((item) => item.clip.id === input.referenceClipId);
    if (!clip) throw new ServiceError(`The project has no clip ${input.referenceClipId}; read describe_project.`, 404);
  } else {
    const playing = layout.filter((item) => frame! >= item.start && frame! < item.end);
    if (playing.length !== 1)
      throw invalid(
        playing.length
          ? `Several tracks play a clip at frame ${frame}: give referenceClipId.`
          : `No clip plays at frame ${frame}.`,
      );
    clip = playing[0]!;
  }
  if (frame !== undefined && (frame < clip.start || frame >= clip.end))
    throw invalid(`Frame ${frame} is outside clip ${clip.clip.id}, which plays frames ${clip.start}–${clip.end - 1}.`);
  return { clip, frame };
}

async function matchAim(context: ServiceContext, project: ProjectDocument, input: Input): Promise<MatchAim> {
  if (input.style !== undefined) {
    const style = await context.styles.get(input.style);
    return { look: style.look, hero: null, fields: { style: { id: style.id, name: style.name } } };
  }
  if (input.referenceMediaId !== undefined) {
    const mediaId = input.referenceMediaId;
    if (!projectVideoIds(project).has(mediaId))
      throw new ServiceError(`The project has no video recording ${mediaId}; read describe_project.`, 404);
    const sourceFrame = input.referenceSourceFrame!;
    const asset = context.library.get(mediaId);
    if (sourceFrame >= asset.metadata.frameCount)
      throw invalid(`${asset.name} has ${asset.metadata.frameCount} frames: referenceSourceFrame is past its end.`);
    const [frame] = await colorFrames(context.stills, [{ mediaId, sourceFrames: [sourceFrame] }]);
    const color = createColorSettings();
    if (!measureLook([frame!], color)) throw noReference(`frame of ${asset.name}`);
    return {
      frame: { frame: frame!, color },
      hero: null,
      fields: { reference: { mediaId, sourceFrame } },
    };
  }
  const { clip, frame: projectFrame } = heroOf(project, input);
  const { sourceFrame, color } = matchedFrame(clip, projectFrame);
  const [frame] = await colorFrames(context.stills, [{ mediaId: clip.clip.mediaId, sourceFrames: [sourceFrame] }]);
  if (!measureLook([frame!], color)) throw noReference(`frame of clip ${clip.clip.id}`);
  return {
    frame: { frame: frame!, color },
    hero: { clipId: clip.clip.id, sourceFrame },
    fields: { reference: { clipId: clip.clip.id, mediaId: clip.clip.mediaId, sourceFrame } },
  };
}

function targetOf(project: ProjectDocument, input: Input, context: ServiceContext, hero: Hero | null): Target {
  if (input.applyAs === 'keyframe' && (input.kind === 'detail' || input.frame === undefined))
    throw invalid('A keyframe takes the light at one frame: give clipId and frame, for a Color kind.');
  if (input.clipId !== undefined) return clipTarget(project, input, hero);
  if (input.layerId !== undefined) {
    if (input.kind !== 'detail' && input.commands)
      throw invalid(
        "A track has no Color of its own: write each clip's grade with applyAs shots, or give commands false for the values of one compromise.",
      );
    return trackTarget(project, input);
  }
  return rangeTarget(project, input, context);
}

/** The clips analyzed each on its own, in timeline order, or null for one analysis; a match leaves its hero out. */
function separateClips(project: ProjectDocument, input: Input, hero: Hero | null): PlacedClip[] | null {
  const shots = input.applyAs === 'shots';
  if (shots && input.kind === 'detail') throw invalid('applyAs shots keys Color: use it with a Color kind.');
  if (shots && (input.frame !== undefined || input.mediaId !== undefined))
    throw invalid('applyAs shots analyzes whole clips: give clipId, clipIds or layerId, without frame.');
  const each = input.clipIds !== undefined || shots || (input.layerId !== undefined && input.kind === 'detail');
  if (!each) return null;
  if (input.kind !== 'detail' && !shots)
    throw invalid(
      'Several clips get a grade each with applyAs shots (their clip grades); layerId with commands false fits one compromise to the whole track.',
    );
  const layout = calculateLayout(project).clips;
  if (input.layerId !== undefined) {
    if (!project.layers.some((layer) => layer.id === input.layerId))
      throw new ServiceError(`The project has no video track ${input.layerId}; read describe_project.`, 404);
    const clips = layout.filter((item) => item.clip.layerId === input.layerId && item.clip.id !== hero?.clipId);
    if (!clips.length) throw invalid('This track has no clips to analyze.');
    return clips;
  }
  return listedClips(layout, input.clipIds ?? [input.clipId!], hero);
}

function listedClips(layout: readonly PlacedClip[], ids: readonly string[], hero: Hero | null): PlacedClip[] {
  if (new Set(ids).size !== ids.length) throw invalid('List each clip once.');
  if (hero !== null && ids.includes(hero.clipId))
    throw invalid(
      `Clip ${hero.clipId} holds the reference frame: a match never changes it. Leave it out of the matched clips.`,
    );
  const missing = ids.find((id) => !layout.some((item) => item.clip.id === id));
  if (missing !== undefined) throw new ServiceError(`The project has no clip ${missing}; read describe_project.`, 404);
  return layout.filter((item) => ids.includes(item.clip.id)).sort((left, right) => left.start - right.start);
}

/** The analyzed frames in sample order, each distinct source frame decoded once. */
async function colorFrames(stills: ServiceContext['stills'], reads: readonly Read[]): Promise<AnalysisFrame[]> {
  const frames: AnalysisFrame[] = [];
  await forEachSerial(reads, async ({ mediaId, sourceFrames }) => {
    const decoded = await stills.analysisFrames(mediaId, sourceFrames);
    for (const source of sourceFrames) frames.push(decoded.get(source)!);
  });
  return frames;
}

/** Temperature and Tint as the grade's values, leaving an animated one unchanged. */
function whiteBalanceValues({ owner, values }: GradeTarget, balance: WhiteBalance): EditCommand[] {
  const settings = (['temperature', 'tint'] as const).filter((setting) => !hasLayerKeys(values, setting));
  if (!settings.length || owner.kind !== 'clip') return [];
  const changed = Object.fromEntries(settings.map((setting) => [setting, balance[setting]]));
  return [{ type: 'color-patch', clipIds: [owner.clipId], settings: changed }];
}

const tooUniform = (): ServiceError =>
  invalid('These frames are too dark, clipped or uniform to analyze; try other frames.');

interface Estimated {
  fields: object;
  commands: EditCommand[];
  /** Settings the grade animates, which applying as values leaves unchanged. */
  unchanged: string[];
}

async function estimateDetail({ stills }: ServiceContext, { reads, clip }: Target): Promise<Estimated> {
  const read = reads[0]!;
  const measure = measureDetail(await stills.lumaFrames(read.mediaId, read.sourceFrames));
  const suggested = suggestDetail(measure);
  const commands: EditCommand[] = clip
    ? [{ type: 'detail-patch', clipIds: [clip.clip.id], settings: { ...suggested } }]
    : [];
  return { fields: { detail: { ...measure, suggested } }, commands, unchanged: [] };
}

async function estimateWhiteBalance(
  context: ServiceContext,
  { reads, grade }: Target,
  input: Input,
): Promise<Estimated> {
  const balance = poolWhiteBalance((await colorFrames(context.stills, reads)).map(frameIlluminant));
  if (!balance) throw tooUniform();
  const fields = { whiteBalance: balance };
  if (!grade) return { fields, commands: [], unchanged: [] };
  if (input.applyAs === 'keyframe')
    return {
      fields,
      commands: whiteBalanceCommands(grade.keyFrame!, balance, grade.owner),
      unchanged: [],
    };
  const unchanged = (['temperature', 'tint'] as const).filter((setting) => hasLayerKeys(grade.values, setting));
  return { fields, commands: whiteBalanceValues(grade, balance), unchanged };
}

async function estimateAutoAdjust(context: ServiceContext, target: Target, input: Input): Promise<Estimated> {
  const fitted = analyzeAutoAdjust(await colorFrames(context.stills, target.reads));
  if (!fitted) throw tooUniform();
  return correctionEdits(fitted, target, input);
}

/** The fitted correction at the intensity asked, and the edits writing it into the target's clip grade. */
function correctionEdits(fitted: AutoCorrection, { grade }: Target, input: Input): Estimated {
  const intensity = (input.intensity ?? AUTO_ADJUST.balancedIntensity * 100) / 100;
  const fields = { correction: scaleCorrection(fitted, intensity) };
  if (!grade) return { fields, commands: [], unchanged: [] };
  if (input.applyAs === 'keyframe')
    return {
      fields,
      commands: captureCommands(grade.keyFrame!, fields.correction, grade.owner),
      unchanged: [],
    };
  const command = autoAdjustCommand(grade.values, fitted, intensity, grade.owner);
  return { fields, commands: command ? [command] : [], unchanged: animatedSettings(grade.values) };
}

/**
 * A match of the target's one frame to the aim, moved from the grade by the Intensity asked (100% by default), and the
 * edits writing it into the target's clip grade.
 */
function estimateMatch(aim: MatchAim): Estimator {
  return async (context, target, input) => {
    const [frame] = await colorFrames(context.stills, target.reads);
    const graded = { frame: frame!, color: target.color ?? createColorSettings() };
    let match: FrameMatch | null;
    if ('look' in aim) {
      const correction = matchStyle(aim.look, graded);
      match = correction && { correction, likeness: 0 };
    } else match = matchFrame(aim.frame, graded);
    if (!match) throw tooUniform();
    const values = towardsMatch(graded.color, match.correction, (input.intensity ?? 100) / 100);
    const fields = { correction: values, ...('look' in aim ? {} : { likeness: Number(match.likeness.toFixed(2)) }) };
    const { grade } = target;
    if (!grade) return { fields, commands: [], unchanged: [] };
    if (input.applyAs === 'keyframe')
      return { fields, commands: captureCommands(grade.keyFrame!, values, grade.owner), unchanged: [] };
    const command = autoAdjustCommand(grade.values, values, AUTO_ADJUST.balancedIntensity, grade.owner);
    return { fields, commands: command ? [command] : [], unchanged: animatedSettings(grade.values) };
  };
}

type Estimator = (context: ServiceContext, target: Target, input: Input) => Promise<Estimated>;
const estimators = {
  detail: estimateDetail,
  'white-balance': estimateWhiteBalance,
  'auto-adjust': estimateAutoAdjust,
} satisfies Record<Exclude<Input['kind'], 'match'>, Estimator>;

type ShotValues = Partial<Record<ScalarColorSetting, number>>;

/**
 * Each shot's values written into its clip's grade, which applies before any adjustment and stays with the
 * clip; settings the grade animates follow their keyframes and are left out. A cross-dissolve then blends the
 * two clips' grades.
 */
export function shotCommands(shots: readonly { clip: PlacedClip; values: ShotValues }[]): EditCommand[] {
  return shots.flatMap(({ clip, values }) => {
    const { keyframes } = clip.clip.grade;
    const settings = Object.fromEntries(
      Object.entries(values).filter(([setting]) =>
        keyframes.every((key) => key.values[setting as ScalarColorSetting] === null),
      ),
    );
    return Object.keys(settings).length ? [{ type: 'color-patch' as const, clipIds: [clip.clip.id], settings }] : [];
  });
}

/** Each clip analyzed on its own (a match at its middle frame, else whole): its result, and the edits applying them. */
async function estimateClips(
  context: ServiceContext,
  clips: readonly PlacedClip[],
  input: Input,
  estimator: Estimator,
) {
  const results: { clipId: string; frames: number }[] = [];
  const commands: EditCommand[] = [];
  const shots: { clip: PlacedClip; values: ShotValues }[] = [];
  let frames = 0;
  await forEachSerial(clips, async (clip) => {
    const { mediaId, sourceIn, sourceOut } = clip.clip;
    let target: Target;
    if (input.kind === 'match') {
      const { sourceFrame, color } = matchedFrame(clip);
      target = { description: '', reads: [{ mediaId, sourceFrames: [sourceFrame] }], grade: null, clip, color };
    } else {
      const sourceFrames =
        input.kind === 'detail' ? detailFrames(sourceIn, sourceOut) : autoAdjustFrames(sourceIn, sourceOut);
      target = { description: '', reads: [{ mediaId, sourceFrames }], grade: null, clip };
    }
    const estimated = await estimator(context, target, input);
    const count = new Set(target.reads[0]!.sourceFrames).size;
    frames += count;
    results.push({ clipId: clip.clip.id, frames: count, ...estimated.fields });
    commands.push(...estimated.commands);
    const values = estimated.fields as { correction?: ShotValues; whiteBalance?: ShotValues };
    if (input.applyAs === 'shots') shots.push({ clip, values: (values.correction ?? values.whiteBalance)! });
  });
  commands.push(...shotCommands(shots));
  const clipsWord = clips.length === 1 ? `clip ${clips[0]!.clip.id}` : `${clips.length} clips`;
  const how = input.kind === 'match' ? 'at its middle frame' : 'whole';
  return { analyzed: { description: `each of the ${clipsWord} on its own, ${how}`, frames }, results, commands };
}

export const runEstimate: OperationRunner<typeof estimate> = async (context, input) => {
  const project = await context.projects.load(input.projectId);
  checkChoice(input);
  const aim = input.kind === 'match' ? await matchAim(context, project, input) : null;
  const hero = aim?.hero ?? null;
  const clips = separateClips(project, input, hero);
  const target = clips ? null : targetOf(project, input, context, hero);
  if (target && input.applyAs === 'keyframe') {
    const { values, keyFrame, owner } = target.grade!;
    const full = keyframeLimitReason(values, keyFrame!, owner);
    if (full !== null) throw new ServiceError(full, 409);
  }
  const estimator: Estimator = aim ? estimateMatch(aim) : estimators[input.kind as keyof typeof estimators];
  const reference = aim?.fields ?? {};
  if (clips) {
    const { analyzed, results, commands } = await estimateClips(context, clips, input, estimator);
    return {
      revision: project.revision,
      kind: input.kind,
      analyzed,
      ...reference,
      unchanged: [],
      commands: input.commands ? commands : [],
      clips: results,
    };
  }
  const { fields, commands, unchanged } = await estimator(context, target!, input);
  const frames = target!.reads.reduce((sum, read) => sum + new Set(read.sourceFrames).size, 0);
  return {
    revision: project.revision,
    kind: input.kind,
    analyzed: { description: target!.description, frames },
    ...reference,
    unchanged,
    commands: input.commands ? commands : [],
    ...fields,
  };
};
