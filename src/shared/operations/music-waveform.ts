import { z } from 'zod';
import { described } from '../described.js';
import { idSchema } from '../model.js';
import { WAVEFORM_BUCKET } from '../waveform.js';
import { defineOperation } from './spec.js';

export const musicWaveform = defineOperation({
  name: 'music_waveform',
  description:
    'The level of a prepared music recording for drawing its waveform in the editor: the lowest and highest sample of either channel for every 10 ms of its playback cache, read from a saved cache or drawn from the cache once.',
  input: z.object({ mediaId: described(idSchema, 'ID of a prepared music recording.') }).strict(),
  output: z
    .object({
      bucketSamples: described(z.literal(WAVEFORM_BUCKET), 'Samples of the 48 kHz cache in each bucket.'),
      data: described(
        z.string(),
        'Base64 of signed bytes, a minimum then a maximum per bucket from the start of the recording, -127 to 127 for full scale.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor'],
});
