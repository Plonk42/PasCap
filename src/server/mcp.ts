import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import { operations } from '../shared/operations/index.js';
import { ASSISTANT_GUIDE } from './assistant-guide.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { ServiceContext, ServiceResources } from './operations/context.js';
import { runOperation } from './operations/index.js';
import { atomicWrite } from './storage.js';

/**
 * The MCP SDK's handler: the 2026-07-28 revision plus stateless serving of 2025-era clients, a
 * fresh server per request. The tools are the operations whose audience includes the
 * assistant, so the registry stays the only place a capability is described.
 */
export const MCP_PATH = '/mcp';

export const GUIDE_URI = 'pascap://guide';

const INSTRUCTIONS = [
  'PasCap edits drone-flight video projects. Frames are integers at 30000/1001 fps; outputs also give MM:SS:FF timecodes.',
  `Before building or changing a cut, follow the playbook in the ${GUIDE_URI} resource (also the rough_cut prompt).`,
  'Start with list_projects and describe_project; choose footage with describe_recording and recording_sheet, and follow the music with music_analysis, check_alignment and snap_cuts_to_beats. Read a track with describe_track before grading it.',
  "To change a project, first take it with session_start and the user's brief; the user then cannot save it until you call session_end with notes for them or the user takes it back.",
  'Change a project only with edit: its commands apply together against the expectedRevision you last read, or not at all, and a rejected command returns its reason. Clips you add must stay inside the ranges the user kept.',
  'Look at the result with timeline_sheet or still.',
].join(' ');

const assistantOperations = operations.filter((operation) => operation.audience.includes('assistant'));

/** The bearer token MCP clients send; created once in the data directory, readable by its owner only. */
export async function mcpToken(dataDir: string): Promise<string> {
  const filename = path.join(dataDir, 'mcp-token');
  try {
    if (!(await assertNoSymlinks(filename)).isFile())
      throw new ServiceError('The MCP token must be a regular file.', 500);
    const token = (await readFile(filename, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const token = randomBytes(32).toString('hex');
  await atomicWrite(filename, `${token}\n`);
  return token;
}

function authorized(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function failureText(error: unknown): string {
  return error instanceof ZodError
    ? error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')
    : errorMessage(error);
}

/** Pictures become image content beside their legend; everything else is JSON text. */
export function toolResult(output: unknown): CallToolResult {
  if (output && typeof output === 'object' && 'image' in output) {
    const { image, ...rest } = output as { image: { data: string; mimeType: string } };
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType },
        { type: 'text', text: JSON.stringify(rest) },
      ],
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(output) }] };
}

export function mcpServer(resources: ServiceResources): McpServer {
  const context: ServiceContext = { ...resources, caller: 'assistant' };
  const server = new McpServer({ name: 'pascap', title: 'PasCap', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  for (const operation of assistantOperations) {
    const config = {
      description: operation.description,
      // One schema type for the loop; each tool still publishes and validates its own schema.
      inputSchema: operation.input as ZodType,
      annotations: { readOnlyHint: operation.access === 'read', openWorldHint: false },
    };
    server.registerTool(operation.name, config, async (input: unknown) => {
      try {
        const projectId = (input as { projectId?: unknown }).projectId;
        if (typeof projectId === 'string') await context.sessions.touch(projectId);
        return toolResult(await runOperation(operation, context, input));
      } catch (error) {
        // The model reads the service's reason and can correct its call.
        return { content: [{ type: 'text', text: failureText(error) }], isError: true };
      }
    });
  }
  server.registerResource(
    'guide',
    GUIDE_URI,
    {
      title: 'Building a rough cut in PasCap',
      description: 'The playbook: read, take the project, choose footage, structure, build, grade, finish.',
      mimeType: 'text/markdown',
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: ASSISTANT_GUIDE }] }),
  );
  server.registerPrompt(
    'rough_cut',
    {
      title: 'Build a rough cut',
      description: "Build a first cut of a PasCap project from the user's brief, following the playbook.",
      argsSchema: z.object({
        request: z.string().optional().describe("The project and what to make, in the user's words."),
      }),
    },
    ({ request }) => {
      const ask = request ? `The request: ${request}` : 'Ask which project and what to make if the request is unclear.';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${ASSISTANT_GUIDE}\n---\n\nBuild a rough cut following this playbook. ${ask}`,
            },
          },
        ],
      };
    },
  );
  return server;
}

/** `/mcp` for MCP clients: loopback Host and Origin checks as every route, plus the bearer token. */
export function registerMcp(app: FastifyInstance, resources: ServiceResources, token: string): void {
  const handler = createMcpHandler(() => mcpServer(resources), {
    onerror: (error) => app.log.error(error),
  });
  const serve = toNodeHandler(handler, { onerror: (error) => app.log.error(error) });
  app.addHook('onClose', () => handler.close());
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: MCP_PATH,
    handler: async (request, reply) => {
      if (!authorized(request, token))
        return reply.code(401).send({ error: 'Send the PasCap MCP token as Authorization: Bearer <token>.' });
      reply.hijack();
      // Fastify's raw request always has a method and URL; Node types them optional.
      await serve(request.raw as NodeIncomingMessageLike, reply.raw, request.body);
    },
  });
}
