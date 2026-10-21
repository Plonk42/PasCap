import path from 'node:path';

/** What the Hand off dialog shows about connecting an MCP client. */
export interface AssistantClient {
  /** When an MCP client last called PasCap with the token, ISO time. */
  at: string;
  /** The name the client gave, when it gave one. */
  name: string | null;
}

/** The new protocol revision carries the client's identity in each request's `_meta`. */
const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';

/** The client name an MCP request carries: in `initialize`, or in the 2026 revision's `_meta`. */
export function clientName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { params } = body as { params?: unknown };
  if (typeof params !== 'object' || params === null) return null;
  const { clientInfo, _meta } = params as { clientInfo?: unknown; _meta?: Record<string, unknown> };
  const info = clientInfo ?? _meta?.[CLIENT_INFO_KEY];
  const name = typeof info === 'object' && info !== null ? (info as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
}

/** How to reach the MCP endpoint, and the last client that did since the service started. */
export class AssistantConnection {
  readonly url: string;
  readonly tokenFile: string;
  #last: AssistantClient | null = null;

  constructor(port: number, dataDir: string) {
    this.url = `http://127.0.0.1:${port}/mcp`;
    this.tokenFile = path.join(dataDir, 'mcp-token');
  }

  /** Records an authorised MCP request, keeping the last name a client gave. */
  seen(name: string | null, now = new Date()): void {
    this.#last = { at: now.toISOString(), name: name ?? this.#last?.name ?? null };
  }

  lastClient(): AssistantClient | null {
    return this.#last;
  }
}
