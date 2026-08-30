import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentsDueForCheck: vi.fn(),
  getRecentSupportedVersions: vi.fn(),
  countComplianceRuns: vi.fn(),
  deferComplianceCheckAfterInconclusiveTarget: vi.fn(),
  resolveOwnerAuth: vi.fn(),
  recordComplianceRun: vi.fn(),
  getBadgesForAgent: vi.fn(),
  revokeBadge: vi.fn(),
  getRegistryMetadata: vi.fn(),
  query: vi.fn(),
  withDatabaseDeadline: vi.fn(),
  comply: vi.fn(),
  complianceResultToDbInput: vi.fn(),
  classifyCapabilityResolutionError: vi.fn(),
  presentCapabilityResolutionError: vi.fn(),
  badgeEligibleVersionsForTargetSelection: vi.fn(),
  selectComplianceTargetForAgentSelection: vi.fn(),
  hostedComplianceTarget: vi.fn(),
  logOutboundRequest: vi.fn(),
  adaptAuthForSdk: vi.fn(),
  revokeUnsupportedPublicBadges: vi.fn(),
  runBadgeFanOut: vi.fn(),
  getVerificationProfileShadowRollout: vi.fn(),
  recordVerificationProfileShadowAssessment: vi.fn(),
  pruneVerificationProfileShadowAssessments: vi.fn(),
  deriveVerificationProfileShadowAssessment: vi.fn(),
  acquireAgentExecutionFence: vi.fn(),
  releaseExecutionFence: vi.fn(),
}));

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    getAgentsDueForCheck = mocks.getAgentsDueForCheck;
    getRecentSupportedVersions = mocks.getRecentSupportedVersions;
    countComplianceRuns = mocks.countComplianceRuns;
    deferComplianceCheckAfterInconclusiveTarget = mocks.deferComplianceCheckAfterInconclusiveTarget;
    resolveOwnerAuth = mocks.resolveOwnerAuth;
    recordComplianceRun = mocks.recordComplianceRun;
    getBadgesForAgent = mocks.getBadgesForAgent;
    revokeBadge = mocks.revokeBadge;
    getRegistryMetadata = mocks.getRegistryMetadata;
  },
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  withDatabaseDeadline: mocks.withDatabaseDeadline,
}));

vi.mock('../../src/db/compliance-refresh-requests-db.js', () => ({
  ComplianceRefreshRequestsDatabase: class {
    acquireAgentExecutionFence = mocks.acquireAgentExecutionFence;
  },
}));

vi.mock('../../src/addie/services/compliance-testing.js', () => ({
  HOSTED_TARGET_DISCOVERY_TIMEOUT_MS: 30_000,
  comply: mocks.comply,
  complianceResultToDbInput: mocks.complianceResultToDbInput,
  classifyCapabilityResolutionError: mocks.classifyCapabilityResolutionError,
  presentCapabilityResolutionError: mocks.presentCapabilityResolutionError,
  badgeEligibleVersionsForTargetSelection: mocks.badgeEligibleVersionsForTargetSelection,
  hasTrustworthyComplianceTarget: (selection: { source?: string }) => selection.source !== 'default',
  storedComplianceTargetMatchesObservedProfile: (
    selection: { source?: string; target?: { requested?: string } },
    profile?: { adcp_supported_versions?: string[] },
  ) => selection.source !== 'stored'
    || Boolean(profile?.adcp_supported_versions?.includes(selection.target?.requested ?? '')),
  selectComplianceTargetForAgentSelection: mocks.selectComplianceTargetForAgentSelection,
}));

