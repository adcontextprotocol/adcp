import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  discovery: vi.fn(),
}));

vi.mock('@adcp/sdk/testing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adcp/sdk/testing')>()),
  testCapabilityDiscovery: mocks.discovery,
}));

import { CapabilityResolutionError } from '@adcp/sdk/testing';
import { classifyCapabilityResolutionErrorWithDeclaredProtocols } from '../../src/addie/mcp/member-tools.js';
import { hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';

describe('classifyCapabilityResolutionErrorWithDeclaredProtocols', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('pins the reprobe to the run target version, not the SDK default', async () => {
    const target = hostedComplianceTarget('3.1.20');
    mocks.discovery.mockResolvedValue({
      profile: { supported_protocols: ['media-buy'] },
      steps: [],
    });

    const error = new CapabilityResolutionError({
      code: 'specialism_parent_protocol_missing',
      message: 'specialism requires parent protocol',
      specialism: 'sales-broadcast-tv',
      parentProtocol: 'media_buy',
    });

    await classifyCapabilityResolutionErrorWithDeclaredProtocols(
      error,
      'https://agent.example/mcp',
      undefined,
      target,
    );

    expect(mocks.discovery).toHaveBeenCalledTimes(1);
    expect(mocks.discovery.mock.calls[0][1]).toMatchObject({ adcpVersion: '3.1.20' });
  });
});
