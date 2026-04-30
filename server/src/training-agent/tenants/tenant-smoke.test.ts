/**
 * Smoke test: tenant routes mount, /signals/mcp dispatches, brand.json
 * exposes the tenant key.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

async function bootServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter());
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

describe('tenant routing smoke', () => {
  it('serves brand.json with tenant public keys', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      // Trigger registry init by hitting MCP first (lazy build).
      const initR = await fetch(`${baseUrl}/signals/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'x', version: '1' },
            capabilities: {},
          },
        }),
      });
      // eslint-disable-next-line no-console
      console.log('init status:', initR.status, 'body[:200]:', (await initR.text()).slice(0, 300));
      const r = await fetch(`${baseUrl}/.well-known/brand.json`);
      expect(r.status).toBe(200);
      const body = await r.json() as { jwks: { keys: Array<{ kid: string; alg: string }> } };
      expect(Array.isArray(body.jwks?.keys)).toBe(true);
      expect(body.jwks.keys.length).toBeGreaterThan(0);
      const signalsKid = body.jwks.keys.find(k => k.kid?.includes('signals'));
      expect(signalsKid).toBeDefined();
      // eslint-disable-next-line no-console
      console.log('brand.json keys:', body.jwks.keys.map(k => ({ kid: k.kid, alg: k.alg })));
    } finally {
      await close();
    }
  }, 15000);

  it('dispatches /signals/mcp tools/list and returns only signals-tenant tools', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/signals/mcp`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
        }),
      });
      const list = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const body = await list.json() as { result?: { tools?: Array<{ name: string }> } };
      const toolNames = (body.result?.tools ?? []).map(t => t.name).sort();
      // eslint-disable-next-line no-console
      console.log('/signals tools:', toolNames);
      expect(toolNames).toContain('get_signals');
      expect(toolNames).toContain('activate_signal');
      // Tenant should NOT expose mediaBuy / governance tools
      expect(toolNames).not.toContain('create_media_buy');
      expect(toolNames).not.toContain('sync_plans');
    } finally {
      await close();
    }
  }, 15000);
});
