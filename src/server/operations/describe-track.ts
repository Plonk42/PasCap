import { NEUTRAL_COLOR, scalarColorValues } from '../../shared/color.js';
import { adjustmentAt, adjustmentColorAt, gradeColorAt, isNeutralClipGrade } from '../../shared/grade.js';
import type { Interpolation } from '../../shared/keyframes.js';
import type { describeTrack } from '../../shared/operations/describe-track.js';
import { detailSummary, gradeSummary } from '../../shared/operations/grade-summary.js';
import {
  evaluateSpatial,
  hasSpatialChannelKeys,
  NEUTRAL_SPATIAL_POSE,
  SPATIAL_CHANNELS,
} from '../../shared/spatial.js';
import { calculateLayout, gradePosition } from '../../shared/timeline.js';
import { formatTimecode } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner } from './context.js';

/** A keyframe's enabled settings and their Easing only. */
function compact<K extends string>(key: {
  frame: number;
  values: Readonly<Record<K, number | null>>;
  easing: Readonly<Record<K, Interpolation | null>>;
  reset: boolean;
}) {
  const keyed = (Object.keys(key.values) as K[]).filter((setting) => key.values[setting] !== null);
  return {
    frame: key.frame,
    timecode: formatTimecode(key.frame),
    values: Object.fromEntries(keyed.map((setting) => [setting, key.values[setting]])) as Partial<Record<K, number>>,
    easing: Object.fromEntries(keyed.map((setting) => [setting, key.easing[setting]])) as Partial<
      Record<K, Interpolation>
    >,
    reset: key.reset,
  };
}

/** The chosen values (all when null) that differ from neutral. */
function only<T extends object>(values: T, settings: ReadonlySet<string> | null, neutral: Readonly<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => (!settings || settings.has(key)) && value !== neutral[key as keyof T],
    ),
  ) as Partial<T>;
}

const NEUTRAL_SCALARS = scalarColorValues(NEUTRAL_COLOR);

export const runDescribeTrack: OperationRunner<typeof describeTrack> = async (
  { projects },
  { projectId, layerId, frames = [], include, settings },
) => {
  const project = await projects.load(projectId);
  const track = project.layers.find((layer) => layer.id === layerId);
  if (!track) throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  const parts = new Set(include);
  const chosen = settings ? new Set<string>(settings) : null;
  const placed = calculateLayout(project).clips.filter((item) => item.clip.layerId === layerId);
  const graded = placed.filter(({ clip }) => clip.grade.keyframes.length || !isNeutralClipGrade(clip.grade));
  const over = ({ start, end }: { start: number; end: number }) =>
    project.adjustments.filter((item) => item.start < end && start < item.start + item.duration);
  const adjustments = project.adjustments.filter((item) => placed.some((clip) => over(clip).includes(item)));
  return {
    revision: project.revision,
    ...(parts.has('track') && { track }),
    ...(parts.has('keyframes') && {
      keyframes: {
        transform: track.transform.keyframes.map(compact),
        clips: placed
          .filter(({ clip }) => clip.grade.keyframes.length)
          .map(({ clip }) => ({ clipId: clip.id, keyframes: clip.grade.keyframes.map(compact) })),
        adjustments: adjustments
          .filter((item) => item.keyframes.length)
          .map((item) => ({
            adjustmentId: item.id,
            keyframes: item.keyframes.map((key) => ({
              ...compact(key),
              timecode: formatTimecode(item.start + key.frame),
            })),
          })),
      },
    }),
    ...(parts.has('grades') && {
      grades: placed.map((item) => {
        const detail = detailSummary(item.clip.detail);
        return {
          clipId: item.clip.id,
          grade: gradeSummary(item.clip.grade),
          ...(detail && { detail }),
          adjustmentIds: over(item).map((adjustment) => adjustment.id),
        };
      }),
    }),
    keyed: {
      transform: SPATIAL_CHANNELS.filter((channel) => hasSpatialChannelKeys(track.transform, channel)),
    },
    ...(parts.has('at') && {
      at: frames.map((frame) => {
        const clipGrades = graded
          .filter((item) => frame >= item.start && frame < item.end)
          .map((item) => {
            const sourceFrame = item.retiming.sourceAt(frame - item.start);
            const values = scalarColorValues(gradeColorAt(item.clip.grade, gradePosition(item, frame - item.start)));
            return { clipId: item.clip.id, sourceFrame, values: only(values, chosen, NEUTRAL_SCALARS) };
          });
        const item = adjustmentAt(project.adjustments, frame);
        return {
          frame,
          timecode: formatTimecode(frame),
          ...(item && {
            adjustment: {
              adjustmentId: item.id,
              values: only(scalarColorValues(adjustmentColorAt(item, frame)), chosen, NEUTRAL_SCALARS),
            },
          }),
          transform: only(evaluateSpatial(track.transform, frame), chosen, NEUTRAL_SPATIAL_POSE),
          ...(clipGrades.length > 0 && { clipGrades }),
        };
      }),
    }),
  };
};
