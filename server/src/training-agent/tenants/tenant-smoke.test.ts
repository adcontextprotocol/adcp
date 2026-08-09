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
import { clearSessions, stopSessionCleanup } from '../state.js';
import { clearSiSessions } from '../si-handlers.js';
import { getAgentUrl } from '../config.js';

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
  });

  afterEach(() => {
    clearSessions();
    clearAccountStore();
    clearSiSessions();
    stopSessionCleanup();
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

  it('serves the AdCP 3.1 dual product shape through the explicit legacy facade', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const body = await callTenantTool(url, 2, 'get_products', {
        adcp_version: '3.1',
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
});
