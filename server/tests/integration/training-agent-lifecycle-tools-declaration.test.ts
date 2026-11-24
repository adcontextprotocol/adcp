/**
 * adcp#8981: `media_buy.lifecycle_tools` must declare every compact lifecycle
 * tool the route serves. The expected value is derived from each route's own
 * tools/list (filtered to the lifecycle vocabulary), so adding or removing a
 * served lifecycle tool without updating the declaration fails here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { TRAINING_AGENT_PREVIEW_ADCP_VERSION } from '../../src/training-agent/candidate-version.js';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'lifecycle-tools-token';
  process.env.NODE_ENV = 'test';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { servedReleaseEnum } = await import('../../src/training-agent/served-release-fields.js');

const AUTH = 'Bearer lifecycle-tools-token';
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: AUTH,
};
const CAPABILITIES = 'protocol/get-adcp-capabilities-response.json';
const LIFECYCLE_ITEMS = '/properties/media_buy/properties/lifecycle_tools/items';

const PREVIEW = TRAINING_AGENT_PREVIEW_ADCP_VERSION;
const VERSIONS = ['3.2', ...(PREVIEW ? [PREVIEW] : [])];

// Routes serving the compact lifecycle tools, and routes that serve none.
const SERVING_ROUTES = [
  { name: 'legacy /mcp', path: '/api/training-agent/mcp' },
  { name: '/sales', path: '/api/training-agent/sales/mcp' },
];
const NON_SERVING_ROUTES = [
  { name: '/inventory-adserver', path: '/api/training-agent/inventory-adserver/mcp' },
  { name: '/inventory-content', path: '/api/training-agent/inventory-content/mcp' },
  { name: '/signals', path: '/api/training-agent/signals/mcp' },
];

async function rpc(url: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
  const text = await res.text();
  // Streamable HTTP may answer as a single SSE event.
  const data = text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? '{}';
  return JSON.parse(data);
}

async function initialize(url: string): Promise<void> {
  await rpc(url, {
    id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', clientInfo: { name: 'lifecycle', version: '1' }, capabilities: {} },
  });
}

async function listToolNames(url: string, version?: string): Promise<string[]> {
  await initialize(url);
  const res = await rpc(url, {
    id: 2, method: 'tools/list',
    params: version ? { adcp_version: version, _meta: { adcp_version: version } } : {},
  });
  return (res.result?.tools ?? []).map((tool: { name: string }) => tool.name);
}

async function lifecycleToolsDeclared(url: string, version: string): Promise<string[] | undefined> {
  await initialize(url);
  const res = await rpc(url, {
    id: 3, method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: { adcp_version: version, adcp_major_version: 3 } },
  });
  const media = res.result?.structuredContent?.media_buy;
  expect(res.result?.structuredContent?.adcp_version, `${url} @ ${version}`).toBe(version);
  return media?.lifecycle_tools;
}

describe('media_buy.lifecycle_tools matches the served tools (#8981)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  describe.each(SERVING_ROUTES)('$name', ({ path }) => {
    it.each(VERSIONS)('declares exactly the lifecycle tools tools/list serves at %s', async version => {
      const url = `${baseUrl}${path}`;
      const vocabulary = servedReleaseEnum(CAPABILITIES, version, LIFECYCLE_ITEMS);
      expect(vocabulary).not.toBeNull();
      const served = await listToolNames(url, version);
      const expected = served.filter(name => vocabulary!.has(name));
      // Guard against a vacuous pass: the compact tools are listed here.
      expect(expected).toEqual(expect.arrayContaining(['buy_products', 'accept_proposal', 'control_media_buy']));

      const declared = await lifecycleToolsDeclared(url, version);
      expect(declared).toBeDefined();
      expect([...declared!].sort()).toEqual([...expected].sort());
      // No lifecycle tool is declared that the route does not serve.
      for (const tool of declared!) expect(served).toContain(tool);
    });

    it('omits the field at 3.1, before it existed', async () => {
      expect(await lifecycleToolsDeclared(`${baseUrl}${path}`, '3.1')).toBeUndefined();
    });
  });

  describe.each(NON_SERVING_ROUTES)('$name', ({ path }) => {
    it.each(VERSIONS)('declares no lifecycle tools at %s', async version => {
      const url = `${baseUrl}${path}`;
      const served = await listToolNames(url);
      const vocabulary = servedReleaseEnum(CAPABILITIES, version, LIFECYCLE_ITEMS)!;
      expect(served.filter(name => vocabulary.has(name))).toEqual([]);
      expect(await lifecycleToolsDeclared(url, version)).toBeUndefined();
    });
  });
});
