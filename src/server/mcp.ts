import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { operations } from '../shared/operations/index.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import type { ServiceContext } from './operations/context.js';
import { runOperation } from './operations/index.js';
import { atomicWrite } from './storage.js';

/**
 * A stateless Streamable HTTP MCP endpoint: every request is one JSON-RPC message answered with
 * JSON, no session or event stream. The tools are the operations whose audience includes the
 * assistant, so the registry stays the only place a capability is described.
 */
export const MCP_PATH = '/mcp';
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const INSTRUCTIONS = [
  'PasCap edits drone-flight video projects. Frames are integers at 30000/1001 fps; outputs also give MM:SS:FF timecodes.',
  'Start with describe_project, and read a track with describe_track before grading it.',
  'Change a project only with edit: its commands apply together against the expectedRevision you last read, or not at all, and a rejected command returns its reason.',
  'Look at the result with timeline_sheet or still, and choose footage with recording_sheet.',
].join(' ');

const assistantOperations = operations.filter((operation) => operation.audience.includes('assistant'));

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}
interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

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

export function mcpTools() {
  return assistantOperations.map((operation) => ({
    name: operation.name,
    description: operation.description,
    inputSchema: z.toJSONSchema(operation.input, { io: 'input' }),
    annotations: { readOnlyHint: operation.access === 'read', openWorldHint: false },
  }));
}

/** Pictures become image content beside their legend; everything else is JSON text. */
export function toolResult(output: unknown): ToolResult {
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

async function callTool(context: ServiceContext, params: Record<string, unknown> | undefined): Promise<ToolResult> {
  const name = params?.['name'];
  const operation = assistantOperations.find((candidate) => candidate.name === name);
  if (!operation)
    throw new JsonRpcError(-32602, `Unknown tool ${typeof name === 'string' ? name : JSON.stringify(name)}.`);
  try {
    return toolResult(await runOperation(operation, context, params?.['arguments'] ?? {}));
  } catch (error) {
    // The model reads the service's reason and can correct its call.
    return { content: [{ type: 'text', text: failureText(error) }], isError: true };
  }
}

async function answer(context: ServiceContext, message: JsonRpcRequest): Promise<unknown> {
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.['protocolVersion'];
      const version = MCP_PROTOCOL_VERSIONS.find((supported) => supported === requested) ?? MCP_PROTOCOL_VERSIONS[0];
      return {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pascap', title: 'PasCap', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: mcpTools() };
    case 'tools/call':
      return callTool(context, message.params);
    default:
      throw new JsonRpcError(-32601, `Method ${message.method} is not supported.`);
  }
}

function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (message as { method?: unknown }).method === 'string'
  );
}

/** `/mcp` for MCP clients: loopback Host and Origin checks as every route, plus the bearer token. */
export function registerMcp(app: FastifyInstance, context: ServiceContext, token: string): void {
  app.post(MCP_PATH, async (request, reply) => {
    if (!authorized(request, token))
      return reply.code(401).send({ error: 'Send the PasCap MCP token as Authorization: Bearer <token>.' });
    const version = request.headers['mcp-protocol-version'];
    if (
      version !== undefined &&
      !(typeof version === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version))
    )
      return reply.code(400).send({ error: `Unsupported MCP protocol version ${String(version)}.` });
    const message: unknown = request.body;
    if (!isRequest(message))
      return reply
        .code(400)
        .send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one JSON-RPC 2.0 message.' } });
    // Notifications and responses need no answer.
    if (!('id' in message) || message.id === null) return reply.code(202).send();
    try {
      return { jsonrpc: '2.0', id: message.id, result: await answer(context, message) };
    } catch (error) {
      const code = error instanceof JsonRpcError ? error.code : -32603;
      return { jsonrpc: '2.0', id: message.id, error: { code, message: errorMessage(error) } };
    }
  });
  // No server-initiated stream and no session to end.
  const unsupported = (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header('Allow', 'POST').send();
  app.get(MCP_PATH, unsupported);
  app.delete(MCP_PATH, unsupported);
}
