import type { musicWaveform } from '../../shared/operations/music-waveform.js';
import type { OperationRunner } from './context.js';

export const runMusicWaveform: OperationRunner<typeof musicWaveform> = ({ audio }, { mediaId }) =>
  audio.detailWaveform(mediaId);
