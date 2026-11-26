/**
 * #8181 introduced a hosted opt-in preview of the AdCP 3.3 prerelease; only an
 * exact pin was served it (versioning.mdx, "Pre-release pins"). The preview
 * retired at 3.3 GA: its surfaces are the stable 3.3 line, and the last
 * preview, 3.3-rc.3, stays served to an exact pin as a retained checkpoint on
 * the stable registries. The machinery stays, so a later preview is one
 * constant (candidate-version.ts).
 *
 * The kill switch is covered in training-agent-preview-kill-switch.test.ts,
 * response shapes in src/training-agent/tenants/served-release-shape.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { ADCP_VERSION as SDK_ADCP_VERSION, SingleAgentClient, closeMCPConnections } from '@adcp/sdk';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'preview-version-test-token';

import {
  TRAINING_AGENT_HOSTED_PREVIEW,
  TRAINING_AGENT_PREVIEW_ADCP_VERSION,
  TRAINING_AGENT_PREVIEW_KILL_SWITCH,
  TRAINING_AGENT_SERVES_HOSTED_PREVIEW,
  requestPinsPreview,
  trainingAgentPreviewVersion,
} from '../../src/training-agent/candidate-version.js';
import { PREVIEW_SCHEMA_BUNDLE, RETAINED_SCHEMA_BUNDLES } from '../../src/training-agent/schema-compat.js';
import { resolveServedAdcpVersion } from '../../src/training-agent/task-handlers.js';
import {
  TRAINING_AGENT_CURRENT_ADCP_VERSION,
  TRAINING_AGENT_REGISTERS_ACCOUNT_SURFACES_33,
  TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION,
  TRAINING_AGENT_STABLE_REGISTRY_VERSIONS,
  TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS,
} from '../../src/training-agent/types.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';

/** The last hosted preview, now a retained exact pin. */
const RETAINED = TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION;
const CURRENT = TRAINING_AGENT_CURRENT_ADCP_VERSION;
const TOKEN = 'preview-version-test-token';

type Structured = Record<string, any>;

