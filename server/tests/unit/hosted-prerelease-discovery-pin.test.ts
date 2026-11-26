/**
 * adcp-client#3715: @adcp/sdk 17.0.0-beta.23+ discovers capabilities unpinned
 * for a prerelease pin and profiles whatever the agent serves unpinned. The
 * training agent serves its retained 3.3-rc.3 checkpoint only to an exact pin, so hosted
 * grading of a 3.3 prerelease bundle would profile 3.2 and skip every
 * capability-gated 3.3 storyboard. The hosted option builders pin discovery
 * for prerelease targets only; stable targets keep the SDK default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { closeMCPConnections } from '@adcp/sdk';
import { testCapabilityDiscovery } from '@adcp/sdk/testing';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'hosted-prerelease-discovery-token';

import { TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION } from '../../src/training-agent/types.js';
import { RETAINED_SCHEMA_BUNDLES } from '../../src/training-agent/schema-compat.js';
import { stopSessionCleanup } from '../../src/training-agent/state.js';
import { hostedComplianceTarget, withHostedTestOptions } from '../../src/services/hosted-compliance-version.js';

const TOKEN = 'hosted-prerelease-discovery-token';

describe('hosted capability discovery against an agent that serves its preview only to an exact pin', () => {
  let server: http.Server;
  let agentUrl = '';

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
    agentUrl = `http://127.0.0.1:${address.port}/api/training-agent/sales/mcp`;
  }, 60_000);

  afterAll(async () => {
    await closeMCPConnections();
    stopSessionCleanup();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  const discover = async (requested: string) => {
    const options = withHostedTestOptions({ auth: { type: 'bearer', token: TOKEN }, allow_http: true }, hostedComplianceTarget(requested));
    const discovery = await testCapabilityDiscovery(agentUrl, options);
    return discovery.profile?.raw_capabilities as Record<string, any> | undefined;
  };

  it('profiles the prerelease surface for a prerelease target', async () => {
    // The retired preview's retained 3.3-rc.3 checkpoint is still served to an
    // exact pin only, so a prerelease grading target must pin discovery to it.
    const raw = await discover(RETAINED_SCHEMA_BUNDLES[TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION]);
    expect(raw?.adcp_version).toBe(TRAINING_AGENT_RETAINED_PREVIEW_ADCP_VERSION);
    expect(raw?.experimental_features).toContain('media_buy.hold_policy');
  }, 60_000);

  it('keeps the stable surface for a stable target', async () => {
    const raw = await discover('3.2');
    expect(raw?.adcp_version).toBe('3.2');
    expect(raw?.experimental_features ?? []).not.toContain('media_buy.hold_policy');
  }, 60_000);
});
