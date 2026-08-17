/**
 * Smoke test: tenant routes mount, /signals/mcp dispatches, brand.json
 * exposes the tenant key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TrainingContext } from '../types.js';
import { clearAccountStore } from '../account-handlers.js';
import {
  clearSessions,
  flushDirtySessions,
  getSession,
  runWithSessionContext,
  sessionKeyFromArgs,
  stopSessionCleanup,
} from '../state.js';
import { clearSiSessions } from '../si-handlers.js';
import { clearForcedTaskCompletions } from '../comply-test-controller.js';
import { getAgentUrl } from '../config.js';
import { projectV1ProductToV2 } from '@adcp/sdk/v2/projection';
import { TrainingBrandPlatform } from '../v6-brand-platform.js';
import { TrainingCreativeBuilderPlatform } from '../v6-creative-builder-platform.js';
import { TrainingCreativePlatform } from '../v6-creative-platform.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

const SALES_CURRENT_SCENARIOS = [
  'force_creative_status',
  'force_media_buy_status',
  'simulate_delivery',
  'simulate_budget_spend',
  'force_create_media_buy_arm',
  'force_task_completion',
  'force_creative_purge',
  'seed_account',
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

const SALES_THREE_ZERO_COMPLY_SCENARIOS = [
  ...SALES_THREE_ZERO_COMPAT_SCENARIOS,
  'force_create_media_buy_arm',
  'force_task_completion',
  'seed_product',
  'seed_pricing_option',
  'seed_creative',
  'seed_media_buy',
  'seed_creative_format',
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
  beforeEach(() => {
    clearSessions();
    clearAccountStore();
    clearSiSessions();
    clearForcedTaskCompletions();
  });

  afterEach(() => {
    clearSessions();
    clearAccountStore();
    clearSiSessions();
    clearForcedTaskCompletions();
    stopSessionCleanup();
  });

  it('keeps authenticated no-account sandbox resolution public while retaining principal identity', async () => {
    const principal = 'authenticated-no-account-caller';
    const platforms = [
      new TrainingBrandPlatform(),
      new TrainingCreativePlatform(),
      new TrainingCreativeBuilderPlatform(),
    ];

    for (const platform of platforms) {
      const account = await platform.accounts.resolve(undefined, {
        authInfo: { clientId: principal },
      });
      expect(account?.authInfo).toEqual({ kind: 'public', principal });
    }
  });

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

  it('enforces sync_governance on /signals activations after framework sync_accounts', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/signals/mcp`;
      await initializeTenant(url);

      const syncAccounts = await callTenantTool(url, 2, 'sync_accounts', {
        accounts: [{
          brand: { domain: 'tenant-signal-gov.example' },
          operator: 'pinnacle-agency.example',
          billing: 'operator',
          payment_terms: 'net_30',
        }],
        idempotency_key: 'tenant-signal-gov-sync-accounts',
      }) as {
        result?: { structuredContent?: { accounts?: Array<{ account_id?: string }> } };
      };
      expect(syncAccounts.result?.structuredContent?.accounts?.[0]?.account_id).toBeDefined();

      const syncGovernance = await callTenantTool(url, 3, 'sync_governance', {
        accounts: [{
          account: {
            brand: { domain: 'tenant-signal-gov.example' },
            operator: 'pinnacle-agency.example',
          },
          governance_agents: [{
            url: 'https://governance.tenant-signal-gov.example/mcp',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          }],
        }],
        idempotency_key: 'tenant-signal-gov-sync-governance',
      }) as {
        result?: { structuredContent?: { accounts?: Array<{ status?: string }> } };
      };
      expect(syncGovernance.result?.structuredContent?.accounts?.[0]?.status).toBe('synced');

      const activation = await callTenantTool(url, 4, 'activate_signal', {
        account: {
          brand: { domain: 'tenant-signal-gov.example' },
          operator: 'pinnacle-agency.example',
        },
        signal_agent_segment_id: 'trident_likely_ev_buyers',
        pricing_option_id: 'po_trident_ev_cpm',
        destinations: [{ type: 'agent', agent_url: 'https://seller.example/mcp' }],
        idempotency_key: 'tenant-signal-gov-activate',
      }) as {
        result?: { structuredContent?: { errors?: Array<{ code?: string; details?: { findings?: Array<{ category_id?: string }> } }> } };
      };
      const error = activation.result?.structuredContent?.errors?.[0];
      expect(error?.code).toBe('PERMISSION_DENIED');
      expect(error?.details?.findings?.[0]?.category_id).toBe('governance_context');
    } finally {
      await close();
    }
  }, 15000);

  it('validates and idempotently applies the sync_governance write boundary', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/signals/mcp`;
      await initializeTenant(url);
      const account = {
        brand: {
          domain: 'tenant-sync-governance.example',
          industries: ['outdoor-recreation'],
          data_subject_contestation: {
            url: 'https://tenant-sync-governance.example/privacy/contest',
            email: 'privacy@tenant-sync-governance.example',
            languages: ['en'],
          },
        },
        operator: 'pinnacle-agency.example',
      };
      await callTenantTool(url, 2, 'sync_accounts', {
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: 'tenant-sync-governance-accounts',
      });
      const payload = {
        accounts: [{
          account,
          governance_agents: [{
            url: 'https://governance.tenant-sync-governance.example/mcp',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          }],
        }],
        idempotency_key: 'tenant-sync-governance-idempotency',
      };

      const missingKey = await callTenantTool(url, 3, 'sync_governance', {
        accounts: payload.accounts,
      }) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(missingKey.result?.isError).toBe(true);
      expect(missingKey.result?.content?.[0]?.text).toContain('idempotency_key');

      for (const [id, governanceAgent] of [
        [4, { url: 'http://governance.example/mcp', authentication: payload.accounts[0].governance_agents[0].authentication }],
        [5, { url: 'https://governance.example/mcp', authentication: { schemes: ['Basic'], credentials: 'short' } }],
      ] as const) {
        const invalid = await callTenantTool(url, id, 'sync_governance', {
          ...payload,
          idempotency_key: `${payload.idempotency_key}-${id}`,
          accounts: [{ account, governance_agents: [governanceAgent] }],
        }) as { result?: { isError?: boolean } };
        expect(invalid.result?.isError).toBe(true);
      }

      const invalidAccount = await callTenantTool(url, 10, 'list_accounts', {
        account: {
          brand: { domain: 'Not A Canonical Domain' },
          operator: 'pinnacle-agency.example',
        },
      }) as { result?: { isError?: boolean } };
      expect(invalidAccount.result?.isError).toBe(true);

      const first = await callTenantTool(url, 7, 'sync_governance', payload) as {
        result?: { structuredContent?: { accounts?: Array<{ status?: string }>; replayed?: boolean } };
      };
      const replay = await callTenantTool(url, 8, 'sync_governance', payload) as {
        result?: { structuredContent?: { accounts?: Array<{ status?: string }>; replayed?: boolean } };
      };
      expect(first.result?.structuredContent?.accounts?.[0]?.status).toBe('synced');
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      expect(replay.result?.structuredContent?.replayed).toBe(true);

      const conflict = await callTenantTool(url, 9, 'sync_governance', {
        ...payload,
        accounts: [{
          account,
          governance_agents: [{
            ...payload.accounts[0].governance_agents[0],
            url: 'https://different-governance.example/mcp',
          }],
        }],
      }) as { result?: { structuredContent?: { adcp_error?: { code?: string } } } };
      expect(conflict.result?.structuredContent?.adcp_error?.code).toBe('IDEMPOTENCY_CONFLICT');
    } finally {
      await close();
    }
  }, 30000);

  it('advertises exact governance-enforcement task claims on each enforcing tenant', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const expected: Record<string, string[]> = {
        sales: ['create_media_buy'],
        signals: ['activate_signal'],
        brand: ['acquire_rights'],
        creative: ['build_creative'],
        'creative-builder': ['build_creative'],
      };
      for (const [index, [tenant, tasks]] of Object.entries(expected).entries()) {
        const url = `${baseUrl}/${tenant}/mcp`;
        await initializeTenant(url);
        const response = await callTenantTool(url, 20 + index, 'get_adcp_capabilities', {}) as {
          result?: { structuredContent?: {
            adcp?: { governance_enforcement?: { tasks?: Array<{ task?: string; modes?: string[] }> } };
            experimental_features?: string[];
            specialisms?: string[];
          } };
        };
        const capabilities = response.result?.structuredContent;
        expect(capabilities?.adcp?.governance_enforcement?.tasks).toEqual(
          tasks.map(task => ({ task, modes: ['signed_context'] })),
        );
        expect(capabilities?.experimental_features).toContain('governance.campaign');
        if (tenant === 'creative-builder') {
          expect(capabilities?.specialisms).toContain('creative-transformers');
        }
      }
    } finally {
      await close();
    }
  }, 30000);

  it('rejects a governed rights acquisition without persisting a grant', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/brand/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-rights-gov.example' },
        operator: 'pinnacle-agency.example',
      };
      await callTenantTool(url, 2, 'sync_accounts', {
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: 'tenant-rights-gov-sync-accounts',
      });
      await callTenantTool(url, 3, 'sync_governance', {
        accounts: [{
          account,
          governance_agents: [{
            url: 'https://governance.tenant-rights-gov.example/mcp',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          }],
        }],
        idempotency_key: 'tenant-rights-gov-sync-governance',
      });
      const catalog = await callTenantTool(url, 4, 'get_rights', {
        buyer: { domain: 'pinnacle-agency.example' },
        query: 'commercial rights',
        uses: ['commercial'],
      }) as { result?: { structuredContent?: { rights?: Array<{
        rights_id?: string;
        pricing_options?: Array<{ pricing_option_id?: string }>;
      }> } } };
      const rightsId = catalog.result?.structuredContent?.rights?.[0]?.rights_id;
      const pricingOptionId = catalog.result?.structuredContent?.rights?.[0]?.pricing_options?.[0]?.pricing_option_id;
      expect(rightsId).toBeDefined();
      expect(pricingOptionId).toBeDefined();

      const denied = await callTenantTool(url, 5, 'acquire_rights', {
        account,
        rights_id: rightsId,
        pricing_option_id: pricingOptionId,
        buyer: { domain: 'pinnacle-agency.example' },
        campaign: {
          description: 'Governance denial smoke test',
          uses: ['commercial'],
          countries: ['US'],
          estimated_impressions: 1_000_000,
          start_date: '2099-04-01',
          end_date: '2099-06-30',
        },
        revocation_webhook: {
          url: 'https://pinnacle-agency.example/webhooks/revocation',
          authentication: { schemes: ['Bearer'], credentials: 'revocation-token-xxxxxxxxxxxxxxxx' },
        },
        idempotency_key: 'tenant-rights-gov-acquire-denied',
      }) as { result?: { structuredContent?: { rights_status?: string; reason?: string } } };
      expect(denied.result?.structuredContent?.rights_status).toBe('rejected');
      expect(denied.result?.structuredContent?.reason).toMatch(/governance approval/i);

      const update = await callTenantTool(url, 6, 'update_rights', {
        account,
        rights_id: rightsId,
        paused: true,
        idempotency_key: 'tenant-rights-gov-no-grant-update',
      }) as { result?: { structuredContent?: {
        errors?: Array<{ code?: string }>;
        adcp_error?: { code?: string };
      } } };
      const updateError = update.result?.structuredContent?.adcp_error?.code
        ?? update.result?.structuredContent?.errors?.[0]?.code;
      expect(updateError).toBe('REFERENCE_NOT_FOUND');
    } finally {
      await close();
    }
  }, 30000);

  it('rejects paid creative execution without governance authorization', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/creative-builder/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-creative-gov.example' },
        operator: 'pinnacle-agency.example',
      };
      await callTenantTool(url, 2, 'sync_accounts', {
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: 'tenant-creative-gov-sync-accounts',
      });
      await callTenantTool(url, 3, 'sync_governance', {
        accounts: [{
          account,
          governance_agents: [{
            url: 'https://governance.tenant-creative-gov.example/mcp',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          }],
        }],
        idempotency_key: 'tenant-creative-gov-sync-governance',
      });
      const transformers = await callTenantTool(url, 4, 'list_transformers', {
        account,
        include_pricing: true,
      }) as { result?: { structuredContent?: { transformers?: Array<{
        transformer_id?: string;
        output_capability_ids?: string[];
      }> } } };
      const transformer = transformers.result?.structuredContent?.transformers?.[0];
      expect(transformer?.transformer_id).toBeDefined();
      expect(transformer?.output_capability_ids?.[0]).toBeDefined();

      const denied = await callTenantTool(url, 5, 'build_creative', {
        account,
        mode: 'execute',
        transformer_id: transformer?.transformer_id,
        target_capability_id: transformer?.output_capability_ids?.[0],
        message: 'Produce a 30-second voiceover.',
        idempotency_key: 'tenant-creative-gov-build-denied',
      }) as { result?: { structuredContent?: { errors?: Array<{
        code?: string;
        details?: { findings?: Array<{ category_id?: string }> };
      }> } } };
      const error = denied.result?.structuredContent?.errors?.[0];
      expect(error?.code).toBe('PERMISSION_DENIED');
      expect(error?.details?.findings?.[0]?.category_id).toBe('governance_context');
    } finally {
      await close();
    }
  }, 30000);

  it('inherits paid transformer governance when refining a retained build variant', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/creative-builder/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-creative-refine-gov.example' },
        operator: 'pinnacle-agency.example',
      };
      await callTenantTool(url, 2, 'sync_accounts', {
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: 'tenant-creative-refine-sync-accounts',
      });
      const transformers = await callTenantTool(url, 3, 'list_transformers', {
        account,
        include_pricing: true,
      }) as { result?: { structuredContent?: { transformers?: Array<{
        transformer_id?: string;
        output_capability_ids?: string[];
      }> } } };
      const transformer = transformers.result?.structuredContent?.transformers?.[0];
      const parent = await callTenantTool(url, 4, 'build_creative', {
        account,
        mode: 'execute',
        transformer_id: transformer?.transformer_id,
        target_capability_id: transformer?.output_capability_ids?.[0],
        message: 'Produce the original 30-second voiceover.',
        idempotency_key: 'tenant-creative-refine-parent-build',
      }) as { result?: { structuredContent?: { build_variant_id?: string } } };
      const buildVariantId = parent.result?.structuredContent?.build_variant_id;
      expect(buildVariantId).toBeDefined();

      await callTenantTool(url, 5, 'sync_governance', {
        accounts: [{
          account,
          governance_agents: [{
            url: 'https://governance.tenant-creative-refine-gov.example/mcp',
            authentication: {
              schemes: ['Bearer'],
              credentials: 'gov-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            },
          }],
        }],
        idempotency_key: 'tenant-creative-refine-sync-governance',
      });

      const denied = await callTenantTool(url, 6, 'build_creative', {
        account,
        mode: 'execute',
        refine_from_build_variant_id: buildVariantId,
        message: 'Make the delivery warmer.',
        idempotency_key: 'tenant-creative-refine-denied',
      }) as { result?: { structuredContent?: { errors?: Array<{ code?: string }> } } };
      expect(denied.result?.structuredContent?.errors?.[0]?.code).toBe('PERMISSION_DENIED');
    } finally {
      await close();
    }
  }, 30000);

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
              features?: { inline_creative_management?: boolean };
              supported_optimization_metrics?: string[];
              vendor_metric_optimization?: { supported_targets?: string[] };
            };
            compliance_testing?: { scenarios?: string[] };
          };
        };
      };
      const mediaBuy = body.result?.structuredContent?.media_buy;
      expect(body.result?.structuredContent?.adcp_version).toBe('3.1');
      expect(body.result?.structuredContent?.adcp?.major_versions).toContain(3);
      expect(body.result?.structuredContent?.adcp?.supported_versions).toEqual(['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7', '3.1-rc.8', '3.1-rc.9', '3.1-rc.10', '3.1-rc.14', '3.1-rc.15', '3.2-beta.0']);
      expect(mediaBuy?.features?.inline_creative_management).toBe(true);
      expect(mediaBuy?.supported_optimization_metrics).toContain('clicks');
      expect(mediaBuy?.vendor_metric_optimization?.supported_targets).toContain('threshold_rate');
      expect(body.result?.structuredContent?.compliance_testing?.scenarios).toEqual(
        expect.arrayContaining(SALES_CURRENT_SCENARIOS),
      );
    } finally {
      await close();
    }
  }, 15000);

  it('reconciles a forced create_media_buy task through submitted and completed states', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'async-lifecycle.example' },
        operator: 'pinnacle-agency.example',
        sandbox: true,
      };
      const taskId = 'task_training_async_lifecycle';
      const completion = {
        media_buy_id: 'mb_training_async_lifecycle',
        media_buy_status: 'pending_creatives',
        confirmed_at: '2026-08-15T12:00:00Z',
        revision: 1,
        currency: 'USD',
        packages: [{
          package_id: 'pkg_training_async_lifecycle',
          product_id: 'async_lifecycle_video_q3',
          pricing_option_id: 'async_lifecycle_cpm',
          budget: 30_000,
          paused: false,
        }],
      };
      const payload = (response: Record<string, unknown>) => (
        response as { result?: { structuredContent?: Record<string, unknown> } }
      ).result?.structuredContent;

      const forced = payload(await callTenantTool(url, 2, 'comply_test_controller', {
        account,
        scenario: 'force_create_media_buy_arm',
        params: { arm: 'submitted', task_id: taskId },
      }));
      expect(forced?.success).toBe(true);

      const submitted = payload(await callTenantTool(url, 3, 'create_media_buy', {
        account,
        brand: account.brand,
        start_time: 'asap',
        end_time: '2099-09-30T23:59:59Z',
        packages: [{
          product_id: 'async_lifecycle_video_q3',
          pricing_option_id: 'async_lifecycle_cpm',
          budget: 30_000,
        }],
        idempotency_key: 'training-async-lifecycle-create-0001',
      }));
      expect(submitted).toMatchObject({ status: 'submitted', task_id: taskId });

      const pendingRead = payload(await callTenantTool(url, 4, 'get_task_status', {
        account,
        task_id: taskId,
      }));
      expect(pendingRead).toMatchObject({
        task_id: taskId,
        task_type: 'create_media_buy',
        protocol: 'media-buy',
        status: 'submitted',
      });

      const pendingList = payload(await callTenantTool(url, 5, 'list_tasks', {
        account,
        filters: { task_ids: [taskId], task_type: 'create_media_buy' },
        pagination: { max_results: 1 },
      }));
      expect(pendingList?.tasks).toEqual([
        expect.objectContaining({ task_id: taskId, task_type: 'create_media_buy', status: 'submitted' }),
      ]);

      const completed = payload(await callTenantTool(url, 6, 'comply_test_controller', {
        account,
        scenario: 'force_task_completion',
        params: { task_id: taskId, result: completion },
      }));
      expect(completed).toMatchObject({ success: true, current_state: 'completed' });

      const terminalRead = payload(await callTenantTool(url, 7, 'get_task_status', {
        account,
        task_id: taskId,
        include_result: true,
      }));
      expect(terminalRead).toMatchObject({
        task_id: taskId,
        task_type: 'create_media_buy',
        status: 'completed',
        result: completion,
      });

      const terminalList = payload(await callTenantTool(url, 8, 'list_tasks', {
        account,
        filters: { task_ids: [taskId], task_type: 'create_media_buy', status: 'completed' },
        pagination: { max_results: 1 },
      }));
      expect(terminalList?.tasks).toEqual([
        expect.objectContaining({ task_id: taskId, task_type: 'create_media_buy', status: 'completed' }),
      ]);
    } finally {
      await close();
    }
  }, 15000);

  it('serves the AdCP 3.1 dual product shape through the explicit legacy facade', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const body = await callTenantTool(url, 2, 'get_products', {
        adcp_version: '3.1',
        idempotency_key: 'dual-product-shape-default-0001',
        buying_mode: 'wholesale',
        account: {
          brand: { domain: 'legacy-product-facade.example' },
          operator: 'pinnacle-agency.example',
        },
      }) as {
        result?: {
          structuredContent?: {
            errors?: Array<{ code?: string }>;
            products?: Array<{
              format_ids?: unknown[];
              format_options?: Array<{
                format_kind?: string;
                canonical_formats_only?: boolean;
                v1_format_ref?: unknown;
              }>;
            }>;
          };
        };
      };
      const payload = body.result?.structuredContent;
      expect(payload?.errors).toBeUndefined();
      expect(payload?.products?.length).toBeGreaterThan(0);
      expect(payload?.products?.every(product =>
        Array.isArray(product.format_ids) && product.format_ids.length > 0
        && Array.isArray(product.format_options) && product.format_options.length > 0
      )).toBe(true);
      const carousel = payload?.products
        ?.flatMap(product => product.format_options ?? [])
        .find(option => option.format_kind === 'image_carousel');
      expect(carousel).toEqual(expect.objectContaining({ canonical_formats_only: true }));
      expect(carousel).not.toHaveProperty('v1_format_ref');

      const legacy = await callTenantTool(url, 3, 'get_products', {
        adcp_version: '3.1',
        idempotency_key: 'dual-product-shape-legacy-0001',
        buying_mode: 'wholesale',
        account: {
          brand: { domain: 'legacy-product-wire.example' },
          operator: 'pinnacle-agency.example',
        },
        ext: { adcp: { creative_wire: 'legacy' } },
      }) as {
        result?: { structuredContent?: { products?: Array<Record<string, unknown>> } };
      };
      if (!legacy.result?.structuredContent?.products) throw new Error(JSON.stringify(legacy));
      expect(legacy.result.structuredContent.products.length).toBeGreaterThan(0);
      expect(legacy.result?.structuredContent?.products?.every(product =>
        Array.isArray(product.format_ids) && !Object.hasOwn(product, 'format_options')
      )).toBe(true);

      const canonical = await callTenantTool(url, 4, 'get_products', {
        adcp_version: '3.1',
        idempotency_key: 'dual-product-shape-canonical-0001',
        buying_mode: 'wholesale',
        account: {
          brand: { domain: 'canonical-product-wire.example' },
          operator: 'pinnacle-agency.example',
        },
        ext: { adcp: { creative_wire: 'canonical' } },
      }) as {
        result?: { structuredContent?: { products?: Array<Record<string, unknown>> } };
      };
      expect(canonical.result?.structuredContent?.products?.length).toBeGreaterThan(0);
      expect(canonical.result?.structuredContent?.products?.every(product =>
        Array.isArray(product.format_options) && !Object.hasOwn(product, 'format_ids')
      )).toBe(true);
    } finally {
      await close();
    }
  }, 30000);

  it('preserves canonical creative identity on every creative-capable tenant route', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      for (const [index, tenant] of ['sales', 'creative'].entries()) {
        const url = `${baseUrl}/${tenant}/mcp`;
        await initializeTenant(url);
        const account = {
          brand: { domain: `canonical-${tenant}.example` },
          operator: 'pinnacle-agency.example',
        };
        const creativeId = `cr_canonical_${tenant}`;
        const formatOptionRef = {
          scope: 'publisher',
          publisher_domain: 'publisher.example',
          format_option_id: 'homepage_image',
        };
        const sync = await callTenantTool(url, 10 + index * 2, 'sync_creatives', {
          adcp_version: '3.1',
          idempotency_key: `canonical-${tenant}-sync-0001`,
          account,
          creatives: [{
            creative_id: creativeId,
            format_kind: 'image',
            format_option_ref: formatOptionRef,
            name: `Canonical ${tenant} creative`,
          }],
        }) as {
          result?: {
            structuredContent?: {
              errors?: Array<{ code?: string }>;
              creatives?: Array<{ creative_id?: string; action?: string }>;
            };
          };
        };
        expect(sync.result?.structuredContent?.errors).toBeUndefined();
        expect(sync.result?.structuredContent?.creatives).toEqual([
          expect.objectContaining({ creative_id: creativeId, action: 'created' }),
        ]);

        const listed = await callTenantTool(url, 11 + index * 2, 'list_creatives', {
          adcp_version: '3.1',
          account,
          creative_ids: [creativeId],
        }) as {
          result?: {
            structuredContent?: {
              errors?: Array<{ code?: string }>;
              creatives?: Array<Record<string, unknown>>;
            };
          };
        };
        const creative = listed.result?.structuredContent?.creatives?.[0];
        expect(listed.result?.structuredContent?.errors).toBeUndefined();
        expect(creative).toEqual(expect.objectContaining({
          creative_id: creativeId,
          format_kind: 'image',
          format_option_ref: formatOptionRef,
        }));
        expect(creative).not.toHaveProperty('format_id');
      }

      const crossDialectUrl = `${baseUrl}/sales/mcp`;
      const crossDialectAccount = {
        brand: { domain: 'cross-dialect-creative.example' },
        operator: 'pinnacle-agency.example',
      };
      const legacyRef = { agent_url: getAgentUrl(), id: 'display_300x250' };
      await callTenantTool(crossDialectUrl, 18, 'sync_creatives', {
        adcp_version: '3.1',
        idempotency_key: 'cross-dialect-legacy-sync-0001',
        account: crossDialectAccount,
        creatives: [{ creative_id: 'cr_legacy_to_canonical', format_id: legacyRef }],
        ext: { adcp: { creative_wire: 'legacy' } },
      });
      const canonicalRead = await callTenantTool(crossDialectUrl, 19, 'list_creatives', {
        adcp_version: '3.1',
        account: crossDialectAccount,
        filters: {
          creative_ids: ['cr_legacy_to_canonical'],
          format_kinds: ['image'],
        },
        ext: { adcp: { creative_wire: 'canonical' } },
      }) as {
        result?: {
          structuredContent?: {
            errors?: Array<{ code?: string }>;
            creatives?: Array<Record<string, unknown>>;
          };
        };
      };
      expect(canonicalRead.result?.structuredContent?.errors).toBeUndefined();
      expect(canonicalRead.result?.structuredContent?.creatives?.[0]).toEqual(
        expect.objectContaining({ creative_id: 'cr_legacy_to_canonical', format_kind: 'image' }),
      );
      expect(canonicalRead.result?.structuredContent?.creatives?.[0]).not.toHaveProperty('format_id');

      await callTenantTool(crossDialectUrl, 20, 'sync_creatives', {
        adcp_version: '3.1',
        idempotency_key: 'cross-dialect-canonical-sync-0001',
        account: crossDialectAccount,
        creatives: [{
          creative_id: 'cr_canonical_to_legacy',
          format_kind: 'image',
          format_option_ref: { scope: 'product', format_option_id: 'display_300x250_image' },
        }],
      });
      const legacyRead = await callTenantTool(crossDialectUrl, 21, 'list_creatives', {
        adcp_version: '3.1',
        account: crossDialectAccount,
        filters: {
          creative_ids: ['cr_canonical_to_legacy'],
          format_ids: [legacyRef],
        },
        ext: { adcp: { creative_wire: 'legacy' } },
      }) as {
        result?: {
          structuredContent?: {
            errors?: Array<{ code?: string }>;
            creatives?: Array<Record<string, unknown>>;
          };
        };
      };
      expect(legacyRead.result?.structuredContent?.errors).toBeUndefined();
      expect(legacyRead.result?.structuredContent?.creatives?.[0]).toEqual(
        expect.objectContaining({
          creative_id: 'cr_canonical_to_legacy',
          format_id: expect.objectContaining({ id: 'display_300x250' }),
        }),
      );
      expect(legacyRead.result?.structuredContent?.creatives?.[0]).not.toHaveProperty('format_kind');

      const builderUrl = `${baseUrl}/creative-builder/mcp`;
      await initializeTenant(builderUrl);
      const builderSync = await callTenantTool(builderUrl, 20, 'sync_creatives', {
        adcp_version: '3.1',
        idempotency_key: 'canonical-creative-builder-sync-0001',
        account: {
          brand: { domain: 'canonical-creative-builder.example' },
          operator: 'pinnacle-agency.example',
        },
        creatives: [{
          creative_id: 'cr_canonical_creative_builder',
          format_kind: 'image',
          format_option_ref: {
            scope: 'publisher',
            publisher_domain: 'publisher.example',
            format_option_id: 'homepage_image',
          },
          name: 'Canonical creative-builder creative',
        }],
      }) as {
        result?: {
          structuredContent?: {
            errors?: Array<{ code?: string }>;
            creatives?: Array<{ creative_id?: string; action?: string }>;
          };
        };
      };
      expect(builderSync.result?.structuredContent?.errors).toBeUndefined();
      expect(builderSync.result?.structuredContent?.creatives).toEqual([
        expect.objectContaining({ creative_id: 'cr_canonical_creative_builder', action: 'created' }),
      ]);
      const builderRead = await callTenantTool(builderUrl, 22, 'build_creative', {
        adcp_version: '3.1',
        idempotency_key: 'canonical-creative-builder-read-0001',
        account: {
          brand: { domain: 'canonical-creative-builder.example' },
          operator: 'pinnacle-agency.example',
        },
        creative_id: 'cr_canonical_creative_builder',
      }) as {
        result?: { structuredContent?: { creative_manifest?: Record<string, unknown> } };
      };
      expect(builderRead.result?.structuredContent?.creative_manifest).toEqual(
        expect.objectContaining({
          format_kind: 'image',
          format_option_ref: {
            scope: 'publisher',
            publisher_domain: 'publisher.example',
            format_option_id: 'homepage_image',
          },
        }),
      );
      expect(builderRead.result?.structuredContent?.creative_manifest).not.toHaveProperty('format_id');

      const builderTransform = await callTenantTool(builderUrl, 23, 'build_creative', {
        adcp_version: '3.1',
        idempotency_key: 'canonical-creative-builder-transform-0001',
        account: {
          brand: { domain: 'canonical-creative-builder.example' },
          operator: 'pinnacle-agency.example',
        },
        creative_id: 'cr_canonical_creative_builder',
        target_capability_id: 'audio_vo',
      }) as {
        result?: { structuredContent?: { creative_manifest?: Record<string, unknown> } };
      };
      expect(builderTransform.result?.structuredContent?.creative_manifest).toEqual(
        expect.objectContaining({ format_kind: 'audio_hosted' }),
      );
      expect(builderTransform.result?.structuredContent?.creative_manifest).not.toHaveProperty('format_option_ref');
      expect(builderTransform.result?.structuredContent?.creative_manifest).not.toHaveProperty('format_id');
    } finally {
      await close();
    }
  }, 30000);

  it('preserves 3.0 creative identity through explicit legacy handler seams', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const legacySalesUrl = `${baseUrl}/sales/mcp`;
      await initializeTenant(legacySalesUrl);
      const legacyProducts = await callTenantTool(legacySalesUrl, 25, 'get_products', {
        adcp_version: '3.0',
        buying_mode: 'wholesale',
        account: {
          brand: { domain: 'three-zero-product-wire.example' },
          operator: 'pinnacle-agency.example',
        },
        ext: { adcp: { creative_wire: 'legacy' } },
      }) as {
        result?: { structuredContent?: { products?: Array<Record<string, unknown>> } };
      };
      expect(legacyProducts.result?.structuredContent?.products?.length).toBeGreaterThan(0);
      expect(legacyProducts.result?.structuredContent?.products?.every(product =>
        Array.isArray(product.format_ids) && !Object.hasOwn(product, 'format_options')
      )).toBe(true);

      const localFormat = {
        agent_url: getAgentUrl(),
        id: 'display_image',
        width: 300,
        height: 250,
      };
      const externalFormat = {
        agent_url: 'https://creative.partner.example',
        id: 'video_30s',
        duration_ms: 30_000,
      };
      for (const [index, tenant] of ['sales', 'creative'].entries()) {
        const url = `${baseUrl}/${tenant}/mcp`;
        await initializeTenant(url);
        const account = {
          brand: { domain: `legacy-creative-${tenant}.example` },
          operator: 'pinnacle-agency.example',
        };
        const localCreativeId = `cr_legacy_${tenant}`;
        const externalCreativeId = `cr_external_legacy_${tenant}`;
        const sync = await callTenantTool(url, 30 + index * 3, 'sync_creatives', {
          adcp_version: '3.0',
          idempotency_key: `legacy-creative-${tenant}-sync-0001`,
          account,
          creatives: [
            {
              creative_id: localCreativeId,
              format_id: localFormat,
              name: `Legacy ${tenant} creative`,
            },
            {
              creative_id: externalCreativeId,
              format_id: externalFormat,
              name: `External legacy ${tenant} creative`,
            },
          ],
          ext: { adcp: { creative_wire: 'legacy' } },
        }) as {
          result?: {
            structuredContent?: {
              errors?: Array<{ code?: string }>;
              creatives?: Array<{ creative_id?: string; action?: string }>;
            };
          };
        };
        expect(sync.result?.structuredContent?.errors).toBeUndefined();
        expect(sync.result?.structuredContent?.creatives).toEqual([
          expect.objectContaining({ creative_id: localCreativeId, action: 'created' }),
          expect.objectContaining({ creative_id: externalCreativeId, action: 'created' }),
        ]);

        const listed = await callTenantTool(url, 31 + index * 3, 'list_creatives', {
          adcp_version: '3.0',
          account,
          filters: { format_ids: [localFormat] },
          ext: { adcp: { creative_wire: 'legacy' } },
        }) as {
          result?: {
            structuredContent?: {
              errors?: Array<{ code?: string }>;
              creatives?: Array<{
                creative_id?: string;
                format_id?: {
                  agent_url?: string;
                  id?: string;
                  width?: number;
                  height?: number;
                  duration_ms?: number;
                };
                format_kind?: string;
              }>;
            };
          };
        };
        const payload = listed.result?.structuredContent;
        expect(payload).toEqual(expect.objectContaining({
          creatives: [
            expect.objectContaining({
              creative_id: localCreativeId,
              format_id: localFormat,
            }),
          ],
        }));
        expect(payload?.creatives?.[0]?.format_kind).toBeUndefined();

        const external = await callTenantTool(url, 32 + index * 3, 'list_creatives', {
          adcp_version: '3.0',
          account,
          creative_ids: [externalCreativeId],
          ext: { adcp: { creative_wire: 'legacy' } },
        }) as {
          result?: { structuredContent?: { creatives?: Array<{ format_id?: unknown }> } };
        };
        expect(external.result?.structuredContent?.creatives?.[0]?.format_id).toEqual(externalFormat);
      }

      const builderUrl = `${baseUrl}/creative-builder/mcp`;
      await initializeTenant(builderUrl);
      const builderSync = await callTenantTool(builderUrl, 40, 'sync_creatives', {
        adcp_version: '3.0',
        idempotency_key: 'legacy-creative-builder-sync-0001',
        account: {
          brand: { domain: 'legacy-creative-builder.example' },
          operator: 'pinnacle-agency.example',
        },
        creatives: [{
          creative_id: 'cr_legacy_creative_builder',
          format_id: localFormat,
          name: 'Legacy creative-builder creative',
        }],
        ext: { adcp: { creative_wire: 'legacy' } },
      }) as {
        result?: {
          structuredContent?: {
            errors?: Array<{ code?: string }>;
            creatives?: Array<{ creative_id?: string; action?: string }>;
          };
        };
      };
      expect(builderSync.result?.structuredContent?.errors).toBeUndefined();
      expect(builderSync.result?.structuredContent?.creatives).toEqual([
        expect.objectContaining({ creative_id: 'cr_legacy_creative_builder', action: 'created' }),
      ]);
      const builderRead = await callTenantTool(builderUrl, 41, 'build_creative', {
        adcp_version: '3.0',
        idempotency_key: 'legacy-creative-builder-read-0001',
        account: {
          brand: { domain: 'legacy-creative-builder.example' },
          operator: 'pinnacle-agency.example',
        },
        creative_id: 'cr_legacy_creative_builder',
        ext: { adcp: { creative_wire: 'legacy' } },
      }) as {
        result?: { structuredContent?: { creative_manifest?: Record<string, unknown> } };
      };
      expect(
        builderRead.result?.structuredContent?.creative_manifest,
        JSON.stringify(builderRead),
      ).toEqual(
        expect.objectContaining({ format_id: localFormat }),
      );
      expect(builderRead.result?.structuredContent?.creative_manifest).not.toHaveProperty('format_kind');
    } finally {
      await close();
    }
  }, 30000);

  it('round-trips legacy-only package selectors through the native sales facade', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'legacy-only-native-package.example' },
        operator: 'pinnacle-agency.example',
        sandbox: true,
      };
      const productId = 'legacy_only_native_package';
      const pricingOptionId = 'legacy_only_native_package_cpm';
      const legacyFormat = {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_300x250_image',
        width: 300,
        height: 250,
      };

      await callTenantTool(url, 70, 'comply_test_controller', {
        adcp_version: '3.0',
        account,
        brand: account.brand,
        scenario: 'seed_product',
        params: {
          product_id: productId,
          fixture: {
            name: 'Legacy-only native package',
            description: 'No canonical declarations',
            delivery_type: 'guaranteed',
            channels: ['display'],
            format_ids: [legacyFormat],
          },
        },
      });
      await callTenantTool(url, 71, 'comply_test_controller', {
        adcp_version: '3.0',
        account,
        brand: account.brand,
        scenario: 'seed_pricing_option',
        params: {
          product_id: productId,
          pricing_option_id: pricingOptionId,
          fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 12 },
        },
      });

      const created = await callTenantTool(url, 72, 'create_media_buy', {
        adcp_version: '3.0',
        idempotency_key: 'legacy-only-native-create-0001',
        account,
        brand: account.brand,
        start_time: '2027-06-01T00:00:00Z',
        end_time: '2027-07-01T00:00:00Z',
        packages: [{
          product_id: productId,
          pricing_option_id: pricingOptionId,
          budget: 10_000,
          format_ids: [legacyFormat],
        }],
      }) as {
        result?: { structuredContent?: { media_buy_id?: string; packages?: Array<Record<string, unknown>>; adcp_error?: unknown } };
      };
      expect(created.result?.structuredContent?.adcp_error, JSON.stringify(created)).toBeUndefined();
      expect(created.result?.structuredContent?.packages?.[0]?.format_ids).toEqual([legacyFormat]);
      expect(created.result?.structuredContent?.packages?.[0]).not.toHaveProperty('format_option_refs');
      const mediaBuyId = created.result?.structuredContent?.media_buy_id;

      const updated = await callTenantTool(url, 73, 'update_media_buy', {
        adcp_version: '3.0',
        idempotency_key: 'legacy-only-native-update-0001',
        account,
        media_buy_id: mediaBuyId,
        new_packages: [{
          product_id: productId,
          pricing_option_id: pricingOptionId,
          budget: 5_000,
          format_ids: [legacyFormat],
        }],
      }) as {
        result?: {
          structuredContent?: {
            packages?: Array<Record<string, unknown>>;
            affected_packages?: Array<Record<string, unknown>>;
            adcp_error?: unknown;
          };
        };
      };
      expect(updated.result?.structuredContent?.adcp_error, JSON.stringify(updated)).toBeUndefined();
      const added = updated.result?.structuredContent?.packages?.find(pkg => pkg.package_id === 'pkg-1');
      expect(added?.format_ids).toEqual([legacyFormat]);
      expect(added).not.toHaveProperty('format_option_refs');
      const affected = updated.result?.structuredContent?.affected_packages
        ?.find(pkg => pkg.package_id === 'pkg-1');
      expect(affected?.format_ids).toEqual([legacyFormat]);
      expect(affected).not.toHaveProperty('format_option_refs');
      expect(JSON.stringify(updated.result?.structuredContent)).not.toContain('__selected_legacy_format_ids');

      const read = await callTenantTool(url, 74, 'get_media_buys', {
        adcp_version: '3.0',
        account,
        media_buy_ids: [mediaBuyId],
      }) as {
        result?: { structuredContent?: { media_buys?: Array<{ packages?: Array<Record<string, unknown>> }> } };
      };
      const packages = read.result?.structuredContent?.media_buys?.[0]?.packages;
      expect(packages).toHaveLength(2);
      expect(packages?.every(pkg => JSON.stringify(pkg.format_ids) === JSON.stringify([legacyFormat]))).toBe(true);
      expect(packages?.every(pkg => !Object.hasOwn(pkg, 'format_option_refs'))).toBe(true);
      expect(JSON.stringify(read.result?.structuredContent)).not.toContain('__selected_legacy_format_ids');
    } finally {
      await close();
    }
  }, 30000);

  it('projects the selected legacy tuple rather than its informational echo at the native sales boundary', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'selected-legacy-native-package.example' },
        operator: 'pinnacle-agency.example',
      };
      const productId = 'selected_legacy_native_package';
      const pricingOptionId = 'selected_legacy_native_package_cpm';
      const mediaBuyId = 'mb_selected_legacy_native_package';
      const selectedLegacyFormat = {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_300x250_image',
        width: 300,
        height: 250,
      };
      const informationalLegacyFormat = {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'display_728x90_image',
        width: 728,
        height: 90,
      };
      const selectedOptionId = projectV1ProductToV2({
        product_id: productId,
        name: productId,
        description: productId,
        format_ids: [selectedLegacyFormat],
      }).v2.format_options?.[0]?.format_option_id;
      expect(selectedOptionId).toBeTypeOf('string');

      // Persist the compatibility handler's intentionally divergent state
      // directly. The native request projector correctly drops informational
      // format_ids when option refs are also present, so a routed create cannot
      // manufacture this legacy record for the read-boundary regression.
      await runWithSessionContext(async () => {
        const session = await getSession(sessionKeyFromArgs({ account }, 'open'));
        session.mediaBuys.set(mediaBuyId, {
          mediaBuyId,
          accountRef: account,
          brandRef: account.brand,
          status: 'active',
          currency: 'USD',
          packages: [{
            packageId: 'pkg-divergent-legacy-selector',
            productId,
            pricingOptionId,
            budget: 10_000,
            paused: false,
            startTime: '2027-06-01T00:00:00Z',
            endTime: '2027-07-01T00:00:00Z',
            formatIds: [informationalLegacyFormat],
            selectedLegacyFormatIds: [selectedLegacyFormat],
            creativeAssignments: [],
          }],
          startTime: '2027-06-01T00:00:00Z',
          endTime: '2027-07-01T00:00:00Z',
          revision: 1,
          confirmedAt: '2027-05-01T00:00:00Z',
          createdAt: '2027-05-01T00:00:00Z',
          updatedAt: '2027-05-01T00:00:00Z',
          history: [],
        });
        await flushDirtySessions();
      });

      const read = await callTenantTool(url, 77, 'get_media_buys', {
        account,
        media_buy_ids: [mediaBuyId],
      }) as {
        result?: {
          structuredContent?: {
            media_buys?: Array<{ packages?: Array<Record<string, unknown>> }>;
            adcp_error?: unknown;
          };
        };
      };
      expect(read.result?.structuredContent?.adcp_error, JSON.stringify(read)).toBeUndefined();
      const readPackage = read.result?.structuredContent?.media_buys?.[0]?.packages?.[0];
      expect(readPackage?.format_option_refs).toEqual([
        { scope: 'product', format_option_id: selectedOptionId },
      ]);
      expect(readPackage).not.toHaveProperty('format_ids');
      expect(JSON.stringify(read.result?.structuredContent)).not.toContain('__selected_legacy_format_ids');
      expect(JSON.stringify(read.result?.structuredContent)).not.toContain(informationalLegacyFormat.id);
    } finally {
      await close();
    }
  }, 30000);

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
              account: {
                brand: { domain: 'tenant-seed.example' },
                operator: 'pinnacle-agency.example',
                sandbox: true,
              },
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
              account: {
                brand: { domain: 'tenant-seed.example' },
                operator: 'pinnacle-agency.example',
                sandbox: true,
              },
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
              account: {
                brand: { domain: 'tenant-seed.example' },
                operator: 'pinnacle-agency.example',
                sandbox: true,
              },
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
          supported_versions: ['3.0', '3.1-beta.5', '3.1-beta.7', '3.1-rc.4', '3.1-rc.6', '3.1-rc.7', '3.1-rc.8', '3.1-rc.9', '3.1-rc.10', '3.1-rc.14', '3.1-rc.15', '3.2-beta.0'],
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
      expect(scenarios).not.toContain('seed_product');
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
      expect(listed.result?.structuredContent?.scenarios).toEqual(SALES_THREE_ZERO_COMPLY_SCENARIOS);
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

  it('projects post-3.0 creative format parameters out of 3.0 tenant responses', async () => {
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/creative/mcp`;
      await initializeTenant(url);
      const body = await callTenantTool(url, 2, 'list_creative_formats', {
        format_ids: [{ agent_url: baseUrl, id: 'display_image' }],
      }) as {
        result?: { structuredContent?: { formats?: Array<{ accepts_parameters?: string[] }> } };
      };
      expect(body.result?.structuredContent?.formats?.[0]?.accepts_parameters).toEqual(['dimensions']);
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

  it('does not expose the post-3.0 brand compliance controller in 3.0 storyboard compat mode', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/brand/mcp`;
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
      expect(toolNames).not.toContain('comply_test_controller');
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

      const builderUrl = `${baseUrl}/creative-builder/mcp`;
      await initializeTenant(builderUrl);
      const builderCapabilities = await callTenantTool(builderUrl, 3, 'get_adcp_capabilities', {}) as {
        result?: { structuredContent?: { specialisms?: string[] } };
      };
      expect(builderCapabilities.result?.structuredContent?.specialisms).not.toContain('creative-transformers');
    } finally {
      await close();
    }
  }, 30000);

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

  it('SI Chat Protocol: full lifecycle — get-offering → initiate (token) → send → terminate (idempotent)', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/si/mcp`;
      await initializeTenant(url);

      // Step 1: get offering and capture the offering_token
      const getOfferingResp = await callTenantTool(url, 2, 'si_get_offering', {
        offering_id: 'offer_sandbox_001',
      }) as {
        result?: {
          structuredContent?: {
            available?: boolean;
            offering_token?: string;
            offering?: { offering_id?: string; brand?: { name?: string } };
          };
        };
      };
      const offeringToken = getOfferingResp.result?.structuredContent?.offering_token;
      expect(getOfferingResp.result?.structuredContent?.available).toBe(true);
      expect(offeringToken).toBe('tok_offer_sandbox_001_sandbox');
      expect(getOfferingResp.result?.structuredContent?.offering?.brand?.name).toBe('BrandCo');

      // Step 2: initiate session using offering_token — token must be authoritative
      const initiateResp = await callTenantTool(url, 3, 'si_initiate_session', {
        idempotency_key: 'tenant-si-initiate-0001',
        offering_token: offeringToken,
        intent: 'Browse products and learn about the catalog.',
        identity: { consent_granted: true },
      }) as {
        result?: {
          structuredContent?: {
            session_id?: string;
            session_status?: string;
            response?: { message?: string; ui_elements?: unknown[] };
            negotiated_capabilities?: { rich_cards?: boolean };
          };
        };
      };
      const sessionId = initiateResp.result?.structuredContent?.session_id;
      expect(sessionId).toBeDefined();
      expect(initiateResp.result?.structuredContent?.session_status).toBe('active');
      expect(typeof initiateResp.result?.structuredContent?.response?.message).toBe('string');
      expect(initiateResp.result?.structuredContent?.negotiated_capabilities?.rich_cards).toBe(true);

      // Step 3: send a message and verify canonical shape (session_id + session_status required)
      const sendResp = await callTenantTool(url, 4, 'si_send_message', {
        idempotency_key: 'tenant-si-send-0000001',
        session_id: sessionId,
        message: 'Show me your most popular products.',
      }) as {
        result?: {
          structuredContent?: {
            session_id?: string;
            session_status?: string;
            response?: { message?: string; ui_elements?: unknown[] };
          };
        };
      };
      expect(sendResp.result?.structuredContent?.session_id).toBe(sessionId);
      expect(sendResp.result?.structuredContent?.session_status).toBe('active');
      expect(Array.isArray(sendResp.result?.structuredContent?.response?.ui_elements)).toBe(true);

      // Step 4: terminate the session
      const terminateResp1 = await callTenantTool(url, 5, 'si_terminate_session', {
        session_id: sessionId,
        reason: 'user_exit',
      }) as {
        result?: {
          structuredContent?: {
            session_id?: string;
            terminated?: boolean;
            session_status?: string;
            reason?: string;
          };
        };
      };
      expect(terminateResp1.result?.structuredContent?.session_id).toBe(sessionId);
      expect(terminateResp1.result?.structuredContent?.terminated).toBe(true);
      expect(terminateResp1.result?.structuredContent?.session_status).toBe('terminated');
      expect(terminateResp1.result?.structuredContent?.reason).toBe('user_exit');

      // Step 5: idempotency — second terminate must return identical result (no new checkout token)
      const terminateResp2 = await callTenantTool(url, 6, 'si_terminate_session', {
        session_id: sessionId,
        reason: 'user_exit',
      }) as {
        result?: {
          structuredContent?: {
            session_id?: string;
            terminated?: boolean;
            session_status?: string;
            reason?: string;
          };
        };
      };
      expect(terminateResp2.result?.structuredContent).toEqual(terminateResp1.result?.structuredContent);

      // Step 6: send after termination must return SESSION_TERMINATED with session_id + session_status
      const sendAfterTerminate = await callTenantTool(url, 7, 'si_send_message', {
        idempotency_key: 'tenant-si-send-0000002',
        session_id: sessionId,
        message: 'Still there?',
      }) as {
        result?: {
          structuredContent?: { adcp_error?: { code?: string } };
        };
      };
      expect(sendAfterTerminate.result?.structuredContent?.adcp_error?.code).toBe('SESSION_TERMINATED');
    } finally {
      await close();
    }
  }, 20000);
  it('keeps get_products compatible while exposing independent AdCP 3.2 split tasks', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-products-idempotency.example' },
        operator: 'tenant-products-idempotency.example',
      };
      const payload = {
        idempotency_key: 'tenant-products-idempotency-0001',
        adcp_version: '3.2-beta.0',
        buying_mode: 'wholesale',
        account,
      };

      const listResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const listBody = await listResponse.json() as {
        result?: {
          tools?: Array<{
            name?: string;
            inputSchema?: {
              properties?: Record<string, Record<string, unknown>>;
              required?: string[];
              $defs?: Record<string, Record<string, unknown>>;
            };
            annotations?: Record<string, unknown>;
            execution?: { taskSupport?: string };
          }>;
        };
      };
      const discovered = listBody.result?.tools?.find(tool => tool.name === 'get_products');
      expect(discovered?.inputSchema?.required).not.toContain('idempotency_key');
      expect(discovered?.inputSchema?.properties?.idempotency_key).toMatchObject({
        type: 'string',
        minLength: 16,
        maxLength: 255,
        pattern: '^[A-Za-z0-9_.:-]{16,255}$',
      });
      expect(discovered?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });

      expect(listBody.result?.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
        'list_products',
        'request_proposals',
        'refine_proposals',
        'decline_proposals',
      ]));
      const listAlias = listBody.result?.tools?.find(tool => tool.name === 'list_products');
      const recommendAlias = listBody.result?.tools?.find(tool => tool.name === 'request_proposals');
      expect(listAlias?.execution).toEqual({ taskSupport: 'forbidden' });
      expect(listAlias?.inputSchema).toMatchObject({ dependencies: { if_pricing_version: ['if_feed_version'] } });
      expect(recommendAlias?.execution).toEqual({ taskSupport: 'optional' });
      expect(recommendAlias?.inputSchema).toMatchObject({
        properties: { brief: { type: 'string', minLength: 1 } },
      });
      const refineAlias = listBody.result?.tools?.find(tool => tool.name === 'refine_proposals');
      expect(refineAlias?.inputSchema?.properties?.refinements).toMatchObject({
        type: 'array',
        minItems: 1,
        items: { $ref: '#/$defs/media-buy~1proposal-refinement.json' },
      });
      expect(refineAlias?.inputSchema?.$defs?.['media-buy/proposal-refinement.json'])
        .toMatchObject({
          type: 'object',
          required: ['proposal_id'],
          properties: { action: { enum: ['revise', 'finalize'] } },
          oneOf: expect.any(Array),
        });

      const keylessLegacy = await callTenantTool(url, 3, 'get_products', {
        buying_mode: 'wholesale',
        account,
      }) as { result?: { structuredContent?: { products?: unknown[] } } };
      expect(keylessLegacy.result?.structuredContent?.products?.length).toBeGreaterThan(0);

      const invalidKeylessLegacy = await callTenantTool(url, 31, 'get_products', {
        buying_mode: 'not-a-mode',
        account,
      }) as { result?: { structuredContent?: { adcp_error?: { code?: string; field?: string } } } };
      expect(invalidKeylessLegacy.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'buying_mode',
      });

      const invalidKeylessList = await callTenantTool(url, 32, 'list_products', {
        brand: account.brand,
        max_results: 0,
      }) as { result?: { structuredContent?: { adcp_error?: { code?: string; field?: string } } } };
      expect(invalidKeylessList.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'max_results',
      });

      const malformedAccount = await callTenantTool(url, 33, 'list_products', {
        account: 'not-an-account',
      }) as { error?: { code?: number; data?: { field?: string } } };
      expect(malformedAccount.error).toMatchObject({
        code: -32602,
        data: { field: 'account' },
      });

      const unsupportedAliasVersion = await callTenantTool(url, 34, 'list_products', {
        brand: account.brand,
        adcp_version: '99.0',
      }) as {
        result?: {
          structuredContent?: {
            adcp_error?: { code?: string; field?: string; details?: { supported_versions?: string[] } };
          };
        };
      };
      expect(unsupportedAliasVersion.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'VERSION_UNSUPPORTED',
        field: 'adcp_version',
        details: { supported_versions: expect.any(Array) },
      });

      const first = await callTenantTool(url, 4, 'get_products', payload) as {
        result?: { structuredContent?: { products?: unknown[]; replayed?: boolean } };
      };
      const replay = await callTenantTool(url, 5, 'get_products', payload) as {
        result?: { structuredContent?: { products?: unknown[]; replayed?: boolean } };
      };
      expect(first.result?.structuredContent?.products?.length).toBeGreaterThan(0);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      expect(replay.result?.structuredContent?.products).toEqual(first.result?.structuredContent?.products);
      expect(replay.result?.structuredContent?.replayed).toBe(true);

      const aliasReplay = await callTenantTool(url, 6, 'list_products', {
        adcp_version: payload.adcp_version,
        brand: account.brand,
      }) as { result?: { structuredContent?: { adcp_version?: string; products?: unknown[]; replayed?: boolean } } };
      expect(aliasReplay.result?.structuredContent).not.toHaveProperty('adcp_error');
      expect(aliasReplay.result?.structuredContent?.adcp_version).toBe('3.2-beta.0');
      expect(aliasReplay.result?.structuredContent?.products).toEqual(first.result?.structuredContent?.products);
      expect(aliasReplay.result?.structuredContent?.replayed).toBeUndefined();

      const taskKey = 'tenant-products-task-receipt-0001';
      const taskCall = async (id: number): Promise<Record<string, unknown>> => {
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
            params: {
              name: 'request_proposals',
              arguments: {
                idempotency_key: taskKey,
                brand: account.brand,
                brief: 'Reach sports fans',
              },
              task: { ttl: 120000 },
            },
          }),
        });
        return response.json() as Promise<Record<string, unknown>>;
      };
      const taskFirst = await taskCall(62) as { result?: { task?: { taskId?: string; status?: string } } };
      const taskReplay = await taskCall(63) as { result?: { task?: { taskId?: string; status?: string } } };
      expect(taskFirst.result?.task).toMatchObject({ status: 'completed', taskId: expect.any(String) });
      expect(taskReplay.result?.task?.taskId).toBe(taskFirst.result?.task?.taskId);

      const taskGetResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 64,
          method: 'tasks/get',
          params: { taskId: taskFirst.result?.task?.taskId, adcp_version: '3.2-beta.0' },
        }),
      });
      const taskGet = await taskGetResponse.json() as { result?: { taskId?: string; status?: string } };
      expect(taskGet.result).toMatchObject({ taskId: taskFirst.result?.task?.taskId, status: 'completed' });

      const taskListResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 641,
          method: 'tasks/list',
          params: { adcp_version: '3.2-beta.0' },
        }),
      });
      const taskList = await taskListResponse.json() as { result?: { tasks?: Array<{ taskId?: string }> } };
      expect(taskList.result?.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskId: taskFirst.result?.task?.taskId }),
      ]));

      const forbiddenListTask = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 65,
          method: 'tools/call',
          params: {
            name: 'list_products',
            arguments: { brand: account.brand },
            task: { ttl: 120000 },
          },
        }),
      });
      const forbiddenListTaskBody = await forbiddenListTask.json() as { error?: { code?: number; message?: string } };
      expect(forbiddenListTaskBody.error?.message).toContain('does not support task augmentation');

      const missingAliasKey = await callTenantTool(url, 61, 'request_proposals', {
        brand: account.brand,
        brief: 'Reach sports fans',
      }) as { error?: { code?: number; data?: { field?: string } } };
      expect(missingAliasKey.error).toMatchObject({
        code: -32602,
        data: { field: 'idempotency_key' },
      });

      const invalid = await callTenantTool(url, 7, 'get_products', {
        ...payload,
        buying_mode: 'not-a-mode',
      }) as { result?: { structuredContent?: { adcp_error?: { code?: string; field?: string } } } };
      expect(invalid.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'buying_mode',
      });

      const mixedFinalize = await callTenantTool(url, 8, 'get_products', {
        ...payload,
        buying_mode: 'refine',
        refine: [
          { scope: 'proposal', action: 'finalize', proposal_id: 'pinnacle_cross_channel' },
          { scope: 'proposal', action: 'include', proposal_id: 'pinnacle_cross_channel' },
        ],
      }) as { result?: { structuredContent?: { adcp_error?: { code?: string; field?: string } } } };
      expect(mixedFinalize.result?.structuredContent?.adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        field: 'refine[1]',
      });

      const conflict = await callTenantTool(url, 9, 'get_products', {
        ...payload,
        buying_mode: 'brief',
        brief: 'different logical request',
      }) as { result?: { structuredContent?: { adcp_error?: Record<string, unknown> } } };
      const conflictEnvelope = conflict.result?.structuredContent?.adcp_error;
      expect(conflictEnvelope?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(conflictEnvelope).not.toHaveProperty('recovery');
      expect(Object.keys(conflictEnvelope ?? {}).every(key => [
        'code', 'message', 'status', 'retry_after', 'correlation_id', 'request_id', 'operation_id',
      ].includes(key))).toBe(true);
    } finally {
      await close();
    }
  }, 15000);

  it('adapts omitted get_products keys only on the frozen 3.0 compatibility route', async () => {
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const listResponse = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      const listBody = await listResponse.json() as {
        result?: {
          tools?: Array<{
            name?: string;
            inputSchema?: {
              properties?: Record<string, unknown>;
              required?: string[];
            };
            annotations?: Record<string, unknown>;
          }>;
        };
      };
      const discovered = listBody.result?.tools?.find(tool => tool.name === 'get_products');
      expect(discovered?.inputSchema?.properties).not.toHaveProperty('idempotency_key');
      expect(discovered?.inputSchema?.required).not.toContain('idempotency_key');
      expect(discovered?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });

      const account = {
        brand: { domain: 'tenant-products-legacy.example' },
        operator: 'tenant-products-legacy.example',
      };
      const payload = { buying_mode: 'wholesale', account };
      const first = await callTenantTool(url, 3, 'get_products', payload) as {
        result?: { structuredContent?: { products?: unknown[]; replayed?: boolean } };
      };
      const replay = await callTenantTool(url, 4, 'get_products', payload) as {
        result?: { structuredContent?: { products?: unknown[]; replayed?: boolean } };
      };
      expect(first.result?.structuredContent?.products?.length).toBeGreaterThan(0);
      expect(first.result?.structuredContent?.replayed).toBeUndefined();
      expect(replay.result?.structuredContent?.products).toEqual(first.result?.structuredContent?.products);
      expect(replay.result?.structuredContent?.replayed).toBe(true);

      const changed = await callTenantTool(url, 5, 'get_products', {
        buying_mode: 'brief',
        brief: 'A different frozen 3.0 request',
        account,
      }) as { result?: { structuredContent?: { products?: unknown[]; replayed?: boolean } } };
      expect(changed.result?.structuredContent?.products).toBeDefined();
      expect(changed.result?.structuredContent?.replayed).toBeUndefined();
    } finally {
      await close();
    }
  }, 15000);

  it('replays v6 get_products advisory-success responses', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-products-advisory.example' },
        operator: 'tenant-products-advisory.example',
        sandbox: true,
      };
      const directive = await callTenantTool(url, 2, 'comply_test_controller', {
        account,
        scenario: 'force_upstream_unavailable',
        params: { tool: 'get_products', upstream_name: 'catalog-test' },
      }) as { result?: { structuredContent?: { success?: boolean } } };
      expect(directive.result?.structuredContent?.success).toBe(true);

      const key = 'tenant-products-advisory-replay-0001';
      const first = await callTenantTool(url, 3, 'get_products', {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account,
        context: { correlation_id: 'tenant-advisory-first' },
      }) as {
        result?: { structuredContent?: { products?: unknown[]; errors?: Array<{ code?: string }>; context?: { correlation_id?: string } } };
      };
      const replay = await callTenantTool(url, 4, 'get_products', {
        idempotency_key: key,
        buying_mode: 'wholesale',
        account,
        context: { correlation_id: 'tenant-advisory-retry' },
      }) as {
        result?: { structuredContent?: { products?: unknown[]; errors?: Array<{ code?: string }>; replayed?: boolean; context?: { correlation_id?: string } } };
      };
      expect(first.result?.structuredContent?.products?.length).toBeGreaterThan(0);
      expect(first.result?.structuredContent?.errors?.[0]?.code).toBe('STALE_RESPONSE');
      expect(first.result?.structuredContent?.context?.correlation_id).toBe('tenant-advisory-first');
      expect(replay.result?.structuredContent?.replayed).toBe(true);
      expect(replay.result?.structuredContent?.products).toEqual(first.result?.structuredContent?.products);
      expect(replay.result?.structuredContent?.errors).toEqual(first.result?.structuredContent?.errors);
      expect(replay.result?.structuredContent?.context?.correlation_id).toBe('tenant-advisory-retry');
    } finally {
      await close();
    }
  }, 15000);

  it('persists v6 proposal finalization before publishing its replay', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const account = {
        brand: { domain: 'tenant-products-finalize.example' },
        operator: 'tenant-products-finalize.example',
      };
      const brief = await callTenantTool(url, 2, 'get_products', {
        idempotency_key: 'tenant-products-brief-finalize-0001',
        buying_mode: 'brief',
        brief: 'cross-channel news video and display',
        account,
      }) as {
        result?: { structuredContent?: { proposals?: Array<Record<string, unknown>> } };
      };
      const draft = brief.result?.structuredContent?.proposals
        ?.find(proposal => proposal.proposal_status === 'draft');
      expect(draft?.proposal_id).toBeTruthy();

      const finalizePayload = {
        idempotency_key: 'tenant-products-finalize-replay-0001',
        buying_mode: 'refine',
        account,
        refine: [{ scope: 'proposal', action: 'finalize', proposal_id: draft!.proposal_id }],
      };
      const finalized = await callTenantTool(url, 3, 'get_products', finalizePayload) as {
        result?: { structuredContent?: { proposals?: Array<Record<string, unknown>>; replayed?: boolean } };
      };
      const committed = finalized.result?.structuredContent?.proposals
        ?.find(proposal => proposal.proposal_id === draft!.proposal_id);
      expect(committed).toMatchObject({ proposal_status: 'committed' });
      expect(committed?.expires_at).toBeTruthy();
      expect((committed?.insertion_order as Record<string, unknown> | undefined)?.io_id).toBeTruthy();

      // A fresh logical request must reload the committed proposal from the
      // durable session rather than allocating a new hold/insertion order.
      const reloaded = await callTenantTool(url, 4, 'get_products', {
        ...finalizePayload,
        idempotency_key: 'tenant-products-finalize-reload-0001',
      }) as {
        result?: { structuredContent?: { proposals?: Array<Record<string, unknown>> } };
      };
      const reloadedProposal = reloaded.result?.structuredContent?.proposals
        ?.find(proposal => proposal.proposal_id === draft!.proposal_id);
      expect(reloadedProposal).toEqual(committed);

      const replay = await callTenantTool(url, 5, 'get_products', finalizePayload) as {
        result?: { structuredContent?: { proposals?: Array<Record<string, unknown>>; replayed?: boolean } };
      };
      const replayedProposal = replay.result?.structuredContent?.proposals
        ?.find(proposal => proposal.proposal_id === draft!.proposal_id);
      expect(replay.result?.structuredContent?.replayed).toBe(true);
      expect(replayedProposal).toEqual(committed);
    } finally {
      await close();
    }
  }, 15000);
});
