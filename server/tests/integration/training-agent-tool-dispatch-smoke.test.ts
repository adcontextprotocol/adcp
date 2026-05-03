/**
 * Dispatch smoke test for the training agent.
 *
 * `tool-catalog-drift.test.ts` proves the names match. This test proves
 * the dispatch path is wired: for every (tenant, tool) pair in the catalog,
 * a `tools/call` with minimal arguments must NOT return NOT_IMPLEMENTED or
 * UNSUPPORTED_FEATURE. Domain errors (MEDIA_BUY_NOT_FOUND, INVALID_REQUEST,
 * etc.) count as passing — the handler ran.
 *
 * Façade class caught: a platform that advertises every tool in its catalog
 * (passes drift test) but has one or more handlers missing or stubbed-out.
 * This class escaped CI in #3962 (list_creative_formats on /creative +
 * /creative-builder was advertised but unimplemented until #3976).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'tool-dispatch-smoke-token';
  process.env.NODE_ENV = 'test';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { toolsForTenant } = await import('../../src/training-agent/tenants/tool-catalog.js');
const { MUTATING_TOOLS } = await import('../../src/training-agent/idempotency.js');

const TENANT_IDS = ['signals', 'sales', 'governance', 'creative', 'creative-builder', 'brand'] as const;
type TenantId = typeof TENANT_IDS[number];
const AUTH = 'Bearer tool-dispatch-smoke-token';

interface MCPResponse {
  error?: unknown;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

async function callTool(baseUrl: string, tenantId: string, toolName: string): Promise<MCPResponse> {
  const url = `${baseUrl}/api/training-agent/${tenantId}/mcp`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: AUTH,
  };
  // Initialize handshake — required before tools/call. Verify it succeeds so
  // a server-boot or auth failure surfaces here rather than as a phantom pass.
  const initRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'smoke', version: '1' }, capabilities: {} },
    }),
  });
  const initBody = await initRes.json() as MCPResponse;
  if (initBody.error) {
    throw new Error(`initialize failed for ${tenantId}: ${JSON.stringify(initBody.error)}`);
  }
  // Minimal arguments: mutating tools need an idempotency_key so the
  // framework routes to the handler (missing key → framework validation
  // error before dispatch, which would also not be NOT_IMPLEMENTED, but
  // an idempotency_key lets us reach the handler body cleanly).
  const args: Record<string, unknown> = MUTATING_TOOLS.has(toolName)
    ? { idempotency_key: `smoke-${crypto.randomUUID()}` }
    : {};
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  return res.json() as Promise<MCPResponse>;
}

// Build the full test matrix once from the catalog.
const TEST_CASES: Array<[TenantId, string]> = TENANT_IDS.flatMap(
  tenantId => toolsForTenant(tenantId).map(tool => [tenantId, tool] as [TenantId, string]),
);

describe('tool dispatch smoke', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it.each(TEST_CASES)('%s / %s handler is wired (no NOT_IMPLEMENTED)', async (tenantId, toolName) => {
    const body = await callTool(baseUrl, tenantId, toolName);

    const structured = body.result?.structuredContent;
    const errorCode = (structured?.adcp_error as Record<string, unknown> | undefined)?.code;

    // Domain errors (INVALID_REQUEST, MEDIA_BUY_NOT_FOUND, …) are expected
    // and count as passing — those mean the handler ran. Only NOT_IMPLEMENTED
    // and UNSUPPORTED_FEATURE indicate the dispatch path is unwired.
    expect(
      errorCode,
      `${tenantId}/${toolName}: handler returned NOT_IMPLEMENTED — add the method to the v6 platform class`,
    ).not.toBe('NOT_IMPLEMENTED');

    expect(
      errorCode,
      `${tenantId}/${toolName}: handler returned UNSUPPORTED_FEATURE — wire the method in the platform class`,
    ).not.toBe('UNSUPPORTED_FEATURE');

    // SDK-level UNSUPPORTED_FEATURE surfaces as a text string, not an
    // adcp_error envelope. Check the raw content text as a belt-and-suspenders
    // guard so the test catches both the AdcpError and SDK-wrapper forms.
    const textContent = body.result?.content?.[0]?.text ?? '';
    expect(
      textContent,
      `${tenantId}/${toolName}: SDK returned UNSUPPORTED_FEATURE — method missing from platform class`,
    ).not.toMatch(/UNSUPPORTED_FEATURE/);
  }, 15000);
});