describe('hosted 3.3 preview retirement', () => {
  it('serves no hosted preview, in every runtime', () => {
    expect(RETAINED).toBe('3.3-rc.3');
    expect(CURRENT).toBe('3.3');
    expect(TRAINING_AGENT_HOSTED_PREVIEW).toBeUndefined();
    expect(TRAINING_AGENT_PREVIEW_ADCP_VERSION).toBeUndefined();
    expect(TRAINING_AGENT_SERVES_HOSTED_PREVIEW).toBe(false);
    expect(PREVIEW_SCHEMA_BUNDLE).toBeUndefined();
    for (const NODE_ENV of ['production', 'development', 'test', undefined]) {
      expect(trainingAgentPreviewVersion({ NODE_ENV })).toBeUndefined();
    }
  });

  it('leaves the kill switch nothing to disable', () => {
    expect(TRAINING_AGENT_PREVIEW_KILL_SWITCH).toBe('TRAINING_AGENT_DISABLE_ADCP_PREVIEW');
    for (const value of ['1', 'true', 'TRUE', ' true ', '0', 'false', '']) {
      expect(trainingAgentPreviewVersion({ NODE_ENV: 'production', [TRAINING_AGENT_PREVIEW_KILL_SWITCH]: value })).toBeUndefined();
    }
  });

  it('still yields to a trusted storyboard candidate', () => {
    const candidate = { NODE_ENV: 'test', ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1', ADCP_TRAINING_CANDIDATE_VERSION: '3.3-rc.4' };
    expect(trainingAgentPreviewVersion(candidate)).toBe('3.3-rc.4');
    // The kill switch governs only a hosted preview.
    expect(trainingAgentPreviewVersion({ ...candidate, [TRAINING_AGENT_PREVIEW_KILL_SWITCH]: '1' })).toBe('3.3-rc.4');
    // Candidate mode never applies outside the test runtime.
    expect(trainingAgentPreviewVersion({ ...candidate, NODE_ENV: 'production' })).toBeUndefined();
  });

  it('lists the retained preview and the 3.3 line once each, with 3.2 explicit', () => {
    for (const version of [RETAINED, CURRENT, '3.2']) {
      expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(entry => entry === version), version).toHaveLength(1);
    }
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(version => version.startsWith('3.3'))).toEqual([RETAINED, CURRENT]);
    // Oldest first: the retained checkpoint precedes its GA.
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.slice(-3)).toEqual(['3.2', RETAINED, CURRENT]);
  });

  it('ships the retained preview as a committed schema bundle', () => {
    expect(RETAINED_SCHEMA_BUNDLES[RETAINED]).toBe('3.3.0-rc.3');
  });

  it('serves 3.3 to every caller below an exact pin on the v5 resolver', () => {
    // The retained preview is served only to its exact pin.
    expect(resolveServedAdcpVersion({ adcp_version: RETAINED })).toEqual({ ok: true, servedVersion: RETAINED });
    // Major-only and release pins land on the 3.3 line, never on the prerelease.
    expect(resolveServedAdcpVersion({ adcp_major_version: 3 })).toEqual({ ok: true, servedVersion: '3.3' });
    for (const adcp_version of ['3.3', '3.4', '3.9']) {
      expect(resolveServedAdcpVersion({ adcp_version })).toEqual({ ok: true, servedVersion: '3.3' });
    }
    expect(resolveServedAdcpVersion({ adcp_version: '3.2' })).toEqual({ ok: true, servedVersion: '3.2' });
    // Other prereleases of the line are matched exactly, so they are refused.
    for (const adcp_version of ['3.3-beta.1', '3.3-rc.0', '3.3-rc.2', '3.3-rc.4']) {
      expect(resolveServedAdcpVersion({ adcp_version }).ok, adcp_version).toBe(false);
    }
    // The unpinned default is the deliberate 3.0.
    const unpinned = resolveServedAdcpVersion({});
    expect(unpinned.ok && unpinned.servedVersion).toBe('3.0');
  });

  it('builds no preview registry: the stable registries negotiate every listed release', () => {
    expect([...TRAINING_AGENT_STABLE_REGISTRY_VERSIONS]).toEqual([...TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS]);
    // The experimental 3.3 account tools register wherever 3.3 is current.
    expect(TRAINING_AGENT_REGISTERS_ACCOUNT_SURFACES_33).toBe(true);
  });

  it('selects a preview registry only for an exact pin to the preview it is given', () => {
    const call = (args: Record<string, unknown>) => ({ method: 'tools/call', params: { name: 'get_products', arguments: args } });
    // No hosted preview is configured, so no request pins it.
    expect(requestPinsPreview(call({ adcp_version: RETAINED }))).toBe(false);
    expect(requestPinsPreview({ method: 'tools/list', params: { _meta: { adcp_version: RETAINED } } })).toBe(false);
    // The pure matcher still follows an explicitly supplied preview.
    expect(requestPinsPreview(call({ adcp_version: RETAINED }), RETAINED)).toBe(true);
    expect(requestPinsPreview({ method: 'tools/list', params: { _meta: { adcp_version: RETAINED } } }, RETAINED)).toBe(true);
    expect(requestPinsPreview({ method: 'tools/list', params: { adcp_version: RETAINED } }, RETAINED)).toBe(true);
    for (const args of [{}, { adcp_major_version: 3 }, { adcp_version: '3.2' }, { adcp_version: '3.3' }, { adcp_version: '3.3-rc.0' }, { adcp_version: '3.3.0-rc.3' }]) {
      expect(requestPinsPreview(call(args), RETAINED), JSON.stringify(args)).toBe(false);
    }
    expect(requestPinsPreview({ method: 'tools/list', params: {} }, RETAINED)).toBe(false);
    expect(requestPinsPreview({ method: 'initialize', params: { adcp_version: RETAINED } }, RETAINED)).toBe(false);
    expect(requestPinsPreview(call({ adcp_version: RETAINED }), undefined)).toBe(false);
  });
});

