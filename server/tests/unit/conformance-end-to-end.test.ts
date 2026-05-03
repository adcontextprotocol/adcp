/**
 * End-to-end smoke test for the Addie Socket Mode channel.
 *
 * Spins up:
 *   - a real http.Server with the conformance WS upgrade attached
 *   - a real adopter-side MCP server with one fake tool, connected
 *     outbound via a real `ws` client through a tiny in-test
 *     `Transport` adapter (mirror of the adopter library's transport)
 *
 * Asserts:
 *   - the session registers in `conformanceSessions`
 *   - Addie's MCP `Client` (the one held by the session) successfully
 *     calls `tools/list` and `tools/call` against the adopter's server
 *
 * This is the load-bearing "the architecture works" gate. It does not
 * exercise the storyboard runner — that's PR #2.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import WebSocket from 'ws';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { attachConformanceWS } from '../../src/conformance/ws-route.js';
import { conformanceSessions } from '../../src/conformance/session-store.js';
import { issueConformanceToken } from '../../src/conformance/token.js';

process.env.CONFORMANCE_JWT_SECRET = 'test-e2e-conformance-secret';
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

class AdopterWSTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (msg: JSONRPCMessage) => void;
  sessionId?: string;
  private closed = false;

  constructor(private readonly socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.on('message', (data) => {
      const text = data.toString('utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        this.onerror?.(err as Error);
        return;
      }
      const result = JSONRPCMessageSchema.safeParse(parsed);
      if (!result.success) {
        this.onerror?.(new Error(result.error.message));
        return;
      }
      this.onmessage?.(result.data);
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
    this.socket.on('error', (err) => this.onerror?.(err));
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.socket.once('open', () => resolve());
        this.socket.once('error', reject);
      });
    }
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(msg), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(1000, 'adopter close');
  }
}

let httpServer: HttpServer;
let port: number;

beforeAll(async () => {
  httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachConformanceWS(httpServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  if (typeof addr === 'object' && addr) {
    port = addr.port;
  } else {
    throw new Error('failed to bind test http server');
  }
});

afterAll(async () => {
  await conformanceSessions.closeAll();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(async () => {
  await conformanceSessions.closeAll();
});

function buildAdopterServer(): McpServer {
  const server = new McpServer(
    { name: 'fake-adopter', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ping',
        description: 'health check',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'ping') {
      return { content: [{ type: 'text' as const, text: 'pong' }] };
    }
    throw new Error(`unknown tool ${req.params.name}`);
  });
  return server;
}

async function waitForSession(orgId: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conformanceSessions.get(orgId)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`session for ${orgId} never registered`);
}

describe('conformance Socket Mode end-to-end', () => {
  it('rejects upgrade with 401 when token is missing', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/conformance/connect`);
    const status = await new Promise<number | undefined>((resolve) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    });
    expect(status).toBe(401);
  });

  it('rejects upgrade when token signature is wrong', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/conformance/connect?token=bogus.token.value`,
    );
    const status = await new Promise<number | undefined>((resolve) => {
      ws.once('error', () => resolve(undefined));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    });
    expect(status).toBe(401);
  });

  it('connects, registers a session, and serves tools/list + tools/call to Addie', async () => {
    const orgId = 'org_e2e';
    const { token } = issueConformanceToken(orgId);
    const wsUrl = `ws://127.0.0.1:${port}/conformance/connect?token=${encodeURIComponent(token)}`;

    const adopterServer = buildAdopterServer();
    const ws = new WebSocket(wsUrl);
    const adopterTransport = new AdopterWSTransport(ws);
    await adopterServer.connect(adopterTransport);

    await waitForSession(orgId);
    const session = conformanceSessions.get(orgId);
    expect(session).toBeTruthy();
    expect(session?.orgId).toBe(orgId);

    const listed = await session!.mcpClient.listTools();
    expect(listed.tools.map((t) => t.name)).toEqual(['ping']);

    const called = await session!.mcpClient.callTool({ name: 'ping', arguments: {} });
    const content = (called.content as Array<{ type: string; text: string }>) ?? [];
    expect(content[0]?.text).toBe('pong');

    await adopterTransport.close();
    ws.close();
  });

  it('evicts the session when the adopter disconnects', async () => {
    const orgId = 'org_evict';
    const { token } = issueConformanceToken(orgId);
    const wsUrl = `ws://127.0.0.1:${port}/conformance/connect?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    const adopterTransport = new AdopterWSTransport(ws);
    const adopterServer = buildAdopterServer();
    await adopterServer.connect(adopterTransport);

    await waitForSession(orgId);
    expect(conformanceSessions.get(orgId)).toBeTruthy();

    await adopterTransport.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(conformanceSessions.get(orgId)).toBeUndefined();
  });
});
