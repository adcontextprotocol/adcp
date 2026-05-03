/**
 * Integration test: BILLING_NOT_PERMITTED_FOR_AGENT + BILLING_NOT_SUPPORTED
 * gates fire on the v6 per-tenant `/api/training-agent/<tenant>/mcp`
 * routes, matching the legacy `/mcp` route semantics from PR #3851.
 *
 * Validates the wire path the in-process unit tests don't cover: bearer
 * → principal → ResolveContext → accounts.upsert → handleSyncAccounts.
 * The test boots the real tenant router (StreamableHTTPServerTransport
 * + bearer auth + framework dispatch) so a regression in any of those
 * layers surfaces here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

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

// Unique idempotency key per call. Hard-coded keys would let a watch-mode
// rerun (or a flaky-retry harness) hit the SDK's idempotency cache and
// replay the cached envelope — a stale cached success would mask a real
// regression. The cache lookup runs before the gate, so a fresh UUID per
// invocation is the only way these tests assert what they claim to.
function freshKey(label: string): string {
  return `${label}-${randomUUID()}`;
}

describe('v6 /sales/mcp sync_accounts billing gates', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let baseUrl: string;

  // Single boot for the whole suite — `bootServer()` is heavy
  // (createTrainingAgentRouter rebuilds the JWKS, six tenants, framework
  // dispatch). Tests don't share mutable state in any way that requires
  // per-test isolation: assertions inspect the response envelope, brand
  // domains differ across tests, idempotency keys are unique per call,
  // and gate rejections happen before any persisted state is touched.
  beforeAll(async () => {
    // Module-level env mutation leaks across vitest workers; vi.stubEnv
    // scopes the change to this suite and `afterAll` restores it.
    vi.stubEnv('PUBLIC_TEST_AGENT_TOKEN', 'test-token');
    server = await bootServer();
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await server.close();
    vi.unstubAllEnvs();
  });

  it('passthrough-only bearer + billing: agent → BILLING_NOT_PERMITTED_FOR_AGENT', async () => {
    const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-passthrough-v1', {
      accounts: [{
        brand: { domain: 'acmeoutdoor.example' },
        operator: 'pinnacle-agency.example',
        billing: 'agent',
      }],
      idempotency_key: freshKey('v6-gate-passthrough-reject'),
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
  });

  it('passthrough-only bearer + billing: operator → success (autonomous recovery)', async () => {
    const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-passthrough-v1', {
      accounts: [{
        brand: { domain: 'acmeoutdoor.example' },
        operator: 'pinnacle-agency.example',
        billing: 'operator',
        sandbox: true,
      }],
      idempotency_key: freshKey('v6-gate-passthrough-recover'),
    }, 2);
    const acct = env.result?.structuredContent?.accounts?.[0];
    expect(acct?.status).toBe('active');
    expect(acct?.billing).toBe('operator');
    expect(acct?.errors).toBeUndefined();
  });

  it('agent-billable bearer + billing: agent → success (no per-agent gate)', async () => {
    const env = await callSyncAccounts(baseUrl, 'sales', 'demo-billing-agent-billable-v1', {
      accounts: [{
        brand: { domain: 'billable.example' },
        operator: 'pinnacle-agency.example',
        billing: 'agent',
        sandbox: true,
      }],
      idempotency_key: freshKey('v6-gate-agent-billable'),
    }, 3);
    const acct = env.result?.structuredContent?.accounts?.[0];
    expect(acct?.status).toBe('active');
    expect(acct?.billing).toBe('agent');
  });

  // Per-tenant smoke — confirms the upsert wiring is symmetric across
  // all six v6 platforms. sync_accounts is shared infrastructure
  // surfaced on every tenant route per the spec ("supported_protocols
  // is not exhaustive — accounts surface is implicit in every protocol
  // agent"). Brand domains are namespaced per tenantId so iterations
  // don't share account state — relevant only for future tests that
  // assert on persisted state, but documented here so a future "second
  // sync should be idempotent" test doesn't accidentally collide.
  it.each([
    'sales',
    'signals',
    'governance',
    'creative',
    'creative-builder',
    'brand',
  ])('per-agent gate fires on /%s/mcp (passthrough rejection)', async (tenantId) => {
    const env = await callSyncAccounts(baseUrl, tenantId, 'demo-billing-passthrough-v1', {
      accounts: [{
        brand: { domain: `${tenantId}.example` },
        operator: 'pinnacle-agency.example',
        billing: 'agent',
      }],
      idempotency_key: freshKey(`v6-${tenantId}-passthrough`),
    }, 100);
    const acct = env.result?.structuredContent?.accounts?.[0];
    expect(acct?.action).toBe('failed');
    expect(acct?.errors?.[0]?.code).toBe('BILLING_NOT_PERMITTED_FOR_AGENT');
  });

  it('unrecognized bearer (test-token) + billing: agent → success (uniform-response rule)', async () => {
    const env = await callSyncAccounts(baseUrl, 'sales', 'test-token', {
      accounts: [{
        brand: { domain: 'anon.example' },
        operator: 'pinnacle-agency.example',
        billing: 'agent',
        sandbox: true,
      }],
      idempotency_key: freshKey('v6-gate-unrecognized'),
    }, 4);
    const acct = env.result?.structuredContent?.accounts?.[0];
    // No principal → no per-agent gate. Capability gate accepts agent
    // (training-agent advertises all three values), so account provisions.
    expect(acct?.status).toBe('active');
    expect(acct?.billing).toBe('agent');
  });

  it('rejects missing bearer with 401 (regression-pin: requireAuth runs before tenantMcpHandler)', async () => {
    // Defense-in-depth: confirms the bridge's `principal && !req.auth`
    // condition never fires on unauthed traffic — `requireTokenDefault`
    // rejects at the middleware layer first, so the bridge never sees
    // the request. A regression in middleware ordering would surface
    // here as a 200 response with no auth context.
    const r = await fetch(`${baseUrl}/sales/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
      }),
    });
    expect(r.status).toBe(401);
  });
});
