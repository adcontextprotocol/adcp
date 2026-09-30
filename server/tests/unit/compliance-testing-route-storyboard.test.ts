/**
 * The hosted comply() wrapper hands the SDK a per-storyboard routing hook
 * (#7758, #7772) and scrubs every credential that hook minted from the
 * result before any caller (heartbeat, evaluate_agent_quality, registry
 * refresh) stores, renders, or logs it.
 */
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.TRAINING_GOVERNANCE_CREDENTIAL_SECRET = require('node:crypto').randomBytes(32).toString('hex') as string;
  return {
    sdkComply: vi.fn(),
    discovery: vi.fn(),
    getTestKitForStoryboard: vi.fn(),
    target: {
      requested: '3.2',
      version: '3.2.0-rc.7',
      complianceDir: '/compliance/3.2.0-rc.7',
      schemaRoot: '/schemas/3.2.0-rc.7',
    },
  };
});

vi.mock('@adcp/sdk/testing', async importOriginal => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  comply: mocks.sdkComply,
  testCapabilityDiscovery: mocks.discovery,
}));

vi.mock('../../src/services/hosted-compliance-version.js', () => ({
  hostedComplianceTarget: () => mocks.target,
  hostedComplianceOptions: (target: { version: string; complianceDir: string; schemaRoot: string }) => ({
    version: target.version,
    complianceDir: target.complianceDir,
    schemaRoot: target.schemaRoot,
  }),
  hostedAuthProbeTaskForProfile: vi.fn(),
  hostedStaticApiKeyForProfile: vi.fn(),
  agentAdvertisesHostedComplianceTarget: vi.fn().mockReturnValue(true),
  agentAdvertisesBadgeEligibleHostedComplianceTarget: vi.fn().mockReturnValue(false),
  badgeEligibleVersionsForHostedComplianceTarget: vi.fn().mockReturnValue([]),
  selectCanonicalHostedComplianceTargetForProfile: () => mocks.target,
  selectHostedComplianceTargetForProfile: () => mocks.target,
  withHostedComplianceRunOptions: (options: Record<string, unknown>) => options,
  withHostedTestOptions: (options: Record<string, unknown>) => options,
}));

vi.mock('../../src/services/storyboards.js', () => ({
  getTestKitForStoryboard: mocks.getTestKitForStoryboard,
}));

import { loadStoryboardFile } from '@adcp/sdk/testing';
import { comply } from '../../src/addie/services/compliance-testing.js';

const SOURCE = resolve(__dirname, '../../../static/compliance/source');
const SELLER_URL = 'https://seller.wrapper-7758.example/mcp';

describe('hosted comply() routing hook', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes routeStoryboard to the SDK and redacts minted credentials from the result', async () => {
    mocks.discovery.mockResolvedValue({ profile: { tools: [] }, steps: [] });
    const storyboard = loadStoryboardFile(resolve(SOURCE, 'protocols/media-buy/scenarios/governance_approved.yaml'));
    mocks.sdkComply.mockImplementation(async (agentUrl: string, options: { routeStoryboard?: (...args: unknown[]) => unknown }) => {
      expect(typeof options.routeStoryboard).toBe('function');
      const route = await options.routeStoryboard!(storyboard, { agent_url: agentUrl, profile: {} }) as {
        agents: { governance: { auth: { token: string } } };
        storyboard: unknown;
      };
      const graderToken = route.agents.governance.auth.token;
      const sellerCredential = /adcp-sandbox-gov\.v1\.[A-Za-z0-9_.-]+/.exec(JSON.stringify(route.storyboard))![0];
      // A result that (hypothetically) echoes both secrets back.
      return {
        agent_profile: {},
        failures: [{ storyboard_id: storyboard.id, step_id: 'sync_governance', error: `seller echoed ${sellerCredential}` }],
        observations: [{ message: `Bearer ${graderToken}` }],
      };
    });

    const result = await comply(SELLER_URL, { auth: { type: 'bearer', token: 'owner-token-0123456789' } }, mocks.target as never);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/adcp-sandbox-gov\.v1\./);
    expect(serialized).not.toMatch(/adcp-sandbox-gov-grader\.v1\./);
    expect(serialized).toContain('[redacted]');
    expect(mocks.getTestKitForStoryboard).toHaveBeenCalledWith(storyboard.id, expect.objectContaining({ complianceDir: mocks.target.complianceDir }));
  });

  it('keeps a caller-supplied routeStoryboard', async () => {
    mocks.discovery.mockResolvedValue({ profile: { tools: [] }, steps: [] });
    const custom = vi.fn();
    mocks.sdkComply.mockResolvedValue({ agent_profile: {} });
    await comply(SELLER_URL, { routeStoryboard: custom } as never, mocks.target as never);
    expect(mocks.sdkComply.mock.calls[0][1].routeStoryboard).toBe(custom);
  });
});
