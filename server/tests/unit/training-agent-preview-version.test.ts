/**
 * #8181: the hosted training agent serves the published AdCP 3.3 beta as an
 * opt-in preview. Only an exact pin is served the preview; stable, major-only
 * and unpinned callers negotiate as before (versioning.mdx, "Pre-release
 * pins"). The kill switch is covered in
 * training-agent-preview-kill-switch.test.ts, response shapes in
 * src/training-agent/tenants/served-release-shape.test.ts.
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
  requestPinsPreview,
  trainingAgentPreviewVersion,
} from '../../src/training-agent/candidate-version.js';
import { resolveServedAdcpVersion } from '../../src/training-agent/task-handlers.js';
import {
  TRAINING_AGENT_STABLE_REGISTRY_VERSIONS,
  TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS,
} from '../../src/training-agent/types.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';

const PREVIEW = TRAINING_AGENT_HOSTED_PREVIEW.wireVersion;
const TOKEN = 'preview-version-test-token';

type Structured = Record<string, any>;

describe('hosted 3.3 preview selection', () => {
  it('serves the published preview by default, in every runtime', () => {
    expect(PREVIEW).toBe('3.3-beta.5');
    expect(TRAINING_AGENT_HOSTED_PREVIEW.bundle).toBe('3.3.0-beta.5');
    expect(TRAINING_AGENT_PREVIEW_ADCP_VERSION).toBe(PREVIEW);
    for (const NODE_ENV of ['production', 'development', 'test', undefined]) {
      expect(trainingAgentPreviewVersion({ NODE_ENV })).toBe(PREVIEW);
    }
  });

  it('is disabled by the kill switch', () => {
    expect(TRAINING_AGENT_PREVIEW_KILL_SWITCH).toBe('TRAINING_AGENT_DISABLE_ADCP_PREVIEW');
    for (const value of ['1', 'true', 'TRUE', ' true ']) {
      expect(trainingAgentPreviewVersion({ NODE_ENV: 'production', [TRAINING_AGENT_PREVIEW_KILL_SWITCH]: value })).toBeUndefined();
    }
    for (const value of ['0', 'false', '']) {
      expect(trainingAgentPreviewVersion({ NODE_ENV: 'production', [TRAINING_AGENT_PREVIEW_KILL_SWITCH]: value })).toBe(PREVIEW);
    }
  });

  it('yields to a trusted storyboard candidate', () => {
    const candidate = { NODE_ENV: 'test', ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1', ADCP_TRAINING_CANDIDATE_VERSION: '3.3-beta.6' };
    expect(trainingAgentPreviewVersion(candidate)).toBe('3.3-beta.6');
    // The kill switch governs only the hosted preview.
    expect(trainingAgentPreviewVersion({ ...candidate, [TRAINING_AGENT_PREVIEW_KILL_SWITCH]: '1' })).toBe('3.3-beta.6');
    // Candidate mode never applies outside the test runtime.
    expect(trainingAgentPreviewVersion({ ...candidate, NODE_ENV: 'production' })).toBe(PREVIEW);
  });

  it('lists the preview once among the supported releases', () => {
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(version => version === PREVIEW)).toHaveLength(1);
    expect(TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(version => version.startsWith('3.3'))).toEqual([PREVIEW]);
  });

  it('serves the preview only to an exact pin on the v5 resolver', () => {
    expect(resolveServedAdcpVersion({ adcp_version: PREVIEW })).toEqual({ ok: true, servedVersion: PREVIEW });
    // A major-only request is never upgraded onto a prerelease.
    expect(resolveServedAdcpVersion({ adcp_major_version: 3 })).toEqual({ ok: true, servedVersion: '3.2' });
    // A release pin never downshifts onto a prerelease.
    for (const adcp_version of ['3.3', '3.4', '3.9']) {
      expect(resolveServedAdcpVersion({ adcp_version })).toEqual({ ok: true, servedVersion: '3.2' });
    }
    // Other prereleases of the line are matched exactly, so they are refused.
    for (const adcp_version of ['3.3-beta.4', '3.3-beta.6', '3.3-rc.1']) {
      expect(resolveServedAdcpVersion({ adcp_version }).ok).toBe(false);
    }
    expect(resolveServedAdcpVersion({}).ok && resolveServedAdcpVersion({}).servedVersion).toBe('3.0');
  });

  it('sends only exact preview pins to the preview registry', () => {
    // The stable registries never negotiate the preview.
    expect(TRAINING_AGENT_STABLE_REGISTRY_VERSIONS).toEqual(
      TRAINING_AGENT_SUPPORTED_RELEASE_VERSIONS.filter(version => version !== PREVIEW),
    );
    const call = (args: Record<string, unknown>) => ({ method: 'tools/call', params: { name: 'get_products', arguments: args } });
    expect(requestPinsPreview(call({ adcp_version: PREVIEW }))).toBe(true);
    expect(requestPinsPreview({ method: 'tools/list', params: { _meta: { adcp_version: PREVIEW } } })).toBe(true);
    expect(requestPinsPreview({ method: 'tools/list', params: { adcp_version: PREVIEW } })).toBe(true);
    for (const args of [{}, { adcp_major_version: 3 }, { adcp_version: '3.2' }, { adcp_version: '3.3' }, { adcp_version: '3.3-beta.4' }, { adcp_version: '3.3.0-beta.5' }]) {
      expect(requestPinsPreview(call(args)), JSON.stringify(args)).toBe(false);
    }
    expect(requestPinsPreview({ method: 'tools/list', params: {} })).toBe(false);
    expect(requestPinsPreview({ method: 'initialize', params: { adcp_version: PREVIEW } })).toBe(false);
  });
});

describe('hosted 3.3 preview negotiation over MCP', () => {
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

  it.each(ROUTES)('advertises the preview and serves it only to an exact pin on %s', async route => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ adcp_version: PREVIEW }, PREVIEW],
      // Unpinned callers keep each route's stable default.
      [{}, route === '/mcp' ? '3.0' : '3.2'],
      [{ adcp_major_version: 3 }, '3.2'],
      [{ adcp_version: '3.2' }, '3.2'],
      [{ adcp_version: '3.3' }, '3.2'],
      [{ adcp_version: '3.4' }, '3.2'],
      [{ adcp_version: '3.1' }, '3.1'],
      [{ adcp_version: '3.0' }, '3.0'],
    ];
    for (const [args, expected] of cases) {
      const result = await call(route, 'get_adcp_capabilities', args);
      expect(result.adcp_error, `${route} ${JSON.stringify(args)}: ${JSON.stringify(result).slice(0, 300)}`).toBeUndefined();
      expect(result.adcp_version, `${route} ${JSON.stringify(args)}`).toBe(expected);
      // Capability discovery advertises the exact preview to every caller
      // (versioning.mdx: the buyer reads supported_versions, then pins).
      expect(result.adcp.supported_versions.filter((version: string) => version === PREVIEW)).toHaveLength(1);
      expect(result.adcp.supported_versions).toContain('3.2');
      expect(result.adcp.supported_versions).not.toContain('3.3-beta.1');
      // The previous preview is no longer served once the preview moves.
      expect(result.adcp.supported_versions).not.toContain('3.3-beta.4');
    }
    // A 3.3 prerelease the agent does not list never selects the preview:
    // neither the previous preview nor a later beta.
    for (const adcp_version of ['3.3-beta.4', '3.3-beta.6']) {
      const result = await call(route, 'get_adcp_capabilities', { adcp_version });
      expect(result.adcp_version, `${route} ${adcp_version}: ${JSON.stringify(result).slice(0, 300)}`).not.toBe(PREVIEW);
      expect(result.adcp_version).not.toBe(adcp_version);
    }
  }, 120_000);

  it('is the release a default client on the installed @adcp/sdk negotiates', async () => {
    // @adcp/sdk negotiates only the 3.3 beta it bundles. A preview it does
    // not bundle leaves every SDK buyer on 3.2 (candidate-version.ts).
    expect(SDK_ADCP_VERSION).toBe(TRAINING_AGENT_HOSTED_PREVIEW.bundle);
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
      expect(capabilities.data?.adcp?.supported_versions).toContain(PREVIEW);
      const accounts = await client.listAccounts({});
      expect(accounts.success, JSON.stringify(accounts.error)).toBe(true);
      // Served at the preview, with no downshift to an older release.
      expect(accounts.metadata.adcpVersion).toBe(PREVIEW);
      expect(accounts.metadata.negotiatedAdcpVersion).toBeUndefined();
    } finally {
      await closeMCPConnections();
    }
  }, 60_000);

  it('reaches the experimental 3.3 sales surfaces at the preview pin only', async () => {
    const preview = await call('/sales/mcp', 'get_adcp_capabilities', { adcp_version: PREVIEW });
    expect(preview.experimental_features).toEqual(expect.arrayContaining(['account.requests', 'media_buy.reporting_subscriptions']));
    expect(preview.account.requests).toBeDefined();
    expect(preview.adcp.principal.supported_sections).toContain('reporting_subscriptions');
    expect(preview.compliance_testing.scenarios).toContain('reporting_subscription_probe');
    for (const args of [{}, { adcp_version: '3.2' }, { adcp_version: '3.3' }]) {
      const stable = await call('/sales/mcp', 'get_adcp_capabilities', args);
      expect(stable.experimental_features).not.toContain('account.requests');
      expect(stable.experimental_features).not.toContain('media_buy.reporting_subscriptions');
      expect(stable.account.requests).toBeUndefined();
      expect(stable.adcp.principal.supported_sections).not.toContain('reporting_subscriptions');
      expect(stable.compliance_testing.scenarios).not.toContain('reporting_subscription_probe');
    }

    // request_account is discovered and served at the preview only.
    const pinnedList = await rpc('/sales/mcp', 'tools/list', { _meta: { adcp_version: PREVIEW } });
    expect(pinnedList.result.tools.map((tool: { name: string }) => tool.name)).toContain('request_account');
    for (const params of [{}, { _meta: { adcp_version: '3.2' } }, { _meta: { adcp_version: '3.3' } }]) {
      const stableList = await rpc('/sales/mcp', 'tools/list', params);
      expect(stableList.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('request_account');
      // Tools are stamped with the release the listing was served at.
      expect(new Set(stableList.result.tools.map((tool: { _meta?: { adcp_version?: string } }) => tool._meta?.adcp_version).filter(Boolean))).toEqual(new Set(['3.2']));
    }
    const opened = await call('/sales/mcp', 'request_account', {
      adcp_version: PREVIEW,
      brand: { domain: 'preview-open.example' },
      operator: 'preview-open.example',
      idempotency_key: 'preview-version-request-account-1',
    });
    expect(opened.adcp_version).toBe(PREVIEW);
    expect(opened.request?.resolution, JSON.stringify(opened).slice(0, 300)).toBe('created');
    // Below the preview the tool does not exist, exactly as before the preview.
    for (const adcp_version of ['3.2', '3.3']) {
      const refused = await rpc('/sales/mcp', 'tools/call', {
        name: 'request_account',
        arguments: {
          adcp_version,
          brand: { domain: 'preview-open.example' },
          operator: 'preview-open.example',
          idempotency_key: `preview-version-request-account-${adcp_version}`,
        },
      });
      expect(refused.result?.isError, JSON.stringify(refused).slice(0, 300)).toBe(true);
      expect(refused.result?.content?.[0]?.text).toContain('Tool request_account not found');
    }

    // The account carries the caller's 3.3 authorization at the preview only.
    const previewAccounts = await call('/sales/mcp', 'list_accounts', { adcp_version: PREVIEW });
    expect(previewAccounts.adcp_version).toBe(PREVIEW);
    expect(previewAccounts.accounts.length).toBeGreaterThan(0);
    for (const account of previewAccounts.accounts) {
      expect(typeof account.authorization?.authorized_at, JSON.stringify(account).slice(0, 300)).toBe('string');
    }
    const stableAccounts = await call('/sales/mcp', 'list_accounts', { adcp_version: '3.2' });
    for (const account of stableAccounts.accounts) {
      expect(account.authorization?.authorized_at).toBeUndefined();
      expect(account.revision).toBeUndefined();
    }

    // The reporting-subscription sandbox clock answers at the preview only.
    const scenarios = await call('/sales/mcp', 'comply_test_controller', { adcp_version: PREVIEW, scenario: 'list_scenarios' });
    expect(scenarios.scenarios).toContain('reporting_subscription_probe');
    const stableScenarios = await call('/sales/mcp', 'comply_test_controller', { adcp_version: '3.2', scenario: 'list_scenarios' });
    expect(stableScenarios.scenarios).not.toContain('reporting_subscription_probe');
  }, 120_000);

  it('resolves public sandbox account references at the preview as it does at 3.2', async () => {
    // AdCP 3.3 routes refuse account references the seller cannot resolve
    // (@adcp/sdk fail-closed resolution). The training agent's resolver is
    // reference-aware: a provisioned natural key resolves, an unprovisioned
    // one on a discovery task is ACCOUNT_NOT_FOUND, at the preview and 3.2.
    const account = { brand: { domain: 'preview-sandbox.example' }, operator: 'preview-sandbox.example', sandbox: true };
    for (const adcp_version of [PREVIEW, '3.2']) {
      const unprovisioned = await call('/sales/mcp', 'get_products', {
        adcp_version,
        account: { ...account, brand: { domain: `unprovisioned-${adcp_version}.example` } },
        buying_mode: 'brief',
        brief: 'sports',
      });
      expect(unprovisioned.adcp_error?.code, `${adcp_version}: ${JSON.stringify(unprovisioned).slice(0, 300)}`).toBe('ACCOUNT_NOT_FOUND');
    }
    const synced = await call('/sales/mcp', 'sync_accounts', {
      adcp_version: PREVIEW,
      accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
      idempotency_key: 'preview-version-sync-accounts-1',
    });
    expect(synced.accounts?.[0]?.status, JSON.stringify(synced).slice(0, 300)).toBe('active');
    for (const adcp_version of [PREVIEW, '3.2']) {
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
