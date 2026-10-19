import express from 'express';
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';

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

type Capabilities = Record<string, any>;

const CAPABILITY_NOTICE = 'capabilities_response_schema_invalid';
// Fields the training agent serves that 3.2 allows and 3.0 rejects.
const PRE_3_2_POINTERS = [/^\/media_buy\/features\/bidding_policy/, /^\/compliance_testing\/scenarios\//];

// Rewrites the training agent's get_adcp_capabilities MCP response, both the
// structured content and its mirrored JSON text block.
let mutateCapabilities: ((capabilities: Capabilities) => void) | undefined;

function rewriteCapabilitiesBody(body: string): string {
  const message = JSON.parse(body);
  const result = message?.result;
  if (!result || !mutateCapabilities) return body;
  if (result.structuredContent) mutateCapabilities(result.structuredContent);
  for (const block of result.content ?? []) {
    if (block?.type !== 'text' || !block._meta?.['adcp/mirrored-structured-content']) continue;
    const mirrored = JSON.parse(block.text);
    mutateCapabilities(mirrored);
    block.text = JSON.stringify(mirrored);
  }
  return JSON.stringify(message);
}

function capabilityNoticePointers(result: ComplianceResult): string[] {
  return result.notices
    .filter(notice => notice.code === CAPABILITY_NOTICE)
    .map(notice => String(notice.capability_pointer));
}

function capabilitySteps(result: ComplianceResult) {
  return result.tracks.flatMap(track => track.scenarios.flatMap(scenario => scenario.steps))
    .filter(step => step.task === 'get_adcp_capabilities');
}

function capabilityResponseSchemaFailures(result: ComplianceResult) {
  return (result.failures ?? []).filter(failure =>
    failure.task === 'get_adcp_capabilities' && failure.validation?.check === 'response_schema');
}

function failurePointers(result: ComplianceResult): string[] {
  return capabilityResponseSchemaFailures(result).flatMap(failure => {
    const actual = failure.validation?.actual;
    const errors = Array.isArray(actual) ? actual : [];
    return [
      failure.validation?.json_pointer,
      ...errors.map(error => (error as { instancePath?: string; path?: string }).instancePath
        ?? (error as { path?: string }).path),
    ].filter((pointer): pointer is string => typeof pointer === 'string');
  });
}

// A 3.0 pin sends only adcp_major_version: 3, and the training agent's sales
// tenant then serves and echoes 3.2, as a conformant agent may. Hosted
// compliance grades on the 3.0 target with its hosted schema root. @adcp/sdk
// 15.9.5 validates the capabilities against the echoed release (from the
// hosted roots withHostedComplianceOptions registers) when the echo is listed
// in the response's adcp.supported_versions.
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
    app.use((req, res, next) => {
      const body = req.body as { method?: string; params?: { name?: string } } | undefined;
      if (body?.method !== 'tools/call' || body.params?.name !== 'get_adcp_capabilities') return next();
      const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
      (res as unknown as { end: (...args: unknown[]) => http.ServerResponse }).end = (chunk: unknown, ...rest: unknown[]) => {
        if (chunk === undefined || chunk === null || typeof chunk === 'function') return end(chunk, ...rest);
        const body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        let rewritten = body;
        try {
          rewritten = rewriteCapabilitiesBody(body);
        } catch {
          // Leave the response untouched; the assertions report the miss.
        }
        return end(rewritten, ...rest);
      };
      next();
    });
    app.use('/api/training-agent', createTrainingAgentRouter({}));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    agentUrl = `http://127.0.0.1:${port}/api/training-agent/sales/mcp`;
  });

  afterEach(() => {
    mutateCapabilities = undefined;
  });

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function runCapabilityDiscovery() {
    const target = hostedComplianceTarget('3.0');
    const result = await comply(agentUrl, {
      auth: { type: 'bearer', token: 'test-token' },
      storyboards: ['capability_discovery'],
      allow_http: true,
    }, target);
    const profile = result.agent_profile as { raw_capabilities?: Capabilities };
    expect(profile.raw_capabilities?.adcp_version).toBe('3.2');
    // Grading still comes from the selected target.
    expect(result.adcp_version).toBe(target.version);
    expect(result.storyboards_executed).toEqual(['capability_discovery']);
    expect(capabilitySteps(result).length).toBeGreaterThan(0);
    return result;
  }

  it('validates the capabilities against 3.2: no spurious notices or response_schema failures', async () => {
    const result = await runCapabilityDiscovery();

    expect(capabilityNoticePointers(result)).toEqual([]);
    expect(capabilityResponseSchemaFailures(result)).toEqual([]);
    expect(capabilitySteps(result).every(step => step.passed)).toBe(true);
  }, 180_000);

  it('still fails a capabilities response that 3.2 itself rejects', async () => {
    mutateCapabilities = capabilities => {
      if (capabilities.media_buy?.portfolio) capabilities.media_buy.portfolio.primary_channels = ['not_a_channel'];
    };
    const result = await runCapabilityDiscovery();

    expect(capabilityResponseSchemaFailures(result).length).toBeGreaterThan(0);
    expect(capabilitySteps(result).some(step => !step.passed)).toBe(true);
    const pointers = [...failurePointers(result), ...capabilityNoticePointers(result)];
    expect(pointers.some(pointer => pointer.startsWith('/media_buy/portfolio/primary_channels'))).toBe(true);
    // Only the injected error: fields 3.2 allows are not reported.
    expect(pointers.filter(pointer => PRE_3_2_POINTERS.some(re => re.test(pointer)))).toEqual([]);
  }, 180_000);

  // Unlike the #8264 server-side workaround, the SDK honours the echo only
  // when the response lists it in adcp.supported_versions. Otherwise it
  // validates strictly against the 3.0 pin.
  it('validates against the 3.0 pin when the echoed release is not in supported_versions', async () => {
    mutateCapabilities = capabilities => {
      const supported = capabilities.adcp?.supported_versions;
      if (Array.isArray(supported)) {
        capabilities.adcp.supported_versions = supported.filter((version: string) => !version.startsWith('3.2'));
      }
    };
    const result = await runCapabilityDiscovery();

    expect(capabilityResponseSchemaFailures(result).length).toBeGreaterThan(0);
    const notices = capabilityNoticePointers(result);
    expect(notices.some(pointer => PRE_3_2_POINTERS.some(re => re.test(pointer)))).toBe(true);
  }, 180_000);
});
