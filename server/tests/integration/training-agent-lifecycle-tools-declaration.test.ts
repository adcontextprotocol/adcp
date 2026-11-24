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
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
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

async function capabilities(url: string, args: Record<string, unknown>): Promise<any> {
  await initialize(url);
  const res = await rpc(url, {
    id: 3, method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: args },
  });
  return res.result?.structuredContent;
}

async function lifecycleToolsDeclared(url: string, version: string): Promise<string[] | undefined> {
  const structured = await capabilities(url, { adcp_version: version, adcp_major_version: 3 });
  expect(structured?.adcp_version, `${url} @ ${version}`).toBe(version);
  const media = structured?.media_buy;
  // proposal_refinement describes refine_proposals, so the schema requires it declared.
  if (media?.proposal_refinement !== undefined) expect(media.lifecycle_tools).toContain('refine_proposals');
  return media?.lifecycle_tools;
}

describe('media_buy.lifecycle_tools matches the served tools (#8981)', () => {
  let server: http.Server;
  let baseUrl: string;
  let compatServer: http.Server;
  let compatBaseUrl: string;

  async function boot(router: express.Router): Promise<{ server: http.Server; baseUrl: string }> {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', router);
    const listening = http.createServer(app);
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', () => resolve()));
    return { server: listening, baseUrl: `http://127.0.0.1:${(listening.address() as AddressInfo).port}` };
  }

  beforeAll(async () => {
    ({ server, baseUrl } = await boot(createTrainingAgentRouter()));
    ({ server: compatServer, baseUrl: compatBaseUrl } = await boot(
      createTrainingAgentRouter({ storyboardCompat: { version: '3.0' } }),
    ));
  }, 60_000);

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => compatServer.close(() => resolve()));
  });

  // Under the 3.0 compat router tools/list hides the proposal tools but keeps
  // buy_products, accept_proposal and control_media_buy, while a 3.2+ pin (or
  // a bare major) still resolves above 3.0. The declaration must follow the
  // hidden tools and stay schema-valid (proposal_refinement needs
  // refine_proposals).
  describe('legacy /mcp under the 3.0 storyboard-compat router', () => {
    const CASES: Array<[string, Record<string, unknown>]> = [
      ['adcp_major_version only', { adcp_major_version: 3 }],
      ['adcp_version 3.2', { adcp_version: '3.2', adcp_major_version: 3 }],
      ['adcp_version 3.2-rc.7', { adcp_version: '3.2-rc.7', adcp_major_version: 3 }],
      ...(PREVIEW ? [[`preview pin ${PREVIEW}`, { adcp_version: PREVIEW, adcp_major_version: 3 }] as [string, Record<string, unknown>]] : []),
    ];

    it.each(CASES)('declares only served tools and a schema-valid response: %s', async (_label, args) => {
      const url = `${compatBaseUrl}/api/training-agent/mcp`;
      const served = await listToolNames(url);
      // The compat context really hides the proposal tools but keeps the compact ones.
      expect(served).not.toContain('refine_proposals');
      expect(served).toEqual(expect.arrayContaining(['buy_products', 'accept_proposal', 'control_media_buy']));

      const structured = await capabilities(url, args);
      const resolved = structured?.adcp_version as string;
      // (a) the request resolves to 3.2 or later, where lifecycle_tools exists.
      expect(resolved).toMatch(/^3\.([2-9]|\d{2,})/);

      // (b) lifecycle_tools is the served subset of the resolved release's enum.
      const vocabulary = servedReleaseEnum(CAPABILITIES, resolved, LIFECYCLE_ITEMS)!;
      expect(vocabulary).not.toBeNull();
      const expected = served.filter(name => vocabulary.has(name));
      expect(expected.length).toBeGreaterThan(0);
      const media = structured.media_buy;
      expect([...(media.lifecycle_tools ?? [])].sort()).toEqual([...expected].sort());

      // (c) proposal_refinement only accompanies a refine_proposals declaration.
      expect(media.lifecycle_tools).not.toContain('refine_proposals');
      expect(media.proposal_refinement).toBeUndefined();

      // (d) the whole response validates against the resolved release's bundle.
      const validate = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: resolved });
      expect(validate, `no validator for ${resolved}`).toBeTruthy();
      validate!(structured);
      expect(validate!.errors ?? []).toEqual([]);
    });
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
