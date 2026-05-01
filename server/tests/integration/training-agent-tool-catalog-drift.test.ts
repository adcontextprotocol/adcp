/**
 * Drift detection for `tool-catalog.ts`.
 *
 * The catalog is hand-maintained — adding a tool to a `v6-*-platform.ts`
 * file without updating the catalog silently breaks the discovery
 * extension (`_training_agent_tenants[].tools[]`) on `adagents.json`.
 *
 * This test boots a fresh router instance and queries `tools/list` on
 * every tenant. For each tenant, it asserts:
 *   1. Every tool the platform actually advertises is in the catalog
 *      under that tenant.
 *   2. Every tool the catalog claims for the tenant is actually
 *      advertised.
 *
 * Run before merging changes to platform files or the catalog. Failures
 * print the exact diff per tenant so the fix is mechanical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'tool-catalog-drift-token';
  process.env.NODE_ENV = 'test';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { toolsForTenant, TOOL_CATALOG } = await import('../../src/training-agent/tenants/tool-catalog.js');

const TENANT_IDS = ['signals', 'sales', 'governance', 'creative', 'creative-builder', 'brand'] as const;
const AUTH = 'Bearer tool-catalog-drift-token';

interface ToolListResponse {
  result?: { tools?: Array<{ name: string }> };
}

async function listTools(baseUrl: string, tenantId: string): Promise<string[]> {
  const url = `${baseUrl}/api/training-agent/${tenantId}/mcp`;
  // MCP requires an `initialize` handshake before tools/list works.
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: AUTH,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'drift', version: '1' }, capabilities: {} },
    }),
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: AUTH,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = await res.json() as ToolListResponse;
  // Strip universal utility tools that the SDK auto-registers on every
  // tenant. The catalog deliberately doesn't track these because they
  // never form part of a "wrong tenant" hint — they're available
  // everywhere. `tasks_get` is the MCP transport-level task-poll helper.
  const NON_PROTOCOL_TOOLS = new Set([
    'get_adcp_capabilities',
    'comply_test_controller',
    'tasks_get',
  ]);
  return (body.result?.tools ?? [])
    .map(t => t.name)
    .filter(name => !NON_PROTOCOL_TOOLS.has(name))
    .sort();
}

describe('tool-catalog drift detection', () => {
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

  it.each(TENANT_IDS)('catalog matches actual tools/list for /%s', async (tenantId) => {
    const advertised = await listTools(baseUrl, tenantId);
    const catalog = toolsForTenant(tenantId);

    const missingFromCatalog = advertised.filter(t => !catalog.includes(t));
    const stale = catalog.filter(t => !advertised.includes(t));

    if (missingFromCatalog.length > 0 || stale.length > 0) {
      const message = [
        `Tool catalog drift on tenant '${tenantId}':`,
        missingFromCatalog.length
          ? `  missing from catalog (advertised but not listed): ${JSON.stringify(missingFromCatalog)}`
          : null,
        stale.length
          ? `  stale catalog entries (catalog claims tenant has, but tools/list omits): ${JSON.stringify(stale)}`
          : null,
        '',
        `Fix in server/src/training-agent/tenants/tool-catalog.ts so the entry for '${tenantId}'`,
        `matches the live tools/list output, then re-run.`,
      ].filter(Boolean).join('\n');
      throw new Error(message);
    }
    expect(advertised.sort()).toEqual([...catalog].sort());
  });

  it('every tool in the catalog references a known tenant id', () => {
    const validTenants = new Set<string>(TENANT_IDS);
    for (const [tool, tenants] of Object.entries(TOOL_CATALOG)) {
      for (const t of tenants) {
        expect(validTenants.has(t), `tool '${tool}' references unknown tenant '${t}'`).toBe(true);
      }
    }
  });
});
