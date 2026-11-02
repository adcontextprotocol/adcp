/**
 * #8181: TRAINING_AGENT_DISABLE_ADCP_PREVIEW turns the hosted 3.3 preview off
 * without a code change. The process then negotiates exactly as one that
 * never listed the preview: nothing advertises it, an exact pin is refused on
 * the v5 route and served the stable release on SDK tenant routes (as before
 * the preview existed), and the experimental tools are not registered.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

vi.hoisted(() => {
  process.env.TRAINING_AGENT_DISABLE_ADCP_PREVIEW = '1';
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'preview-kill-switch-token';
});

import { TRAINING_AGENT_HOSTED_PREVIEW, TRAINING_AGENT_PREVIEW_ADCP_VERSION } from '../../src/training-agent/candidate-version.js';
import { PREVIEW_SCHEMA_BUNDLE } from '../../src/training-agent/schema-compat.js';
import { TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS } from '../../src/training-agent/types.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';

const PREVIEW = TRAINING_AGENT_HOSTED_PREVIEW.wireVersion;

describe('hosted 3.3 preview kill switch', () => {
  let server: http.Server;
  let baseUrl: string;
  let rpcId = 0;

  const rpc = async (path: string, method: string, params?: Record<string, unknown>) => {
    rpcId += 1;
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer preview-kill-switch-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params && { params }) }),
    });
    return response.json() as Promise<Record<string, any>>;
  };

  beforeAll(async () => {
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ verify: (req, _res, body) => {
      (req as unknown as { rawBody: string }).rawBody = body.toString('utf8');
    } }));
    app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}/api/training-agent`;
  }, 60_000);

  afterAll(async () => {
    stopSessionCleanup();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('removes the preview from the process', () => {
    expect(TRAINING_AGENT_PREVIEW_ADCP_VERSION).toBeUndefined();
    expect(PREVIEW_SCHEMA_BUNDLE).toBeUndefined();
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.some(version => version.startsWith('3.3'))).toBe(false);
  });

  it.each(['/mcp', '/sales/mcp', '/signals/mcp'])('neither advertises nor serves the preview on %s', async route => {
    for (const args of [{}, { adcp_version: '3.2' }]) {
      const result = (await rpc(route, 'tools/call', { name: 'get_adcp_capabilities', arguments: args })).result?.structuredContent;
      expect(result.adcp.supported_versions).not.toContain(PREVIEW);
      expect(result.experimental_features ?? []).not.toContain('account.requests');
    }
    const pinned = (await rpc(route, 'tools/call', { name: 'get_adcp_capabilities', arguments: { adcp_version: PREVIEW } })).result?.structuredContent;
    if (route === '/mcp') {
      expect(pinned.adcp_error?.code, JSON.stringify(pinned).slice(0, 300)).toBe('VERSION_UNSUPPORTED');
      expect(pinned.adcp_error.details.supported_versions).not.toContain(PREVIEW);
    } else {
      expect(pinned.adcp_version, JSON.stringify(pinned).slice(0, 300)).toBe('3.2');
      expect(pinned.experimental_features ?? []).not.toContain('account.requests');
      // Nor the experimental holds (holds/service.ts).
      expect((pinned.experimental_features ?? []).filter((feature: string) => feature.includes('hold'))).toEqual([]);
      expect(pinned.media_buy?.proposal_refinement?.hold_extension).toBeUndefined();
    }
  }, 60_000);

  it('does not register the experimental account tool', async () => {
    const list = await rpc('/sales/mcp', 'tools/list', { _meta: { adcp_version: PREVIEW } });
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('request_account');
    const called = await rpc('/sales/mcp', 'tools/call', {
      name: 'request_account',
      arguments: { adcp_version: PREVIEW, brand: { domain: 'kill-switch.example' }, operator: 'kill-switch.example', idempotency_key: 'preview-kill-switch-request-1' },
    });
    expect(called.result?.isError).toBe(true);
    expect(called.result?.structuredContent?.request).toBeUndefined();
  }, 60_000);
});
