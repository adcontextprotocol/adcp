/**
 * Unit + integration tests for `runStoryboardViaConformanceSocket`.
 *
 * The architecture-correctness test (real WebSocket, full MCP round-trip)
 * lives in `conformance-end-to-end.test.ts`. This file focuses on the
 * adapter logic: session lookup, storyboard lookup, AgentClient wrapping,
 * and error paths. We mock `runStoryboard` from `@adcp/sdk/testing` so
 * we don't need a real sales agent + test kits to exercise the adapter.
 */

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
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

process.env.CONFORMANCE_JWT_SECRET = 'test-runs-storyboard-secret';
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';

const runStoryboardMock = vi.fn();
vi.mock('@adcp/sdk/testing', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/sdk/testing');
  return {
    ...actual,
    runStoryboard: (...args: unknown[]) => runStoryboardMock(...args),
  };
});

const getStoryboardMock = vi.fn();
vi.mock('../../src/services/storyboards.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/services/storyboards.js');
  return {
    ...actual,
    getStoryboard: (id: string) => getStoryboardMock(id),
  };
});

class AdopterTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (msg: JSONRPCMessage) => void;
  sessionId?: string;
  private closed = false;

  constructor(private socket: WebSocket) {}

  async start(): Promise<void> {
    this.socket.on('message', (data) => {
      try {
        const result = JSONRPCMessageSchema.safeParse(JSON.parse(data.toString('utf-8')));
        if (result.success) this.onmessage?.(result.data);
      } catch {
        // ignore
      }
    });
    this.socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
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
    this.socket.close();
  }
}

let httpServer: HttpServer;
let port: number;

beforeAll(async () => {
  const { attachConformanceWS } = await import('../../src/conformance/ws-route.js');
  httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  attachConformanceWS(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  const { conformanceSessions } = await import('../../src/conformance/session-store.js');
  await conformanceSessions.closeAll();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(async () => {
  runStoryboardMock.mockReset();
  getStoryboardMock.mockReset();
  const { conformanceSessions } = await import('../../src/conformance/session-store.js');
  await conformanceSessions.closeAll();
});

describe('runStoryboardViaConformanceSocket', () => {
  it('throws ConformanceNotConnectedError when the org has no live session', async () => {
    const { runStoryboardViaConformanceSocket, ConformanceNotConnectedError } = await import(
      '../../src/conformance/run-storyboard-via-ws.js'
    );
    await expect(
      runStoryboardViaConformanceSocket('org_missing', 'any_storyboard'),
    ).rejects.toBeInstanceOf(ConformanceNotConnectedError);
    expect(runStoryboardMock).not.toHaveBeenCalled();
  });

  it('throws StoryboardNotFoundError when the storyboard id is unknown', async () => {
    const { issueConformanceToken } = await import('../../src/conformance/token.js');
    const { conformanceSessions } = await import('../../src/conformance/session-store.js');
    const { runStoryboardViaConformanceSocket, StoryboardNotFoundError } = await import(
      '../../src/conformance/run-storyboard-via-ws.js'
    );

    const orgId = 'org_with_session';
    const { token } = issueConformanceToken(orgId);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/conformance/connect?token=${encodeURIComponent(token)}`,
    );
    const adopterServer = new McpServer(
      { name: 'adopter', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    adopterServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    adopterServer.setRequestHandler(CallToolRequestSchema, async () => {
      throw new Error('not implemented in test');
    });
    const transport = new AdopterTransport(ws);
    await adopterServer.connect(transport);

    // wait for session to register
    const deadline = Date.now() + 2000;
    while (!conformanceSessions.get(orgId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    getStoryboardMock.mockReturnValue(undefined);

    await expect(
      runStoryboardViaConformanceSocket(orgId, 'definitely_not_a_real_storyboard'),
    ).rejects.toBeInstanceOf(StoryboardNotFoundError);
    expect(runStoryboardMock).not.toHaveBeenCalled();

    await transport.close();
  });

  it('wraps the session MCP client as an AgentClient and dispatches via runStoryboard', async () => {
    const { issueConformanceToken } = await import('../../src/conformance/token.js');
    const { conformanceSessions } = await import('../../src/conformance/session-store.js');
    const { runStoryboardViaConformanceSocket } = await import(
      '../../src/conformance/run-storyboard-via-ws.js'
    );

    const orgId = 'org_runs_storyboard';
    const { token } = issueConformanceToken(orgId);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/conformance/connect?token=${encodeURIComponent(token)}`,
    );
    const adopterServer = new McpServer(
      { name: 'adopter', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    adopterServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    adopterServer.setRequestHandler(CallToolRequestSchema, async () => {
      throw new Error('not implemented in test');
    });
    const transport = new AdopterTransport(ws);
    await adopterServer.connect(transport);

    const deadline = Date.now() + 2000;
    while (!conformanceSessions.get(orgId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const fakeStoryboard = { id: 'fake_storyboard', phases: [] } as unknown as Parameters<
      typeof getStoryboardMock
    >[0];
    getStoryboardMock.mockReturnValue(fakeStoryboard);
    runStoryboardMock.mockResolvedValue({
      storyboard_id: 'fake_storyboard',
      overall_passed: true,
    });

    const result = await runStoryboardViaConformanceSocket(orgId, 'fake_storyboard', {
      timeoutMs: 12_345,
      testSessionId: 'test-fixed-id',
    });
    expect(result.overall_passed).toBe(true);

    expect(runStoryboardMock).toHaveBeenCalledTimes(1);
    const [agentUrlArg, storyboardArg, optionsArg] = runStoryboardMock.mock.calls[0];
    expect(agentUrlArg).toBe(`adcp-conformance-socket://${orgId}`);
    expect(storyboardArg).toBe(fakeStoryboard);
    expect(optionsArg.test_session_id).toBe('test-fixed-id');
    expect(optionsArg.timeout_ms).toBe(12_345);
    expect(optionsArg._client).toBeTruthy();
    // Sanity check — `_client` should expose the AgentClient surface
    expect(typeof optionsArg._client.getAdcpVersion).toBe('function');

    await transport.close();
  });
});
