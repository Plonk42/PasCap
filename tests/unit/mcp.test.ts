import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createConfig } from '../../src/server/config.js';
import { toolResult } from '../../src/server/mcp.js';
import { operations } from '../../src/shared/operations/index.js';

const host = '127.0.0.1:4318';
const temporary: string[] = [];
const services: Awaited<ReturnType<typeof createApp>>[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.app.close()));
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pascap-mcp-'));
  temporary.push(dataDir);
  const created = await createApp(
    createConfig({
      dataDir,
      webDir: path.join(dataDir, 'absent-web'),
      ffmpeg: '/unit-tests-do-not-run-ffmpeg',
      ffprobe: '/unit-tests-do-not-run-ffprobe',
    }),
  );
  services.push(created);
  return { ...created, dataDir };
}

/** The official client, its HTTP requests answered in process by the service. */
async function connect(app: Awaited<ReturnType<typeof createApp>>['app'], token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const response = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
        url: new URL(url).pathname,
        headers: { ...headers, host },
        ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
      });
      const replyHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined) replyHeaders.set(name, String(value));
      const empty = response.statusCode === 202 || response.statusCode === 204 || response.statusCode === 405;
      return new Response(empty ? null : response.payload, { status: response.statusCode, headers: replyHeaders });
    },
  });
  const client = new Client({ name: 'pascap-test', version: '1.0.0' });
  clients.push(client);
  // The SDK's own transport type does not satisfy its interface under exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as { type: string; text: string }[];
  expect(first?.type).toBe('text');
  return first!.text;
}

describe('MCP endpoint', () => {
  it('serves the assistant operations to the official client, end to end', async () => {
    const { app, mcpToken } = await service();
    const client = await connect(app, mcpToken);
    expect(client.getServerVersion()?.name).toBe('pascap');
    expect(client.getInstructions()).toMatch(/describe_project/);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      operations.filter((operation) => operation.audience.includes('assistant')).map((operation) => operation.name),
    );
    const edit = tools.find((tool) => tool.name === 'edit')!;
    expect(edit.inputSchema.required).toEqual(['projectId', 'expectedRevision', 'commands']);
    // The SDK's JSON Schema keeps the descriptions nested inside the commands.
    expect(JSON.stringify(edit.inputSchema)).toContain('Project frame without a bookmark.');
    expect(edit.annotations).toEqual({ readOnlyHint: false, openWorldHint: false });
    expect(tools.find((tool) => tool.name === 'still')!.annotations?.readOnlyHint).toBe(true);

    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { host, 'x-pascap-client': 'preview-lab' },
      payload: { title: 'Flight' },
    });
    const projectId = created.json<{ document: { id: string } }>().document.id;
    const described = JSON.parse(text(await client.callTool({ name: 'describe_project', arguments: { projectId } })));
    expect(described).toMatchObject({ id: projectId, revision: 1, bookmarks: [] });

    const edited = await client.callTool({
      name: 'edit',
      arguments: { projectId, expectedRevision: 1, commands: [{ type: 'bookmark-add', frame: 30 }] },
    });
    expect(edited.isError).toBeFalsy();
    expect(JSON.parse(text(edited))).toMatchObject({ revision: 2 });

    // Rejections come back as tool errors the model can read and correct.
    const stale = await client.callTool({
      name: 'edit',
      arguments: { projectId, expectedRevision: 1, commands: [{ type: 'bookmark-add', frame: 60 }] },
    });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toMatch(/revision 2, not 1/);
    const invalid = await client.callTool({ name: 'describe_track', arguments: { projectId } });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toMatch(/layerId/);
    const outside = await client.callTool({ name: 'still', arguments: { projectId, frame: 0 } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toMatch(/outside the project/);
    const unknown = await client.callTool({ name: 'export', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/Tool export not found/);
  });

  it('returns pictures as image content beside their legend', () => {
    const result = toolResult({
      revision: 3,
      image: { mimeType: 'image/jpeg', data: 'AAAA', width: 480, height: 270 },
      legend: [{ cell: 0, frame: 10, timecode: '00:00:10', clipIds: ['a'] }],
    });
    expect(result.content).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      {
        type: 'text',
        text: JSON.stringify({ revision: 3, legend: [{ cell: 0, frame: 10, timecode: '00:00:10', clipIds: ['a'] }] }),
      },
    ]);
  });

  it('keeps one owner-only token and refuses requests without it or from another host', async () => {
    const { app, mcpToken, dataDir } = await service();
    const filename = path.join(dataDir, 'mcp-token');
    expect((await readFile(filename, 'utf8')).trim()).toBe(mcpToken);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    const again = await createApp(
      createConfig({ dataDir, webDir: path.join(dataDir, 'absent-web'), ffmpeg: '/none', ffprobe: '/none' }),
    );
    services.push(again);
    expect(again.mcpToken).toBe(mcpToken);

    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    const post = (headers: Record<string, string>, payload: unknown = ping) =>
      app.inject({ method: 'POST', url: '/mcp', headers: { host, ...headers }, payload: payload as object });
    const bearer = { authorization: `Bearer ${mcpToken}`, accept: 'application/json, text/event-stream' };
    expect((await post({})).statusCode).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await post({ ...bearer, host: 'attacker.example:4318' })).statusCode).toBe(403);
    expect((await post({ ...bearer, origin: 'https://attacker.example' })).statusCode).toBe(403);
    expect((await post(bearer)).json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect((await post({ ...bearer, 'mcp-protocol-version': '2025-06-18' })).statusCode).toBe(200);
    expect((await post({ ...bearer, 'mcp-protocol-version': '2099-01-01' })).statusCode).toBe(400);
    expect((await post(bearer, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    expect((await post(bearer, { jsonrpc: '2.0', id: 2, method: 'resources/list' })).json()).toMatchObject({
      error: { code: -32601 },
    });
    const stream = await app.inject({ method: 'GET', url: '/mcp', headers: { host, ...bearer } });
    expect(stream.statusCode).toBe(405);
  });
});
