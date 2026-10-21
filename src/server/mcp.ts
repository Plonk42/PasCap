import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import { operations } from '../shared/operations/index.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { ServiceContext } from './operations/context.js';
import { runOperation } from './operations/index.js';
import { atomicWrite } from './storage.js';

/**
 * The MCP SDK's server in stateless Streamable HTTP mode: each request gets its own server and
 * transport, answered with JSON. The tools are the operations whose audience includes the
 * assistant, so the registry stays the only place a capability is described.
 */
export const MCP_PATH = '/mcp';

const INSTRUCTIONS = [
  'PasCap edits drone-flight video projects. Frames are integers at 30000/1001 fps; outputs also give MM:SS:FF timecodes.',
  'Start with describe_project, and read a track with describe_track before grading it.',
  'Change a project only with edit: its commands apply together against the expectedRevision you last read, or not at all, and a rejected command returns its reason.',
  'Look at the result with timeline_sheet or still, and choose footage with recording_sheet.',
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

export function mcpServer(context: ServiceContext): McpServer {
  const server = new McpServer({ name: 'pascap', title: 'PasCap', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  for (const operation of assistantOperations) {
    const config = {
      description: operation.description,
      inputSchema: operation.input as ZodType,
      annotations: { readOnlyHint: operation.access === 'read', openWorldHint: false },
    };
    server.registerTool(operation.name, config, async (input: unknown) => {
      try {
        return toolResult(await runOperation(operation, context, input));
      } catch (error) {
        // The model reads the service's reason and can correct its call.
        return { content: [{ type: 'text', text: failureText(error) }], isError: true };
      }
    });
  }
  return server;
}

/** `/mcp` for MCP clients: loopback Host and Origin checks as every route, plus the bearer token. */
export function registerMcp(app: FastifyInstance, context: ServiceContext, token: string): void {
  app.post(MCP_PATH, async (request, reply) => {
    if (!authorized(request, token))
      return reply.code(401).send({ error: 'Send the PasCap MCP token as Authorization: Bearer <token>.' });
    const server = mcpServer(context);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => void server.close());
    try {
      // The SDK's own transport type does not satisfy its interface under exactOptionalPropertyTypes.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error(error);
      if (!reply.raw.headersSent)
        reply.raw
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: errorMessage(error) } }));
    }
  });
  // No server-initiated stream and no session to end.
  const unsupported = (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header('Allow', 'POST').send();
  app.get(MCP_PATH, unsupported);
  app.delete(MCP_PATH, unsupported);
}
