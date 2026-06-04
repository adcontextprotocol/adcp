/**
 * Smoke test: tenant routes mount, /signals/mcp dispatches, brand.json
 * exposes the tenant key.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TrainingContext } from '../types.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

const SALES_CURRENT_SCENARIOS = [
  'force_creative_status',
  'force_media_buy_status',
  'simulate_delivery',
  'simulate_budget_spend',
  'force_create_media_buy_arm',
  'force_task_completion',
  'force_creative_purge',
  'seed_product',
  'seed_pricing_option',
  'seed_creative',
  'seed_media_buy',
  'seed_creative_format',
  'seed_measurement_catalog',
  'query_provenance_audit_observations',
];

const SALES_THREE_ZERO_COMPAT_SCENARIOS = [
  'force_creative_status',
  'force_media_buy_status',
  'simulate_delivery',
  'simulate_budget_spend',
];

async function bootServer(options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter(options));
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

function stageLatestThreeZeroSchemaBundle(): void {
  const schemasRoot = path.resolve('dist/schemas');
  const latest = fs.readdirSync(schemasRoot)
    .filter(name => /^3\.0\.\d+$/.test(name))
    .sort((a, b) => {
      const av = a.split('.').map(Number);
      const bv = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (av[i] !== bv[i]) return av[i] - bv[i];
      }
      return 0;
    })
    .at(-1);
  if (!latest) throw new Error('No dist/schemas/3.0.x bundle found');
  execFileSync('bash', ['scripts/stage-sdk-schema-bundle.sh', path.join(schemasRoot, latest), '3.0'], {
    stdio: 'ignore',
  });
}

async function initializeTenant(url: string): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
    }),
  });
}

async function callTenantTool(url: string, id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return response.json() as Promise<Record<string, unknown>>;
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
      // Body content irrelevant — we just need the init handshake to settle
      // before discovery so the JWKS is populated.
      await initR.text();
      // brand.json is the brand-protocol portfolio document. Each tenant has
      // an `agents[]` entry under house.agents with type, id, url, jwks_uri.
      // The signals tenant must appear by id.
      const r = await fetch(`${baseUrl}/.well-known/brand.json`);
      expect(r.status).toBe(200);
      const body = await r.json() as { house: { agents: Array<{ id: string; type: string; url: string; jwks_uri: string }> } };
      expect(Array.isArray(body.house?.agents)).toBe(true);
      expect(body.house.agents.length).toBeGreaterThan(0);
      const signalsAgent = body.house.agents.find(a => a.id === 'aao_training_agent_signals');
      expect(signalsAgent).toBeDefined();
      expect(signalsAgent?.type).toBe('signals');
      expect(signalsAgent?.url).toMatch(/\/signals\/mcp$/);
      expect(signalsAgent?.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
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
      expect(toolNames).toContain('get_signals');
      expect(toolNames).toContain('activate_signal');
      // Tenant should NOT expose mediaBuy / governance tools
      expect(toolNames).not.toContain('create_media_buy');
      expect(toolNames).not.toContain('sync_plans');
    } finally {
      await close();
    }
  }, 15000);

  it('advertises sales vendor-metric optimization capabilities', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer test-token',
      };
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
        }),
      });
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_adcp_capabilities', arguments: {} },
        }),
      });
      const body = await r.json() as {
        result?: {
          structuredContent?: {
            adcp_version?: string;
            adcp?: { major_versions?: number[]; supported_versions?: string[] };
            media_buy?: {
              supported_optimization_metrics?: string[];
              vendor_metric_optimization?: { supported_targets?: string[] };
            };
            compliance_testing?: { scenarios?: string[] };
          };
        };
      };
      const mediaBuy = body.result?.structuredContent?.media_buy;
      expect(body.result?.structuredContent?.adcp_version).toBe('3.0');
      expect(body.result?.structuredContent?.adcp?.major_versions).toContain(3);
      expect(body.result?.structuredContent?.adcp?.supported_versions).toEqual(['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7']);
      expect(mediaBuy?.supported_optimization_metrics).toContain('clicks');
      expect(mediaBuy?.vendor_metric_optimization?.supported_targets).toContain('threshold_rate');
      expect(body.result?.structuredContent?.compliance_testing?.scenarios).toEqual(
        expect.arrayContaining(SALES_CURRENT_SCENARIOS),
      );
    } finally {
      await close();
    }
  }, 15000);

  it('discovers and dispatches seed_measurement_catalog on /sales/mcp', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer test-token',
      };
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
        }),
      });
      const list = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: {
              account: { sandbox: true },
              adcp_version: '3.1',
              adcp_major_version: 3,
              scenario: 'list_scenarios',
            },
          },
        }),
      });
      const listed = await list.json() as {
        result?: {
          structuredContent?: { status?: string; adcp_version?: string; scenarios?: string[] };
        };
      };
      expect(listed.result?.structuredContent?.status).toBe('completed');
      expect(listed.result?.structuredContent?.adcp_version).toBe('3.0');
      expect(listed.result?.structuredContent?.scenarios).toEqual(expect.arrayContaining(SALES_CURRENT_SCENARIOS));

      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: {
              account: { sandbox: true, brand: { domain: 'tenant-seed.example' } },
              adcp_version: '3.1',
              adcp_major_version: 3,
              brand: { domain: 'tenant-seed.example' },
              scenario: 'seed_measurement_catalog',
              params: {
                vendor: { domain: 'attentionvendor.example' },
                metrics: [{ metric_id: 'attention_baseline' }],
              },
              context: { correlation_id: 'tenant-seed-measurement-catalog' },
            },
          },
        }),
      });
      const body = await r.json() as {
        result?: {
          structuredContent?: { status?: string; adcp_version?: string; success?: boolean; context?: { correlation_id?: string } };
        };
      };
      expect(body.result?.structuredContent?.status).toBe('completed');
      expect(body.result?.structuredContent?.adcp_version).toBe('3.0');
      expect(body.result?.structuredContent?.success).toBe(true);
      expect(body.result?.structuredContent?.context?.correlation_id).toBe('tenant-seed-measurement-catalog');

      const unsupported = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: {
              account: { sandbox: true },
              adcp_version: '4.0',
              scenario: 'list_scenarios',
              context: { correlation_id: 'tenant-local-version-unsupported' },
            },
          },
        }),
      });
      const unsupportedBody = await unsupported.json() as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            adcp_error?: {
              code?: string;
              field?: string;
              details?: { adcp_version?: string; supported_versions?: string[] };
            };
            context?: { correlation_id?: string };
          };
        };
      };
      expect(unsupportedBody.result?.isError).toBe(true);
      expect(unsupportedBody.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'VERSION_UNSUPPORTED',
        field: 'adcp_version',
        details: {
          adcp_version: '4.0',
          supported_versions: ['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7'],
        },
      });
      expect(unsupportedBody.result?.structuredContent?.context?.correlation_id).toBe('tenant-local-version-unsupported');
    } finally {
      await close();
    }
  }, 15000);

  it('does not advertise 3.1 measurement-catalog seeding in 3.0 storyboard compat mode', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/sales/mcp`;
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer test-token',
      };
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
        }),
      });
      const capabilities = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_adcp_capabilities', arguments: {} },
        }),
      });
      const capabilitiesBody = await capabilities.json() as {
        result?: { structuredContent?: { compliance_testing?: { scenarios?: string[] } } };
      };
      const scenarios = capabilitiesBody.result?.structuredContent?.compliance_testing?.scenarios ?? [];
      expect(scenarios).toEqual(expect.arrayContaining(SALES_THREE_ZERO_COMPAT_SCENARIOS));
      expect(scenarios).not.toContain('seed_measurement_catalog');
      expect(scenarios).not.toContain('query_provenance_audit_observations');

      const list = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: { account: { sandbox: true }, scenario: 'list_scenarios' },
          },
        }),
      });
      const listed = await list.json() as {
        result?: { structuredContent?: { scenarios?: string[] } };
      };
      expect(listed.result?.structuredContent?.scenarios).toEqual(SALES_THREE_ZERO_COMPAT_SCENARIOS);
      expect(listed.result?.structuredContent?.scenarios).not.toContain('seed_measurement_catalog');

      const directSeed = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'comply_test_controller',
            arguments: {
              account: { sandbox: true, brand: { domain: 'tenant-seed.example' } },
              brand: { domain: 'tenant-seed.example' },
              scenario: 'seed_measurement_catalog',
              params: {
                vendor: { domain: 'attentionvendor.example' },
                metrics: [{ metric_id: 'attention_baseline' }],
              },
            },
          },
        }),
      });
      const directSeedBody = await directSeed.json() as {
        result?: { structuredContent?: { success?: boolean } };
        error?: unknown;
      };
      expect(directSeedBody.result?.structuredContent?.success).not.toBe(true);
    } finally {
      await close();
    }
  }, 15000);

  it('hides the exact list_accounts account filter from 3.0 storyboard compat tool schemas', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const toolsBody = await callTenantTool(url, 2, 'list_accounts', {}) as {
        result?: { structuredContent?: { accounts?: unknown[] } };
      };
      expect(toolsBody.result?.structuredContent?.accounts).toHaveLength(3);

      const list = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      });
      const body = await list.json() as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, unknown> };
          }>;
        };
      };
      const listAccounts = body.result?.tools?.find(tool => tool.name === 'list_accounts');
      expect(listAccounts?.inputSchema?.properties ?? {}).not.toHaveProperty('account');
    } finally {
      await close();
    }
  }, 15000);

  it('does not advertise validate_input in 3.0 storyboard compat mode', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      for (const tenant of ['sales', 'creative', 'creative-builder']) {
        const url = `${baseUrl}/${tenant}/mcp`;
        await initializeTenant(url);
        const list = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: 'Bearer test-token',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        const body = await list.json() as {
          result?: { tools?: Array<{ name: string }> };
        };
        const toolNames = (body.result?.tools ?? []).map(tool => tool.name);
        expect(toolNames).not.toContain('validate_input');
      }
    } finally {
      await close();
    }
  }, 15000);

  it('does not advertise creative billing discriminator in 3.0 storyboard compat mode', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/creative/mcp`;
      await initializeTenant(url);
      const capabilitiesBody = await callTenantTool(url, 2, 'get_adcp_capabilities', {}) as {
        result?: { structuredContent?: { creative?: Record<string, unknown> } };
      };
      const creative = capabilitiesBody.result?.structuredContent?.creative ?? {};
      expect(creative).not.toHaveProperty('bills_through_adcp');
      // The transformer capability flags ride the same 3.0 gate and must also be absent.
      expect(creative).not.toHaveProperty('supports_transformers');
      expect(creative).not.toHaveProperty('supports_refinement');
      expect(creative).not.toHaveProperty('refinable_retention_seconds');
      expect(creative).not.toHaveProperty('multiplicity');
    } finally {
      await close();
    }
  }, 15000);

  it('advertises creative billing + transformer discriminators on the current creative tenant', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/creative/mcp`;
      await initializeTenant(url);
      const capabilitiesBody = await callTenantTool(url, 2, 'get_adcp_capabilities', {}) as {
        result?: { structuredContent?: { creative?: Record<string, unknown> } };
      };
      const creative = capabilitiesBody.result?.structuredContent?.creative ?? {};
      expect(creative.bills_through_adcp).toBe(false);
      expect(creative.supports_transformers).toBe(true);
      expect(creative.supports_refinement).toBe(true);
      expect((creative.multiplicity as { supports_variants?: boolean } | undefined)?.supports_variants).toBe(true);
    } finally {
      await close();
    }
  }, 15000);

  it('enforces idempotency on tenant report_usage custom tools', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const payload = {
        account: { brand: { domain: 'tenant-usage.example' }, operator: 'tenant-usage.example' },
        idempotency_key: 'tenant-report-usage-0001',
        reporting_period: { start: '2026-03-01T00:00:00Z', end: '2026-03-31T23:59:59Z' },
        usage: [{
          account: { brand: { domain: 'tenant-usage.example' }, operator: 'tenant-usage.example' },
          vendor_cost: 25,
          currency: 'USD',
        }],
      };

      const first = await callTenantTool(url, 2, 'report_usage', payload) as {
        result?: { structuredContent?: { accepted?: number; replayed?: boolean } };
      };
      const second = await callTenantTool(url, 3, 'report_usage', payload) as {
        result?: { structuredContent?: { accepted?: number; replayed?: boolean } };
      };

      expect(first.result?.structuredContent?.accepted).toBe(1);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      expect(second.result?.structuredContent?.accepted).toBe(1);
      expect(second.result?.structuredContent?.replayed).toBe(true);
    } finally {
      await close();
    }
  }, 15000);
});
