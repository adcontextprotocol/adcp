import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
}));

vi.mock('@adcp/sdk/testing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  testCapabilityDiscovery: mocks.discovery,
}));

import { createMemberToolHandlers } from '../../../src/addie/mcp/member-tools.js';

describe('recommend_storyboards capability probe version', () => {
  beforeEach(() => {
    mocks.discovery.mockReset();
    mocks.discovery.mockResolvedValue({
      profile: { adcp_supported_versions: ['3.1'], supported_protocols: ['media-buy'] },
      steps: [],
    });
  });

  it('pins the probe to an explicit compliance_target', async () => {
    const handler = createMemberToolHandlers(null).get('recommend_storyboards')!;
    await handler({ agent_url: 'https://agent.example/mcp', compliance_target: '3.1.20' }).catch(() => {});

    const options = mocks.discovery.mock.calls[0][1];
    expect(options.adcpVersion).toMatch(/^3\.1/);
    expect(options.versionEnvelope).toBe('auto');
  });

  it('sends only the major when no compliance_target is given', async () => {
    const handler = createMemberToolHandlers(null).get('recommend_storyboards')!;
    await handler({ agent_url: 'https://agent.example/mcp' }).catch(() => {});

    const options = mocks.discovery.mock.calls[0][1];
    expect(options.versionEnvelope).toBe('major-only');
    expect(options.adcpVersion).toBeUndefined();
  });
});