vi.mock('../../src/services/hosted-compliance-version.js', () => ({
  hostedComplianceTarget: mocks.hostedComplianceTarget,
  HOSTED_FULL_COMPLIANCE_TIMEOUT_MS: 600_000,
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

vi.mock('../../src/db/system-settings-db.js', () => ({
  getVerificationProfileShadowRollout: mocks.getVerificationProfileShadowRollout,
}));

vi.mock('../../src/db/verification-profile-shadow-db.js', () => ({
  recordVerificationProfileShadowAssessment: mocks.recordVerificationProfileShadowAssessment,
  pruneVerificationProfileShadowAssessments: mocks.pruneVerificationProfileShadowAssessments,
}));

vi.mock('../../src/services/verification-profile-shadow.js', () => ({
  deriveVerificationProfileShadowAssessment: mocks.deriveVerificationProfileShadowAssessment,
}));

vi.mock('../../src/notifications/compliance.js', () => ({
  notifyComplianceChange: vi.fn(),
  notifyVerificationChange: vi.fn(),
}));

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: vi.fn(),
}));

describe('runComplianceHeartbeatJob', () => {
  const target = { requested: '3.1', version: '3.1.0' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostedComplianceTarget.mockReturnValue(target);
    mocks.getAgentsDueForCheck.mockResolvedValue([
      { agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing', last_checked_at: null },
    ]);
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.withDatabaseDeadline.mockImplementation(async (_deadline, operation) => operation());
    mocks.resolveOwnerAuth.mockResolvedValue(undefined);
    mocks.getRecentSupportedVersions.mockResolvedValue(['3.1']);
    mocks.countComplianceRuns.mockResolvedValue(4);
    mocks.adaptAuthForSdk.mockResolvedValue(undefined);
    mocks.selectComplianceTargetForAgentSelection.mockResolvedValue({ target, confirmed: false, source: 'stored' });
    mocks.classifyCapabilityResolutionError.mockReturnValue(null);
    mocks.badgeEligibleVersionsForTargetSelection.mockReturnValue([]);
    mocks.complianceResultToDbInput.mockReturnValue({
      agent_url: 'https://agent.example.com/mcp',
      lifecycle_stage: 'testing',
      overall_status: 'passing',
      headline: 'All good',
      tracks_json: [],
      storyboard_statuses: [],
      dry_run: true,
    });
    mocks.recordComplianceRun.mockResolvedValue({});
    mocks.getBadgesForAgent.mockResolvedValue([]);
    mocks.getRegistryMetadata.mockResolvedValue(null);
    mocks.getVerificationProfileShadowRollout.mockResolvedValue({ enabled: false });
    mocks.recordVerificationProfileShadowAssessment.mockResolvedValue(true);
    mocks.pruneVerificationProfileShadowAssessments.mockResolvedValue(0);
    mocks.revokeUnsupportedPublicBadges.mockResolvedValue({ issued: [], revoked: [], degraded: [], unchanged: [] });
    mocks.deriveVerificationProfileShadowAssessment.mockReturnValue({
      policy_version: 'verification-profiles-v1',
      current_public_status: 'passing',
      proposed_spec_status: 'passing',
      proposed_sandbox_status: null,
      controller_gap_phase_count: 0,
    });
    mocks.releaseExecutionFence.mockResolvedValue(undefined);
    mocks.acquireAgentExecutionFence.mockResolvedValue({
      isValid: () => true,
      release: mocks.releaseExecutionFence,
    });
  });

  it('runs retention cleanup even when no agents are due', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([]);

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 1 })).resolves.toEqual({
      checked: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.pruneVerificationProfileShadowAssessments).toHaveBeenCalledOnce();
    expect(mocks.comply).not.toHaveBeenCalled();
  });

  it('runs heartbeat against the selected canonical target and passes supported versions to badge fan-out', async () => {
    const complianceResult = {
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: {
        specialisms: ['sales-broadcast-tv'],
        adcp_supported_versions: ['3.0', '3.1'],
      },
    };
    mocks.comply.mockResolvedValueOnce(complianceResult);
    mocks.badgeEligibleVersionsForTargetSelection.mockReturnValue(['3.1']);
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-31' },
      statusTransition: null,
      storyboardStatuses: [],
    });
    mocks.runBadgeFanOut.mockResolvedValueOnce({ issued: [], revoked: [], degraded: [], unchanged: [] });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 1, passed: 1, failed: 0, skipped: 0 });
    expect(mocks.selectComplianceTargetForAgentSelection).toHaveBeenCalledWith(
      'https://agent.example.com/mcp',
      expect.objectContaining({ timeout_ms: 600_000 }),
      target,
      'canonical',
      ['3.1'],
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('make_interval'),
      [['https://agent.example.com/mcp'], 960],
    );
    expect(mocks.comply).toHaveBeenCalledWith(
      'https://agent.example.com/mcp',
      // storyboard_start_offset = the persisted per-agent run count
      // (adcp#6632 / adcp-client#2639 rotation)
      expect.objectContaining({ timeout_ms: 600_000, storyboard_start_offset: 4 }),
      target,
    );
    expect(mocks.runBadgeFanOut).toHaveBeenCalledWith(expect.objectContaining({
      agentUrl: 'https://agent.example.com/mcp',
      declaredSpecialisms: ['sales-broadcast-tv'],
      runId: 'run-31',
      adcpVersions: ['3.1'],
      supportedVersions: ['3.0', '3.1'],
    }));
    expect(mocks.releaseExecutionFence).toHaveBeenCalledOnce();
  });

  it('defers without executing when an owner refresh holds the agent fence', async () => {
    mocks.acquireAgentExecutionFence.mockResolvedValueOnce(null);

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.comply).not.toHaveBeenCalled();
  });

  it('does not persist when the shared execution fence is lost during comply', async () => {
    let fenceValid = true;
    mocks.acquireAgentExecutionFence.mockResolvedValueOnce({
      isValid: () => fenceValid,
      release: mocks.releaseExecutionFence,
    });
    mocks.comply.mockImplementationOnce(async () => {
      fenceValid = false;
      return {
        overall_status: 'passing',
        summary: { headline: 'Stale result' },
        agent_profile: { adcp_supported_versions: ['3.1'] },
      };
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
    expect(mocks.runBadgeFanOut).not.toHaveBeenCalled();
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.releaseExecutionFence).toHaveBeenCalledOnce();
  });

  it('does not write compliance or badge records when comply() rejects after fence becomes invalid', async () => {
    let fenceValid = true;
    mocks.acquireAgentExecutionFence.mockResolvedValueOnce({
      isValid: () => fenceValid,
      release: mocks.releaseExecutionFence,
    });
    // comply() rejects with a timeout while the fence has been invalidated by a
    // concurrent owner refresh. The stale failure must not be persisted.
    mocks.comply.mockImplementationOnce(async () => {
      fenceValid = false;
      throw new Error('Timed out');
    });
    mocks.badgeEligibleVersionsForTargetSelection.mockReturnValue(['3.1']);

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
    expect(mocks.getBadgesForAgent).not.toHaveBeenCalled();
    expect(mocks.revokeBadge).not.toHaveBeenCalled();
    expect(mocks.revokeUnsupportedPublicBadges).not.toHaveBeenCalled();
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.releaseExecutionFence).toHaveBeenCalledOnce();
  });

  it('records shadow evidence only when the audited collection switch is enabled', async () => {
    const complianceResult = {
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    };
    mocks.getVerificationProfileShadowRollout.mockResolvedValueOnce({ enabled: true });
    mocks.comply.mockResolvedValueOnce(complianceResult);
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-shadow' },
      statusTransition: null,
      storyboardStatuses: [],
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await runComplianceHeartbeatJob({ limit: 1 });

    expect(mocks.deriveVerificationProfileShadowAssessment).toHaveBeenCalledWith(
      complianceResult,
      'testing',
      'passing',
    );
    expect(mocks.recordVerificationProfileShadowAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRunId: 'run-shadow',
        agentUrl: 'https://agent.example.com/mcp',
        lifecycleStage: 'testing',
      }),
    );
    expect(mocks.withDatabaseDeadline).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Function),
      { readOnly: false },
    );
  });

  it('keeps public compliance successful when shadow persistence fails', async () => {
    mocks.getVerificationProfileShadowRollout.mockResolvedValueOnce({ enabled: true });
    mocks.comply.mockResolvedValueOnce({
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-shadow-failure' },
      statusTransition: null,
      storyboardStatuses: [],
    });
    mocks.recordVerificationProfileShadowAssessment.mockRejectedValueOnce(new Error('shadow table unavailable'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 1 })).resolves.toEqual({
      checked: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('flushes shadow writes after public processing and rechecks disable before every write', async () => {
    const complianceResult = {
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    };
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([
      { agent_url: 'https://one.example.com/mcp', lifecycle_stage: 'production', last_checked_at: null },
      { agent_url: 'https://two.example.com/mcp', lifecycle_stage: 'production', last_checked_at: null },
    ]);
    mocks.comply.mockResolvedValue(complianceResult);
    mocks.recordComplianceRun
      .mockResolvedValueOnce({ run: { id: 'run-one' }, statusTransition: null, storyboardStatuses: [] })
      .mockResolvedValueOnce({ run: { id: 'run-two' }, statusTransition: null, storyboardStatuses: [] });
    mocks.getVerificationProfileShadowRollout
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ enabled: false });
    mocks.recordVerificationProfileShadowAssessment.mockImplementationOnce(async () => {
      expect(mocks.recordComplianceRun).toHaveBeenCalledTimes(2);
      return true;
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 2 })).resolves.toEqual({
      checked: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });

    expect(mocks.getVerificationProfileShadowRollout).toHaveBeenCalledTimes(2);
    expect(mocks.recordVerificationProfileShadowAssessment).toHaveBeenCalledTimes(1);
    expect(mocks.recordVerificationProfileShadowAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRunId: 'run-one' }),
    );
  });

  it('fails shadow collection closed when its setting cannot be read', async () => {
    mocks.getVerificationProfileShadowRollout.mockRejectedValueOnce(new Error('settings unavailable'));
    mocks.comply.mockResolvedValueOnce({
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-setting-failure' },
      statusTransition: null,
      storyboardStatuses: [],
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 1 })).resolves.toEqual({
      checked: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
    // Pure derivation may be queued after public processing, but a failed
    // bounded setting read must prevent any shadow persistence.
    expect(mocks.deriveVerificationProfileShadowAssessment).toHaveBeenCalledOnce();
    expect(mocks.recordVerificationProfileShadowAssessment).not.toHaveBeenCalled();
  });

  it('keeps public compliance successful when retention cleanup fails', async () => {
    mocks.comply.mockResolvedValueOnce({
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-prune-failure' },
      statusTransition: null,
      storyboardStatuses: [],
    });
    mocks.pruneVerificationProfileShadowAssessments.mockRejectedValueOnce(new Error('cleanup unavailable'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 1 })).resolves.toEqual({
      checked: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('counts malformed saved Basic auth as a checked failure', async () => {
    mocks.comply.mockRejectedValueOnce(new Error('step.auth.basic.username must be a non-empty string'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 1, passed: 0, failed: 1, skipped: 0 });
    expect(mocks.comply).toHaveBeenCalledWith(
      'https://agent.example.com/mcp',
      expect.objectContaining({
        timeout_ms: 600_000,
      }),
      target,
    );
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

  it('defers on the normal cadence and skips when no trustworthy target exists', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([
      { agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing', last_checked_at: null },
    ]);
    mocks.getRecentSupportedVersions.mockResolvedValueOnce([]);
    mocks.selectComplianceTargetForAgentSelection.mockResolvedValueOnce({
      target,
      confirmed: false,
      source: 'default',
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.comply).not.toHaveBeenCalled();
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
  });

  it('does not record a fallback failure when an error occurs before target selection', async () => {
    mocks.resolveOwnerAuth.mockRejectedValueOnce(new Error('credential store unavailable'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.comply).not.toHaveBeenCalled();
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
  });

  it('does not publish a stored-target result superseded by the live run profile', async () => {
    mocks.comply.mockResolvedValueOnce({
      overall_status: 'failing',
      summary: { headline: 'Version mismatch' },
      agent_profile: { adcp_supported_versions: ['3.0'] },
      observations: [],
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp');
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
  });
});
