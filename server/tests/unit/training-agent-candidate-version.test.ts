import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadStoryboardFile, registerExternalSchemaRoot, runStoryboardStep, unregisterExternalSchemaRoot } from '@adcp/sdk/testing';
import { storyboardStepStatus } from '../manual/storyboard-report-format.js';

vi.hoisted(() => {
  process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE = '1';
  process.env.ADCP_TRAINING_CANDIDATE_VERSION = '3.3-beta.0';
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'candidate-version-test-token';
});

import { trainingAgentCandidateVersion } from '../../src/training-agent/candidate-version.js';
import { createTrainingAgentServer } from '../../src/training-agent/task-handlers.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, TRAINING_AGENT_DEFAULT_ADCP_VERSION } from '../../src/training-agent/types.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';

describe('local candidate wire contract', () => {
  let schemaRoot: string;
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Exercise the public external-root API against a disposable source copy;
    // no generated development output or immutable release files are changed.
    schemaRoot = mkdtempSync(path.join(tmpdir(), 'adcp-candidate-version-'));
    cpSync(path.resolve('static/schemas/source'), schemaRoot, { recursive: true });
    for (const file of readdirSync(schemaRoot, { recursive: true }) as string[]) {
      if (!file.endsWith('.json')) continue;
      const filename = path.join(schemaRoot, file);
      writeFileSync(filename, readFileSync(filename, 'utf8').replaceAll('"/schemas/', '"/schemas/latest/'));
    }
    const indexPath = path.join(schemaRoot, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    writeFileSync(indexPath, JSON.stringify({ ...index, adcp_version: '3.3.0-beta.0' }));
    registerExternalSchemaRoot('3.3.0-beta.0', schemaRoot);
    const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
    const app = express();
    app.use(express.json({ verify: (req, _res, body) => {
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
    unregisterExternalSchemaRoot('3.3.0-beta.0');
    if (schemaRoot) rmSync(schemaRoot, { recursive: true, force: true });
  });

  it('requires the test runtime and both trusted candidate settings', () => {
    const config = { NODE_ENV: 'test', ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '1', ADCP_TRAINING_CANDIDATE_VERSION: '3.3-beta.0' };
    expect(trainingAgentCandidateVersion(config)).toBe('3.3-beta.0');
    for (const NODE_ENV of ['production', 'development', undefined]) {
      expect(trainingAgentCandidateVersion({ ...config, NODE_ENV })).toBeUndefined();
    }
    expect(trainingAgentCandidateVersion({ ...config, ADCP_STORYBOARD_CANDIDATE_VERSION_MODE: '0' })).toBeUndefined();
    expect(trainingAgentCandidateVersion({ ...config, ADCP_TRAINING_CANDIDATE_VERSION: '3.3-beta' })).toBeUndefined();
    expect(TRAINING_AGENT_CURRENT_ADCP_VERSION).toBe('3.2');
    expect(TRAINING_AGENT_DEFAULT_ADCP_VERSION).toBe('3.0');
  });

  it.each(['brand', 'sales'])('negotiates real candidate and explicit stable requests through /%s/mcp', async tenant => {
    for (const adcp_version of ['3.3-beta.0', '3.2', undefined]) {
      const response = await fetch(`${baseUrl}/${tenant}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer candidate-version-test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_adcp_capabilities', arguments: { adcp_version } } }),
      });
      const envelope = await response.json();
      const result = envelope.result?.structuredContent;
      expect(result, JSON.stringify(envelope)).toBeDefined();
      expect(result.adcp_error, JSON.stringify(result)).toBeUndefined();
      expect(result.adcp_version).toBe(adcp_version ?? '3.2');
      expect(result.adcp.supported_versions).toContain('3.2');
      expect(result.adcp.supported_versions.filter((version: string) => version === '3.3-beta.0')).toHaveLength(1);
      expect(result.experimental_features ?? []).not.toContain('media_buy.gender_targeting');
      if (tenant === 'sales') {
        if (adcp_version === '3.3-beta.0') expect(result.specialisms).toContain('sales-fixed-rate');
        else expect(result.specialisms).not.toContain('sales-fixed-rate');
        expect(result.compliance_testing.scenarios).toContain('force_media_buy_confirmation');
      }
    }
  }, 60_000);

  it('keeps gender preview opt-in independent and candidate versions unique with both flags', async () => {
    const preview = createTrainingAgentServer({ mode: 'open', developmentCoreGender: true });
    const handler = (preview as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get('tools/call')!;
    for (const adcp_version of ['3.3-beta.0', '3.2']) {
      const response = await handler({ method: 'tools/call', params: { name: 'get_adcp_capabilities', arguments: { adcp_version } } }, {});
      const result = response.structuredContent;
      expect(result.adcp.supported_versions.filter((version: string) => version === '3.3-beta.0')).toHaveLength(1);
      if (adcp_version === '3.3-beta.0') expect(result.experimental_features ?? []).toContain('media_buy.gender_targeting');
      else expect(result.experimental_features ?? []).not.toContain('media_buy.gender_targeting');
    }
    await preview.close();
  });

  it('keeps account.stable_account_id off the v5 monolith even for the candidate', async () => {
    // The v5 route neither aliases nor rehydrates account_id (#8487 gates the
    // declaration to 3.3; this keeps it off the route that cannot honor it).
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer candidate-version-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_adcp_capabilities', arguments: { adcp_version: '3.3-beta.0' } } }),
    });
    const result = (await response.json()).result?.structuredContent;
    expect(result?.adcp_version, JSON.stringify(result).slice(0, 300)).toBe('3.3-beta.0');
    expect(result.account).toBeDefined();
    expect(result.account).not.toHaveProperty('stable_account_id');
  });

  it('keeps legacy signing routes from advertising or accepting the candidate contract', async () => {
    const legacy = createTrainingAgentServer({ mode: 'open', strict: true, legacySigningProfile: true });
    const handler = (legacy as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get('tools/call')!;
    const response = await handler({ method: 'tools/call', params: {
      name: 'get_adcp_capabilities', arguments: { adcp_version: '3.3-beta.0' },
    } }, {});
    expect(response.structuredContent.adcp_error.code).toBe('VERSION_UNSUPPORTED');
    expect(response.structuredContent.adcp_error.details.supported_versions).not.toContain('3.3-beta.0');
    await legacy.close();
  });

  it('reports real SDK advisory findings without overriding its blocking validation verdict', async () => {
    const storyboard = loadStoryboardFile(path.resolve('static/compliance/source/universal/capability-discovery.yaml'));
    const options = {
      adcpVersion: '3.3.0-beta.0', wireAdcpVersion: '3.3-beta.0', schemaRoot,
      auth: { type: 'bearer' as const, token: 'candidate-version-test-token' }, allow_http: true,
    };
    const advisory = await runStoryboardStep(`${baseUrl}/sales/mcp`, storyboard, 'get_capabilities', options);
    expect(advisory.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy_hmac_fallback_removed_in_4_0', passed: false, severity: 'advisory' }),
    ]));
    expect(advisory.passed).toBe(true);
    expect(storyboardStepStatus(advisory)).toBe('passed');

    const requiredFixture = structuredClone(storyboard);
    const validation = requiredFixture.phases.flatMap(phase => phase.steps)
      .find(step => step.id === 'get_capabilities')!.validations!
      .find(entry => entry.id === 'legacy_hmac_fallback_removed_in_4_0')!;
    validation.severity = 'required';
    const blocking = await runStoryboardStep(`${baseUrl}/sales/mcp`, requiredFixture, 'get_capabilities', options);
    expect(blocking.passed).toBe(false);
    expect(storyboardStepStatus(blocking)).toBe('failed');
  }, 60_000);

  // #8487: the agent withholds 3.3 fields from a 3.2 caller
  // (tenants/served-release-shape.test.ts); a 3.3 caller still gets them.
  it('serves 3.3 fields to the candidate and withholds them from an explicit 3.2 pin', async () => {
    let id = 100;
    const call = async (tenant: string, name: string, args: Record<string, unknown>) => {
      id += 1;
      const response = await fetch(`${baseUrl}/${tenant}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer candidate-version-test-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });
      const envelope = await response.json();
      const result = envelope.result?.structuredContent;
      expect(result?.adcp_error, JSON.stringify(envelope).slice(0, 500)).toBeUndefined();
      return result;
    };
    const account = { brand: { domain: 'candidate-three-three.example' }, operator: 'candidate-three-three.example', sandbox: true };
    for (const adcp_version of ['3.3-beta.0', '3.2']) {
      const current = adcp_version === '3.3-beta.0';
      const sales = await call('sales', 'get_adcp_capabilities', { adcp_version });
      expect(sales.account.stable_account_id).toBe(current ? true : undefined);
      expect(sales.media_buy.features.supports_property_breakdown).toBe(current ? true : undefined);
      expect(sales.media_buy.features.supports_installment_property_breakdown).toBe(current ? true : undefined);
      if (current) {
        expect(sales.media_buy.vendor_metric_optimization.supported_metrics).toContainEqual(
          expect.objectContaining({ vendor: { domain: 'attentionvendor.example' }, metric_id: 'attention_score' }),
        );
      } else {
        expect(sales.media_buy.vendor_metric_optimization).not.toHaveProperty('supported_metrics');
      }
      const governance = await call('governance', 'get_adcp_capabilities', { adcp_version });
      expect(governance.governance.supports_budget_periods).toBe(current ? true : undefined);
      for (const tenant of ['signals', 'creative']) {
        const caps = await call(tenant, 'get_adcp_capabilities', { adcp_version });
        expect(caps.account.stable_account_id, tenant).toBe(current ? true : undefined);
      }

      await call('sales', 'sync_accounts', {
        adcp_version,
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: `candidate-three-three-provision-${adcp_version}`,
      });
      const listed = await call('sales', 'list_products', { adcp_version, account, max_results: 50 });
      expect(listed.adcp_version).toBe(adcp_version);
      const withInstallments = (listed.products as Array<Record<string, unknown>>)
        .filter(product => Array.isArray(product.installments));
      if (current) expect(withInstallments.length).toBeGreaterThan(0);
      else expect(withInstallments).toEqual([]);

      const audiences = await call('sales', 'sync_audiences', {
        adcp_version, account,
        idempotency_key: `candidate-three-three-audiences-${adcp_version}`,
        audiences: [{
          audience_id: 'candidate_loyalty', name: 'Candidate loyalty', audience_type: 'crm',
          add: [{ external_id: 'member_1', hashed_email: 'a'.repeat(64) }],
        }],
      });
      const sources = await call('sales', 'sync_event_sources', {
        adcp_version, account,
        idempotency_key: `candidate-three-three-sources-${adcp_version}`,
        event_sources: [{ event_source_id: 'candidate_pixel', name: 'Candidate pixel', event_types: ['purchase'] }],
      });
      for (const row of [...audiences.audiences, ...sources.event_sources] as Array<Record<string, unknown>>) {
        expect(typeof row.seller_id).toBe('string');
        expect(row.platform_id).toBe(current ? row.seller_id : undefined);
      }
    }
  }, 60_000);
});
