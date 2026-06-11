import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentsDueForCheck: vi.fn(),
  resolveOwnerAuth: vi.fn(),
  recordComplianceRun: vi.fn(),
  query: vi.fn(),
  comply: vi.fn(),
  classifyCapabilityResolutionError: vi.fn(),
  presentCapabilityResolutionError: vi.fn(),
  badgeEligibleVersionsForTargetSelection: vi.fn(),
  selectComplianceTargetForAgentSelection: vi.fn(),
  hostedComplianceTarget: vi.fn(),
  logOutboundRequest: vi.fn(),
  adaptAuthForSdk: vi.fn(),
  revokeUnsupportedPublicBadges: vi.fn(),
  runBadgeFanOut: vi.fn(),
}));

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    getAgentsDueForCheck = mocks.getAgentsDueForCheck;
    resolveOwnerAuth = mocks.resolveOwnerAuth;
    recordComplianceRun = mocks.recordComplianceRun;
    getBadgesForAgent = vi.fn().mockResolvedValue([]);
    revokeBadge = vi.fn();
  },
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
}));

vi.mock('../../src/addie/services/compliance-testing.js', () => ({
  comply: mocks.comply,
  complianceResultToDbInput: vi.fn(),
  classifyCapabilityResolutionError: mocks.classifyCapabilityResolutionError,
  presentCapabilityResolutionError: mocks.presentCapabilityResolutionError,
  badgeEligibleVersionsForTargetSelection: mocks.badgeEligibleVersionsForTargetSelection,
  selectComplianceTargetForAgentSelection: mocks.selectComplianceTargetForAgentSelection,
}));

vi.mock('../../src/services/hosted-compliance-version.js', () => ({
  hostedComplianceTarget: mocks.hostedComplianceTarget,
}));

vi.mock('../../src/db/outbound-log-db.js', () => ({
  logOutboundRequest: mocks.logOutboundRequest,
}));

vi.mock('../../src/services/sdk-auth-adapter.js', () => ({
  adaptAuthForSdk: mocks.adaptAuthForSdk,
}));

vi.mock('../../src/services/badge-issuance.js', () => ({
  revokeUnsupportedPublicBadges: mocks.revokeUnsupportedPublicBadges,
  runBadgeFanOut: mocks.runBadgeFanOut,
}));

vi.mock('../../src/notifications/compliance.js', () => ({
  notifyComplianceChange: vi.fn(),
  notifyVerificationChange: vi.fn(),
}));

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: vi.fn(),
}));

describe('runComplianceHeartbeatJob', () => {
  const target = { requested: '3.1.0-rc.6', version: '3.1.0-rc.6' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostedComplianceTarget.mockReturnValue(target);
    mocks.getAgentsDueForCheck.mockResolvedValue([
      { agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing' },
    ]);
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.resolveOwnerAuth.mockResolvedValue(undefined);
    mocks.adaptAuthForSdk.mockResolvedValue(undefined);
    mocks.selectComplianceTargetForAgentSelection.mockResolvedValue({ target, confirmed: false });
    mocks.classifyCapabilityResolutionError.mockReturnValue(null);
    mocks.badgeEligibleVersionsForTargetSelection.mockReturnValue([]);
    mocks.recordComplianceRun.mockResolvedValue({});
  });

  it('counts malformed saved Basic auth as a checked failure', async () => {
    mocks.comply.mockRejectedValueOnce(new Error('step.auth.basic.username must be a non-empty string'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 1, passed: 0, failed: 1, skipped: 0 });
    expect(mocks.recordComplianceRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_url: 'https://agent.example.com/mcp',
        overall_status: 'failing',
        headline: 'Saved Basic auth credentials are malformed',
        observations_json: [{
          category: 'authentication',
          severity: 'warning',
          message: 'The saved Basic auth credentials for this agent must include a non-empty username.',
        }],
      }),
    );
  });
});
