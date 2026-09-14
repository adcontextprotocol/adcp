import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION } from '../types.js';

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
  const client = new Client({ name: `account-change-transport-test-${id}`, version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    return { result: CallToolResultSchema.parse(await client.callTool({ name, arguments: args })) };
  } finally {
    await client.close();
  }
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
    const unavailable = (await callTool(server.baseUrl, bearer, 1, 'list_account_changes', {
      adcp_version: '3.1-rc.15',
      account,
      starting_position: 'latest',
    })).result?.structuredContent;
    expect(unavailable).toMatchObject({
      status: 'failed',
      adcp_version: '3.1-rc.15',
      errors: [{ code: 'UNSUPPORTED_FEATURE', field: 'adcp_version' }],
    });

    const first = (await callTool(server.baseUrl, bearer, 2, 'list_account_changes', {
      adcp_version: '3.2-beta.6',
      account,
      starting_position: 'latest',
    })).result?.structuredContent;
    expect(first).toMatchObject({ status: 'completed', changes: [], has_more: false });
    expect(first?.cursor).toEqual(expect.stringMatching(/^accchg_/));

    const rotation = (await callTool(server.baseUrl, bearer, 3, 'comply_test_controller', {
      adcp_version: '3.2-beta.6',
      account: { ...account, sandbox: true },
      scenario: 'expire_account_change_cursor',
    })).result?.structuredContent;
    expect(rotation).toMatchObject({
      status: 'completed',
      success: true,
      current_state: 'authorization_scope_changed',
      account_id: account.account_id,
    });

    // Exercise the real controller bridge, custom-tool adapter, and response
    // envelope so the conformance storyboard's exact expiry flow cannot drift.
    const expired = (await callTool(server.baseUrl, bearer, 4, 'list_account_changes', {
      adcp_version: '3.2-beta.6',
      account,
      cursor: first?.cursor,
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

    const replacement = (await callTool(server.baseUrl, bearer, 5, 'list_account_changes', {
      adcp_version: '3.2-beta.6',
      account,
      starting_position: 'latest',
    })).result?.structuredContent;
    expect(replacement?.cursor).toEqual(expect.stringMatching(/^accchg_/));

    const snapshot = (await callTool(server.baseUrl, bearer, 6, 'list_creatives', {
      adcp_version: '3.2-beta.6',
      account,
      filters: {},
    })).result?.structuredContent;
    expect(snapshot?.creatives).toEqual(expect.any(Array));

    const resumed = (await callTool(server.baseUrl, bearer, 7, 'list_account_changes', {
      adcp_version: '3.2-beta.6',
      account,
      cursor: replacement?.cursor,
    })).result?.structuredContent;
    expect(resumed).toMatchObject({ status: 'completed', changes: [], has_more: false });
  }, 60_000);

  it('repairs the shared creative to the status recorded by a separate controller request', async () => {
    const bearer = 'account-change-transport-token';
    const account = { account_id: 'acc_luma_shared' };
    const adcp_version = TRAINING_AGENT_CURRENT_ADCP_VERSION;
    const creativeId = randomUUID();
    const capabilities = (await callTool(server.baseUrl, bearer, 20, 'get_adcp_capabilities', { adcp_version })).result?.structuredContent;
    expect(capabilities?.account?.change_feed?.supported).toBe(true);
    expect(capabilities?.creative?.has_creative_library).toBe(true);
    const initial = (await callTool(server.baseUrl, bearer, 21, 'list_account_changes', {
      adcp_version, account, starting_position: 'latest',
    })).result?.structuredContent;
    expect(initial?.status, JSON.stringify(initial)).toBe('completed');
    const seed = (await callTool(server.baseUrl, bearer, 22, 'comply_test_controller', {
      adcp_version, account: { ...account, sandbox: true }, scenario: 'seed_creative',
      params: {
        creative_id: creativeId,
        fixture: {
          name: 'Shared account display baseline',
          status: 'approved',
          format_kind: 'image',
          manifest: {
            format_kind: 'image',
            assets: {
              image: {
                asset_type: 'image',
                url: 'https://test-assets.adcontextprotocol.org/acme-outdoor/trail-pro-300x250.png',
                width: 300,
                height: 250,
              },
            },
          },
        },
      },
    })).result?.structuredContent;
    expect(seed?.success).toBe(true);
    const approved = (await callTool(server.baseUrl, bearer, 23, 'list_creatives', {
      adcp_version, account, filters: { creative_ids: [creativeId] },
    })).result?.structuredContent;
    expect(approved?.creatives).toEqual([expect.objectContaining({ creative_id: creativeId, status: 'approved' })]);

    // Each call uses a new HTTP client/request; the controller must update the
    // shared snapshot even after session state has been serialized and read back.
    const update = (await callTool(server.baseUrl, bearer, 24, 'comply_test_controller', {
      adcp_version, account: { ...account, sandbox: true }, scenario: 'force_creative_status',
      params: { creative_id: creativeId, status: 'rejected', rejection_reason: 'Connected platform rejected the creative.' },
    })).result?.structuredContent;
    expect(update).toMatchObject({ success: true, previous_state: 'approved', current_state: 'rejected' });
    const feed = (await callTool(server.baseUrl, bearer, 25, 'list_account_changes', {
      adcp_version, account, cursor: initial?.cursor,
    })).result?.structuredContent;
    expect(feed?.changes).toEqual([
      expect.objectContaining({ action: 'created', resource: expect.objectContaining({ resource_id: creativeId }) }),
      expect.objectContaining({ action: 'status_changed', resource: expect.objectContaining({ resource_id: creativeId }), repair: { task: 'list_creatives' } }),
    ]);
    const repaired = (await callTool(server.baseUrl, bearer, 26, 'list_creatives', {
      adcp_version, account, filters: { creative_ids: [creativeId] },
    })).result?.structuredContent;
    expect(repaired?.creatives).toEqual([expect.objectContaining({ creative_id: creativeId, status: 'rejected' })]);
  }, 60_000);
});
