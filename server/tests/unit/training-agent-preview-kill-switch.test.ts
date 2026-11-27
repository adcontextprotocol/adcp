/**
 * #8181: TRAINING_AGENT_DISABLE_ADCP_PREVIEW turns a hosted preview off
 * without a code change. The 3.3 preview retired at 3.3 GA, so the switch has
 * nothing left to disable: a process with it set negotiates exactly as one
 * without it. The retained 3.3-rc.3 checkpoint is a stable-registry exact pin,
 * not the preview, so the switch leaves it served, and the 3.3 surfaces are
 * the stable 3.3 line. The pure-function behavior of the switch, and the
 * preview selection it feeds, are covered in
 * training-agent-preview-version.test.ts.
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
import {
  TRAINING_AGENT_CURRENT_ADCP_VERSION,
  TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION,
  TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS,
} from '../../src/training-agent/types.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';

const RETAINED = TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION;
const CURRENT = TRAINING_AGENT_CURRENT_ADCP_VERSION;

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

  it('leaves the process as it is without the switch: no preview, 3.3 still listed', () => {
    expect(TRAINING_AGENT_HOSTED_PREVIEW).toBeUndefined();
    expect(TRAINING_AGENT_PREVIEW_ADCP_VERSION).toBeUndefined();
    expect(PREVIEW_SCHEMA_BUNDLE).toBeUndefined();
    // The switch does not remove the 3.3 line or its retained checkpoint.
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(version => version.startsWith('3.3'))).toEqual([RETAINED, CURRENT]);
  });

  it.each(['/mcp', '/sales/mcp', '/signals/mcp'])('serves 3.3 and the retained pin on %s as it does without the switch', async route => {
    for (const [args, expected] of [
      [{}, route === '/mcp' ? '3.0' : CURRENT],
      [{ adcp_version: '3.2' }, '3.2'],
      [{ adcp_version: CURRENT }, CURRENT],
      [{ adcp_version: RETAINED }, RETAINED],
    ] as const) {
      const result = (await rpc(route, 'tools/call', { name: 'get_adcp_capabilities', arguments: args })).result?.structuredContent;
      expect(result.adcp_version, `${route} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 300)}`).toBe(expected);
      expect(result.adcp.supported_versions).toEqual(expect.arrayContaining([RETAINED, CURRENT]));
    }
  }, 60_000);

  it('still registers the 3.3 account tool, refusing it below 3.3', async () => {
    const list = await rpc('/sales/mcp', 'tools/list', { _meta: { adcp_version: CURRENT } });
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('request_account');
    const called = await rpc('/sales/mcp', 'tools/call', {
      name: 'request_account',
      arguments: { adcp_version: '3.2', brand: { domain: 'kill-switch.example' }, operator: 'kill-switch.example', idempotency_key: 'preview-kill-switch-request-1' },
    });
    expect(called.result?.structuredContent?.adcp_error?.code, JSON.stringify(called).slice(0, 300)).toBe('UNSUPPORTED_FEATURE');
    expect(called.result?.structuredContent?.request).toBeUndefined();
  }, 60_000);
});
