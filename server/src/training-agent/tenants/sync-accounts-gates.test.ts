/**
 * Integration test: BILLING_NOT_PERMITTED_FOR_AGENT + BILLING_NOT_SUPPORTED
 * gates fire on the v6 per-tenant `/api/training-agent/sales/mcp` route,
 * matching the legacy `/mcp` route semantics from PR #3851.
 *
 * Validates the wire path the in-process unit tests don't cover: bearer
 * → principal → ResolveContext → accounts.upsert → handleSyncAccounts.
 * The test boots the real tenant router (StreamableHTTPServerTransport
 * + bearer auth + framework dispatch) so a regression in any of those
 * layers surfaces here.
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

interface McpResultEnvelope {
  result?: {
    structuredContent?: {
      accounts?: Array<{
        action?: string;
        status?: string;
        billing?: string;
        errors?: Array<{
          code: string;
          message?: string;
          recovery?: string;
          details?: Record<string, unknown>;
        }>;
      }>;
    };
  };
}

async function callSyncAccounts(
  baseUrl: string,
  tenantId: string,
  bearer: string,
  args: Record<string, unknown>,
  id: number,
): Promise<McpResultEnvelope> {
  const url = `${baseUrl}/${tenantId}/mcp`;
  const headers = {
    'content-type': 'application/json',
    // Drop `text/event-stream` from Accept to pin the response format.
    // The tenant router sets `enableJsonResponse: true` on the transport;
    // with this Accept header the framework returns plain JSON, not SSE.
    // Pinning keeps the response-parser one-shape and surfaces a
    // regression if the framework ever switches default formats.
    accept: 'application/json',
    authorization: `Bearer ${bearer}`,
  };
  // Initialize once per call (transport is per-request — sessionIdGenerator: undefined).
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: id * 100, method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
    }),
  });
  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'sync_accounts', arguments: args },
    }),
  });
  return JSON.parse(await r.text()) as McpResultEnvelope;
}

describe('v6 /sales/mcp sync_accounts billing gates', () => {
  it('passthrough-only bearer + billing: agent → BILLING_NOT_PERMITTED_FOR_AGENT', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-passthrough-v1', {
        accounts: [{
          brand: { domain: 'acmeoutdoor.example' },
          operator: 'pinnacle-agency.example',
          billing: 'agent',
        }],
        idempotency_key: 'v6-gate-passthrough-1',
      }, 1);
      const acct = env.result?.structuredContent?.accounts?.[0];
      expect(acct?.action).toBe('failed');
      expect(acct?.status).toBe('rejected');
      const err = acct?.errors?.[0];
      expect(err?.code).toBe('BILLING_NOT_PERMITTED_FOR_AGENT');
      expect(err?.recovery).toBe('correctable');
      expect(err?.details).toEqual({
        rejected_billing: 'agent',
        suggested_billing: 'operator',
      });
    } finally {
      await close();
    }
  }, 20000);

  it('passthrough-only bearer + billing: operator → success (autonomous recovery)', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-passthrough-v1', {
        accounts: [{
          brand: { domain: 'acmeoutdoor.example' },
          operator: 'pinnacle-agency.example',
          billing: 'operator',
          sandbox: true,
        }],
        idempotency_key: 'v6-gate-passthrough-recover-1',
      }, 2);
      const acct = env.result?.structuredContent?.accounts?.[0];
      expect(acct?.status).toBe('active');
      expect(acct?.billing).toBe('operator');
      expect(acct?.errors).toBeUndefined();
    } finally {
      await close();
    }
  }, 20000);

  it('agent-billable bearer + billing: agent → success (no per-agent gate)', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-agent-billable-v1', {
        accounts: [{
          brand: { domain: 'billable.example' },
          operator: 'pinnacle-agency.example',
          billing: 'agent',
          sandbox: true,
        }],
        idempotency_key: 'v6-gate-agent-billable-1',
      }, 3);
      const acct = env.result?.structuredContent?.accounts?.[0];
      expect(acct?.status).toBe('active');
      expect(acct?.billing).toBe('agent');
    } finally {
      await close();
    }
  }, 20000);

  // Per-tenant smoke — confirms the upsert wiring is symmetric across all
  // six v6 platforms. sync_accounts is shared infrastructure surfaced on
  // every tenant route per the spec ("supported_protocols is not
  // exhaustive — accounts surface is implicit in every protocol agent").
  it.each([
    'sales',
    'signals',
    'governance',
    'creative',
    'creative-builder',
    'brand',
  ])('per-agent gate fires on /%s/mcp (passthrough rejection)', async (tenantId) => {
    const { baseUrl, close } = await bootServer();
    try {
      const env = await callSyncAccounts(baseUrl, tenantId, 'demo-billing-passthrough-v1', {
        accounts: [{
          brand: { domain: `${tenantId}.example` },
          operator: 'pinnacle-agency.example',
          billing: 'agent',
        }],
        idempotency_key: `v6-${tenantId}-passthrough`,
      }, 100);
      const acct = env.result?.structuredContent?.accounts?.[0];
      expect(acct?.action).toBe('failed');
      expect(acct?.errors?.[0]?.code).toBe('BILLING_NOT_PERMITTED_FOR_AGENT');
    } finally {
      await close();
    }
  }, 20000);

  it('unrecognized bearer (test-token) + billing: agent → success (uniform-response rule)', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const env = await callSyncAccounts(baseUrl, 'sales', 'test-token', {
        accounts: [{
          brand: { domain: 'anon.example' },
          operator: 'pinnacle-agency.example',
          billing: 'agent',
          sandbox: true,
        }],
        idempotency_key: 'v6-gate-unrecognized-1',
      }, 4);
      const acct = env.result?.structuredContent?.accounts?.[0];
      // No principal → no per-agent gate. Capability gate accepts agent
      // (training-agent advertises all three values), so account provisions.
      expect(acct?.status).toBe('active');
      expect(acct?.billing).toBe('agent');
    } finally {
      await close();
    }
  }, 20000);
});