describe('retained 3.3-rc.3 negotiation over MCP', () => {
  let server: http.Server;
  let baseUrl: string;
  let rpcId = 0;

  const rpc = async (path: string, method: string, params?: Record<string, unknown>) => {
    rpcId += 1;
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params && { params }) }),
    });
    return response.json() as Promise<Record<string, any>>;
  };
  const call = async (path: string, name: string, args: Record<string, unknown>): Promise<Structured> => {
    const envelope = await rpc(path, 'tools/call', { name, arguments: args });
    return (envelope.result?.structuredContent ?? { __envelope: envelope }) as Structured;
  };

  beforeAll(async () => {
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ limit: '5mb', verify: (req, _res, body) => {
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

  const ROUTES = ['/mcp', '/sales/mcp', '/signals/mcp', '/governance/mcp', '/creative/mcp', '/creative-builder/mcp', '/brand/mcp', '/si/mcp'];

  it.each(ROUTES)('serves 3.3 to unpinned, major-only and "3.3" callers and the retained preview only to its exact pin on %s', async route => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ adcp_version: RETAINED }, RETAINED],
      // Unpinned callers keep each route's default: 3.0 on the v5 route, the
      // current 3.3 line on tenant routes.
      [{}, route === '/mcp' ? '3.0' : CURRENT],
      [{ adcp_major_version: 3 }, CURRENT],
      [{ adcp_version: CURRENT }, CURRENT],
      [{ adcp_version: '3.4' }, CURRENT],
      [{ adcp_version: '3.2' }, '3.2'],
      [{ adcp_version: '3.1' }, '3.1'],
      [{ adcp_version: '3.0' }, '3.0'],
    ];
    for (const [args, expected] of cases) {
      const result = await call(route, 'get_adcp_capabilities', args);
      expect(result.adcp_error, `${route} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 300)}`).toBeUndefined();
      expect(result.adcp_version, `${route} ${JSON.stringify(args)}`).toBe(expected);
      // Capability discovery lists the retained preview once, beside 3.3 and
      // 3.2 (versioning.mdx: the buyer reads supported_versions, then pins).
      for (const version of [RETAINED, CURRENT, '3.2']) {
        expect(result.adcp.supported_versions.filter((entry: string) => entry === version), `${route} ${version}`).toHaveLength(1);
      }
      // No other 3.3 prerelease is served.
      expect(result.adcp.supported_versions.filter((version: string) => version.startsWith('3.3'))).toEqual([RETAINED, CURRENT]);
    }
    // A 3.3 prerelease the agent does not list never selects the retained
    // checkpoint: not the earlier candidates, nor a later one.
    for (const adcp_version of ['3.3-rc.0', '3.3-rc.2', '3.3-rc.4']) {
      const result = await call(route, 'get_adcp_capabilities', { adcp_version });
      expect(result.adcp_version, `${route} ${adcp_version}: ${JSON.stringify(result).slice(0, 300)}`).not.toBe(RETAINED);
      expect(result.adcp_version).not.toBe(adcp_version);
    }
  }, 120_000);

  it('is the release a default client on the installed @adcp/sdk negotiates', async () => {
    // @adcp/sdk 17.0.0 negotiates the 3.3 GA bundle it ships. A release it does
    // not bundle would leave every SDK buyer on an older line (candidate-version.ts).
    expect(SDK_ADCP_VERSION).toBe('3.3.0');
    const client = new SingleAgentClient({
      id: 'preview-sdk-buyer',
      name: 'Preview SDK buyer',
      agent_uri: `${baseUrl}/sales`,
      protocol: 'mcp',
      auth_token: TOKEN,
    });
    try {
      const capabilities = await client.getAdcpCapabilities({});
      expect(capabilities.success, JSON.stringify(capabilities.error)).toBe(true);
      expect(capabilities.data?.adcp?.supported_versions).toEqual(expect.arrayContaining([RETAINED, CURRENT, '3.2']));
      const accounts = await client.listAccounts({});
      expect(accounts.success, JSON.stringify(accounts.error)).toBe(true);
      // Served at 3.3, with no downshift to an older release.
      expect(accounts.metadata.adcpVersion).toBe(CURRENT);
      expect(accounts.metadata.negotiatedAdcpVersion).toBeUndefined();
    } finally {
      await closeMCPConnections();
    }
  }, 60_000);

  it('reaches the 3.3 sales surfaces at 3.3 and the retained pin, and not at 3.2', async () => {
    for (const args of [{ adcp_version: CURRENT }, { adcp_version: RETAINED }, {}]) {
      const served = await call('/sales/mcp', 'get_adcp_capabilities', args);
      expect(served.experimental_features, JSON.stringify(args)).toEqual(expect.arrayContaining(['account.requests', 'media_buy.reporting_subscriptions']));
      expect(served.account.requests, JSON.stringify(args)).toBeDefined();
      expect(served.adcp.principal.supported_sections, JSON.stringify(args)).toContain('reporting_subscriptions');
      expect(served.compliance_testing.scenarios, JSON.stringify(args)).toContain('reporting_subscription_probe');
    }
    const older = await call('/sales/mcp', 'get_adcp_capabilities', { adcp_version: '3.2' });
    expect(older.experimental_features).not.toContain('account.requests');
    expect(older.experimental_features).not.toContain('media_buy.reporting_subscriptions');
    expect(older.account.requests).toBeUndefined();
    expect(older.adcp.principal.supported_sections).not.toContain('reporting_subscriptions');
    expect(older.compliance_testing.scenarios).not.toContain('reporting_subscription_probe');

    // request_account is registered on the stable sales route and discovered at 3.3.
    for (const params of [{ _meta: { adcp_version: CURRENT } }, { _meta: { adcp_version: RETAINED } }]) {
      const listing = await rpc('/sales/mcp', 'tools/list', params);
      expect(listing.result.tools.map((tool: { name: string }) => tool.name), JSON.stringify(params)).toContain('request_account');
    }
    // A listing served below 3.3 does not advertise the 3.3 account and
    // collection tools, as before the GA bump.
    for (const params of [{ _meta: { adcp_version: '3.2' } }, { _meta: { adcp_version: '3.2-rc.7' } }]) {
      const listing = await rpc('/sales/mcp', 'tools/list', params);
      const names = listing.result.tools.map((tool: { name: string }) => tool.name);
      expect(names, JSON.stringify(params)).not.toContain('request_account');
      expect(names, JSON.stringify(params)).not.toContain('list_collections');
    }
    for (const adcp_version of [CURRENT, RETAINED]) {
      const opened = await call('/sales/mcp', 'request_account', {
        adcp_version,
        brand: { domain: `preview-open-${adcp_version}.example` },
        operator: `preview-open-${adcp_version}.example`,
        idempotency_key: `preview-version-request-account-${adcp_version}`,
      });
      expect(opened.adcp_version, adcp_version).toBe(adcp_version);
      expect(opened.request?.resolution, `${adcp_version}: ${JSON.stringify(opened).slice(0, 300)}`).toBe('created');
    }
    // Below 3.3 the tool is registered but its handler refuses the request,
    // rather than answering "Tool not found".
    const refused = await call('/sales/mcp', 'request_account', {
      adcp_version: '3.2',
      brand: { domain: 'preview-open-3-2.example' },
      operator: 'preview-open-3-2.example',
      idempotency_key: 'preview-version-request-account-3.2',
    });
    expect(refused.adcp_error?.code, JSON.stringify(refused).slice(0, 300)).toBe('UNSUPPORTED_FEATURE');
    expect(refused.request).toBeUndefined();

    // The account carries the caller's 3.3 authorization from 3.3.
    for (const adcp_version of [CURRENT, RETAINED]) {
      const accounts = await call('/sales/mcp', 'list_accounts', { adcp_version });
      expect(accounts.adcp_version, adcp_version).toBe(adcp_version);
      expect(accounts.accounts.length).toBeGreaterThan(0);
      for (const account of accounts.accounts) {
        expect(typeof account.authorization?.authorized_at, JSON.stringify(account).slice(0, 300)).toBe('string');
      }
    }
    const stableAccounts = await call('/sales/mcp', 'list_accounts', { adcp_version: '3.2' });
    for (const account of stableAccounts.accounts) {
      expect(account.authorization?.authorized_at).toBeUndefined();
      expect(account.revision).toBeUndefined();
    }

    // The reporting-subscription sandbox clock answers from 3.3.
    for (const adcp_version of [CURRENT, RETAINED]) {
      const scenarios = await call('/sales/mcp', 'comply_test_controller', { adcp_version, scenario: 'list_scenarios' });
      expect(scenarios.scenarios, adcp_version).toContain('reporting_subscription_probe');
    }
    const stableScenarios = await call('/sales/mcp', 'comply_test_controller', { adcp_version: '3.2', scenario: 'list_scenarios' });
    expect(stableScenarios.scenarios).not.toContain('reporting_subscription_probe');
  }, 120_000);

  it('resolves public sandbox account references at 3.3 and the retained pin as it does at 3.2', async () => {
    // AdCP 3.3 routes refuse account references the seller cannot resolve
    // (@adcp/sdk fail-closed resolution). The training agent's resolver is
    // reference-aware: a provisioned natural key resolves, an unprovisioned
    // one on a discovery task is ACCOUNT_NOT_FOUND, at every served release.
    const account = { brand: { domain: 'preview-sandbox.example' }, operator: 'preview-sandbox.example', sandbox: true };
    const versions = [CURRENT, RETAINED, '3.2'];
    for (const adcp_version of versions) {
      const unprovisioned = await call('/sales/mcp', 'get_products', {
        adcp_version,
        account: { ...account, brand: { domain: `unprovisioned-${adcp_version}.example` } },
        buying_mode: 'brief',
        brief: 'sports',
      });
      expect(unprovisioned.adcp_error?.code, `${adcp_version}: ${JSON.stringify(unprovisioned).slice(0, 300)}`).toBe('ACCOUNT_NOT_FOUND');
    }
    const synced = await call('/sales/mcp', 'sync_accounts', {
      adcp_version: CURRENT,
      accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
      idempotency_key: 'preview-version-sync-accounts-1',
    });
    expect(synced.accounts?.[0]?.status, JSON.stringify(synced).slice(0, 300)).toBe('active');
    for (const adcp_version of versions) {
      const products = await call('/sales/mcp', 'get_products', { adcp_version, account, buying_mode: 'brief', brief: 'sports' });
      expect(products.adcp_error, `${adcp_version}: ${JSON.stringify(products).slice(0, 300)}`).toBeUndefined();
      expect(products.adcp_version).toBe(adcp_version);
      expect(products.products.length).toBeGreaterThan(0);
      const accountId = synced.accounts[0].account_id;
      const buys = await call('/sales/mcp', 'get_media_buys', { adcp_version, account: { account_id: accountId } });
      expect(buys.adcp_error, `${adcp_version}: ${JSON.stringify(buys).slice(0, 300)}`).toBeUndefined();
    }
  }, 120_000);
});
