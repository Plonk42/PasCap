import { z } from 'zod';
import { described } from '../described.js';
import { idSchema } from '../model.js';
import { defineOperation } from './spec.js';

const preparation = described(
  z.enum(['ready', 'preparing', 'unprepared']),
  'Whether its editing cache is ready, being prepared, or not prepared (including a failed preparation).',
);
const analysis = described(
  z.enum(['analysed', 'analysing', 'missing']),
  'Whether its analysis is cached for the current cache, queued or running, or missing.',
);

export const handOffReadiness = defineOperation({
  name: 'hand_off_readiness',
  description:
    'What an assistant can use in a project: each video recording of its bin with its proxy and camera motion analysis, each music recording with its playback cache and tempo analysis, and whether an export is running (stills wait for it).',
  input: z.object({ projectId: described(idSchema, 'ID of the saved project.') }).strict(),
  output: z
    .object({
      recordings: z.array(z.object({ id: idSchema, name: z.string(), preparation, cameraMotion: analysis }).strict()),
      music: z.array(z.object({ id: idSchema, name: z.string(), preparation, beats: analysis }).strict()),
      exportRunning: z.boolean(),
    })
    .strict(),
  access: 'read',
  audience: ['editor'],
});
