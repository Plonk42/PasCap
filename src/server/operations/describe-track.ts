import { scalarColourValues } from '../../shared/colour.js';
import { colourAt, opacityAt } from '../../shared/composition.js';
import { hasLayerKeys, KEYFRAME_SETTINGS, type Interpolation } from '../../shared/keyframes.js';
import type { describeTrack } from '../../shared/operations/describe-track.js';
import { evaluateSpatial, hasSpatialChannelKeys, SPATIAL_CHANNELS } from '../../shared/spatial.js';
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

function only<T extends object>(values: T, settings: ReadonlySet<string> | null): Partial<T> {
  return settings
    ? (Object.fromEntries(Object.entries(values).filter(([key]) => settings.has(key))) as Partial<T>)
    : values;
}

export const runDescribeTrack: OperationRunner<typeof describeTrack> = async (
  { projects },
  { projectId, layerId, frames = [], include, settings },
) => {
  const project = await projects.load(projectId);
  const track = project.layers.find((layer) => layer.id === layerId);
  if (!track) throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  const parts = new Set(include);
  const chosen = settings ? new Set<string>(settings) : null;
  return {
    revision: project.revision,
    ...(parts.has('track') && { track }),
    ...(parts.has('keyframes') && {
      keyframes: { colour: track.keyframes.map(compact), transform: track.transform.keyframes.map(compact) },
    }),
    keyed: {
      colour: KEYFRAME_SETTINGS.map((setting) => setting.key).filter((setting) => hasLayerKeys(track, setting)),
      transform: SPATIAL_CHANNELS.filter((channel) => hasSpatialChannelKeys(track.transform, channel)),
    },
    ...(parts.has('at') && {
      at: frames.map((frame) => ({
        frame,
        timecode: formatTimecode(frame),
        values: only({ opacity: opacityAt(track, frame), ...scalarColourValues(colourAt(track, frame)) }, chosen),
        transform: only(evaluateSpatial(track.transform, frame), chosen),
      })),
    }),
  };
};
