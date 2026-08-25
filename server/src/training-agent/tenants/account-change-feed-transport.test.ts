import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

interface McpEnvelope {
  result?: {
    isError?: boolean;
    structuredContent?: Record<string, any>;
  };
}

async function bootServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../index.js');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/training-agent', createTrainingAgentRouter());
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent/sales/mcp`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function callTool(
  baseUrl: string,
  bearer: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<McpEnvelope> {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  };
  await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: id * 100,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'account-change-transport-test', version: '1' },
        capabilities: {},
      },
    }),
  });
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return JSON.parse(await response.text()) as McpEnvelope;
}

describe('v6 /sales/mcp account change cursor recovery', () => {
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeAll(async () => {
    vi.stubEnv('PUBLIC_TEST_AGENT_TOKEN', 'account-change-transport-token');
    server = await bootServer();
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    vi.unstubAllEnvs();
  });

  it('returns CURSOR_EXPIRED over MCP and resumes after snapshot rebootstrap', async () => {
    const bearer = 'account-change-transport-token';
    const account = { account_id: 'acc_luma_shared' };
    const first = (await callTool(server.baseUrl, bearer, 1, 'list_account_changes', {
      adcp_version: '3.2',
      account,
      starting_position: 'latest',
    })).result?.structuredContent;
    expect(first).toMatchObject({ status: 'completed', changes: [], has_more: false });
    expect(first?.cursor).toEqual(expect.stringMatching(/^accchg_/));

    // Exercise the real custom-tool adapter and response envelope. The
    // handler-level suite separately proves authorization-epoch rotation;
    // this probe ensures an unavailable retained checkpoint survives MCP
    // transport as a canonical payload error and can be recovered from.
    const expired = (await callTool(server.baseUrl, bearer, 2, 'list_account_changes', {
      adcp_version: '3.2',
      account,
      cursor: 'accchg_expired_checkpoint',
    })).result?.structuredContent;
    expect(expired).toMatchObject({
      status: 'failed',
      errors: [{
        code: 'CURSOR_EXPIRED',
        recovery: 'correctable',
        details: {
          restart_with: { starting_position: 'latest' },
        },
      }],
    });

    const replacement = (await callTool(server.baseUrl, bearer, 3, 'list_account_changes', {
      adcp_version: '3.2',
      account,
      starting_position: 'latest',
    })).result?.structuredContent;
    expect(replacement?.cursor).toEqual(expect.stringMatching(/^accchg_/));

    const snapshot = (await callTool(server.baseUrl, bearer, 4, 'list_creatives', {
      adcp_version: '3.2',
      account,
      filters: {},
    })).result?.structuredContent;
    expect(snapshot?.creatives).toEqual(expect.any(Array));

    const resumed = (await callTool(server.baseUrl, bearer, 5, 'list_account_changes', {
      adcp_version: '3.2',
      account,
      cursor: replacement?.cursor,
    })).result?.structuredContent;
    expect(resumed).toMatchObject({ status: 'completed', changes: [], has_more: false });
  }, 60_000);
});
