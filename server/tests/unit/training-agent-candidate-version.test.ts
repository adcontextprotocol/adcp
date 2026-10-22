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
});
