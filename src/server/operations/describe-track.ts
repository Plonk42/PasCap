import { scalarColourValues } from '../../shared/colour.js';
import { colourAt, opacityAt } from '../../shared/composition.js';
import { hasLayerKeys, KEYFRAME_SETTINGS } from '../../shared/keyframes.js';
import type { describeTrack } from '../../shared/operations/describe-track.js';
import { evaluateSpatial, hasSpatialChannelKeys, SPATIAL_CHANNELS } from '../../shared/spatial.js';
import { formatTimecode } from '../../shared/timing.js';
import { ServiceError } from '../errors.js';
import type { OperationRunner } from './context.js';

export const runDescribeTrack: OperationRunner<typeof describeTrack> = async (
  { projects },
  { projectId, layerId, frames = [] },
) => {
  const project = await projects.load(projectId);
  const track = project.layers.find((layer) => layer.id === layerId);
  if (!track) throw new ServiceError(`The project has no video track ${layerId}.`, 404);
  return {
    revision: project.revision,
    track,
    keyed: {
      colour: KEYFRAME_SETTINGS.map((setting) => setting.key).filter((setting) => hasLayerKeys(track, setting)),
      transform: SPATIAL_CHANNELS.filter((channel) => hasSpatialChannelKeys(track.transform, channel)),
    },
    at: frames.map((frame) => ({
      frame,
      timecode: formatTimecode(frame),
      values: { opacity: opacityAt(track, frame), ...scalarColourValues(colourAt(track, frame)) },
      transform: evaluateSpatial(track.transform, frame),
    })),
  };
};
