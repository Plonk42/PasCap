import { z } from 'zod';
import { described } from '../described.js';
import { idSchema } from '../model.js';
import { defineOperation } from './spec.js';

const preparation = described(
  z.enum(['ready', 'preparing', 'unprepared']),
  'Whether its editing cache is ready, being prepared, or not prepared (including a failed preparation).',
);
const analysis = described(
  z.enum(['analyzed', 'analyzing', 'missing']),
  'Whether its analysis is cached for the current cache, queued or running, or missing.',
);

export const handOffReadiness = defineOperation({
  name: 'hand_off_readiness',
  description:
    'What an assistant can use in a project: each video recording of its bin with its proxy and camera motion analysis, each music recording with its playback cache and tempo analysis, whether an export is running (stills wait for it), and how an MCP client connects.',
  input: z.object({ projectId: described(idSchema, 'ID of the saved project.') }).strict(),
  output: z
    .object({
      recordings: z.array(z.object({ id: idSchema, name: z.string(), preparation, cameraMotion: analysis }).strict()),
      music: z.array(z.object({ id: idSchema, name: z.string(), preparation, beats: analysis }).strict()),
      exportRunning: z.boolean(),
      connection: described(
        z
          .object({
            url: described(z.string(), 'The MCP endpoint clients connect to.'),
            tokenFile: described(z.string(), 'File holding the bearer token clients send.'),
            lastCall: described(
              z.string().nullable(),
              'When an MCP client last called PasCap since the service started (ISO time); null if none has.',
            ),
            client: described(z.string().nullable(), 'The name that client gave, if any.'),
          })
          .strict(),
        'How to connect an MCP client, and whether one has.',
      ),
    })
    .strict(),
  access: 'read',
  audience: ['editor'],
});
