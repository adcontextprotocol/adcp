import express from 'express';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The hosted SSRF guard refuses loopback agents. This test drives an
// in-process training agent, so let the SDK use the global fetch.
vi.mock('../../src/utils/sdk-safe-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/sdk-safe-fetch.js')>()),
  withSdkSafeTransport: <T extends object>(options: T) => options,
}));

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { hostedComplianceTarget } = await import('../../src/services/hosted-compliance-version.js');
const { comply } = await import('../../src/addie/services/compliance-testing.js');

// A 3.0 pin sends only adcp_major_version: 3, and the training agent's sales
// tenant then serves and echoes 3.2, as a conformant agent may. Hosted
// compliance grades on the 3.0 target and passes its hosted schema root, which
// makes the SDK validate the 3.2 capabilities against 3.0.
describe('hosted compliance on a 3.0 target for an agent that echoes 3.2', () => {
  let server: http.Server;
  let agentUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
      },
    }));
    app.use('/api/training-agent', createTrainingAgentRouter({}));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    agentUrl = `http://127.0.0.1:${port}/api/training-agent/sales/mcp`;
  });

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('reports no capability-schema notices for fields 3.2 allows', async () => {
    const target = hostedComplianceTarget('3.0');
    const result = await comply(agentUrl, {
      auth: { type: 'bearer', token: 'test-token' },
      storyboards: ['capability_discovery'],
      allow_http: true,
    }, target);

    const profile = result.agent_profile as { raw_capabilities?: { adcp_version?: string } };
    expect(profile.raw_capabilities?.adcp_version).toBe('3.2');
    // Grading still comes from the selected target.
    expect(result.adcp_version).toBe(target.version);
    expect(result.storyboards_executed).toEqual(['capability_discovery']);

    const capabilityNotices = result.notices.filter(n => n.code === 'capabilities_response_schema_invalid');
    expect(capabilityNotices.map(n => n.capability_pointer)).toEqual([]);
  }, 180_000);
});
