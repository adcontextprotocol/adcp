import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_VERSION } from '@adcp/sdk';

const mocks = vi.hoisted(() => ({
  getAgentsDueForCheck: vi.fn(),
  getLastKnownSupportedVersions: vi.fn(),
  getLatestComplianceAttempt: vi.fn(),
  getRecentHeartbeatAttempts: vi.fn(),
  countComplianceRuns: vi.fn(),
  deferComplianceCheckAfterInconclusiveTarget: vi.fn(),
  deferComplianceCheckAfterContention: vi.fn(),
  resolveOwnerAuth: vi.fn(),
  recordComplianceRun: vi.fn(),
  getBadgesForAgent: vi.fn(),
  revokeBadge: vi.fn(),
  getRegistryMetadata: vi.fn(),
  query: vi.fn(),
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
  recordVerificationProfileShadowAssessment: vi.fn(),
  pruneVerificationProfileShadowAssessments: vi.fn(),
  deriveVerificationProfileShadowAssessment: vi.fn(),
  acquireHeartbeatExecutionFence: vi.fn(),
  releaseExecutionFence: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({
      debug: mocks.loggerDebug,
      info: mocks.loggerInfo,
      warn: mocks.loggerWarn,
      error: mocks.loggerError,
    }),
  },
}));

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: class {
    getAgentsDueForCheck = mocks.getAgentsDueForCheck;
    getLastKnownSupportedVersions = mocks.getLastKnownSupportedVersions;
    getLatestComplianceAttempt = mocks.getLatestComplianceAttempt;
    getRecentHeartbeatAttempts = mocks.getRecentHeartbeatAttempts;
    countComplianceRuns = mocks.countComplianceRuns;
    deferComplianceCheckAfterInconclusiveTarget = mocks.deferComplianceCheckAfterInconclusiveTarget;
    deferComplianceCheckAfterContention = mocks.deferComplianceCheckAfterContention;
    resolveOwnerAuth = mocks.resolveOwnerAuth;
    recordComplianceRun = mocks.recordComplianceRun;
    getBadgesForAgent = mocks.getBadgesForAgent;
    revokeBadge = mocks.revokeBadge;
    getRegistryMetadata = mocks.getRegistryMetadata;
  },
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
}));

vi.mock('../../src/db/compliance-refresh-requests-db.js', () => ({
  COMPLIANCE_HEARTBEAT_GLOBAL_RUNNING_LIMIT: 2,
  ComplianceRefreshRequestsDatabase: class {
    acquireHeartbeatExecutionFence = mocks.acquireHeartbeatExecutionFence;
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
  selectedComplianceTargetMatchesObservedProfile: (
    selection: { source?: string; target?: { requested?: string } },
    profile?: { adcp_supported_versions?: string[] },
  ) => !['stored', 'live'].includes(selection.source ?? '')
    || Boolean(profile?.adcp_supported_versions?.includes(selection.target?.requested ?? '')),
  selectComplianceTargetForAgentSelection: mocks.selectComplianceTargetForAgentSelection,
}));

vi.mock('../../src/services/hosted-compliance-version.js', () => ({
  hostedComplianceTarget: mocks.hostedComplianceTarget,
  HOSTED_FULL_COMPLIANCE_TIMEOUT_MS: 600_000,
  HOSTED_EXTENDED_COMPLIANCE_TIMEOUT_MS: 1_800_000,
  HOSTED_COMPLIANCE_OVERRUN_MS: 300_000,
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

vi.mock('../../src/db/verification-profile-shadow-db.js', () => ({
  recordVerificationProfileShadowAssessment: mocks.recordVerificationProfileShadowAssessment,
  pruneVerificationProfileShadowAssessments: mocks.pruneVerificationProfileShadowAssessments,
}));

vi.mock('../../src/services/verification-profile-shadow.js', () => ({
  VERIFICATION_PROFILE_SHADOW_POLICY_VERSION: 'verification-profiles-v3',
  deriveVerificationProfileShadowAssessment: mocks.deriveVerificationProfileShadowAssessment,
}));

vi.mock('../../src/notifications/compliance.js', () => ({
  notifyComplianceChange: vi.fn(),
  notifyComplianceTimeout: vi.fn(),
  notifyVerificationChange: vi.fn(),
}));

vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: vi.fn(),
}));

const sqlCalls = (fragment: string) => mocks.query.mock.calls.filter(([sql]) => String(sql).includes(fragment));
const claimCalls = () => sqlCalls('INSERT INTO agent_registry_metadata');
const reconcileCalls = () => sqlCalls('WITH orphaned');
const startMarkerCalls = () => sqlCalls('SET heartbeat_started_at = NOW()');
const releaseCalls = () => sqlCalls('heartbeat_orphan_streak = CASE WHEN heartbeat_started_at IS NOT NULL THEN 0');
const unstartedReleaseCalls = () => sqlCalls('AND heartbeat_started_at IS NULL');

describe('runComplianceHeartbeatJob', () => {
  const target = { requested: '3.1', version: '3.1.0' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostedComplianceTarget.mockReturnValue(target);
    mocks.getAgentsDueForCheck.mockResolvedValue([
      { agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing', last_checked_at: null, heartbeat_orphan_streak: 0 },
    ]);
    mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => ({
      rows: sql.includes('INSERT INTO agent_registry_metadata')
        ? ((params?.[0] as string[]) ?? []).map(agent_url => ({ agent_url })) : [],
      rowCount: 0,
    }));
    mocks.resolveOwnerAuth.mockResolvedValue(undefined);
    mocks.getLastKnownSupportedVersions.mockResolvedValue(['3.1']);
    mocks.getLatestComplianceAttempt.mockResolvedValue(null);
    mocks.getRecentHeartbeatAttempts.mockResolvedValue([]);
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
    mocks.acquireHeartbeatExecutionFence.mockResolvedValue({
      isValid: () => true,
      release: mocks.releaseExecutionFence,
    });
  });

  it('stops before selecting agents when the scheduler has aborted the batch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('heartbeat execution timed out'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await expect(runComplianceHeartbeatJob({ limit: 1 }, controller.signal))
      .rejects.toThrow('heartbeat execution timed out');

    expect(mocks.getAgentsDueForCheck).not.toHaveBeenCalled();
    expect(mocks.acquireHeartbeatExecutionFence).not.toHaveBeenCalled();
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
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO agent_registry_metadata')))
      .toHaveLength(0);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { eligibleBacklog: 0, selectedCount: 0, batchLimit: 1 },
        inputs: expect.objectContaining({ policyVersion: 'verification-profiles-v3' }),
        outcomes: { checked: 0, passed: 0, failed: 0, skipped: 0 },
        shadow: expect.objectContaining({ candidates: 0, attempted: 0, errors: 0 }),
      }),
      'Compliance heartbeat shadow flush completed after public processing',
    );
  });

  it('returns bounded operational evidence for the scheduled worker', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([{
      agent_url: 'https://agent.example.com/mcp',
      lifecycle_stage: 'testing',
      last_checked_at: null,
      eligible_backlog: 35,
    }]);
    mocks.complianceResultToDbInput.mockReturnValueOnce({
      agent_url: 'https://agent.example.com/mcp',
      lifecycle_stage: 'testing',
      overall_status: 'failing',
      headline: 'Incomplete run',
      tracks_json: [],
      storyboard_statuses: [],
      dry_run: false,
      completeness: 'timed_out',
      is_authoritative: false,
    });
    mocks.comply.mockResolvedValueOnce({
      completeness: 'timed_out',
      agent_profile: { adcp_supported_versions: ['3.1'] },
      summary: { headline: 'Incomplete run' },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'audit-run' },
      statusTransition: null,
      storyboardStatuses: [],
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1, includeOperationalDiagnostics: true });

    expect(result).toMatchObject({
      checked: 0,
      skipped: 1,
      diagnostics: {
        eligibleBacklog: 35,
        selectedAgents: ['https://agent.example.com/mcp'],
        runsRecorded: 1,
        requestedComplianceTarget: '3.1',
        complianceBundleVersion: '3.1.0',
        skipReasons: expect.objectContaining({ audit_only: 1 }),
      },
    });
  });

  it('fills the global suite slots and starts the next agent as soon as one finishes', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([
      { agent_url: 'https://one.example/mcp', lifecycle_stage: 'testing', last_checked_at: null },
      { agent_url: 'https://two.example/mcp', lifecycle_stage: 'testing', last_checked_at: null },
      { agent_url: 'https://three.example/mcp', lifecycle_stage: 'testing', last_checked_at: null },
      { agent_url: 'https://four.example/mcp', lifecycle_stage: 'testing', last_checked_at: null },
    ]);
    const started = new Set<string>();
    const releases = new Map<string, () => void>();
    mocks.comply.mockImplementation(async (agentUrl: string) => {
      started.add(agentUrl);
      await new Promise<void>(resolve => { releases.set(agentUrl, resolve); });
      return { completeness: 'timed_out', agent_profile: { adcp_supported_versions: ['3.1'] }, summary: { headline: 'Incomplete run' } };
    });
    mocks.complianceResultToDbInput.mockImplementation((_result, agentUrl: string) => ({
      agent_url: agentUrl, lifecycle_stage: 'testing', overall_status: 'failing', tracks_json: [],
      storyboard_statuses: [], dry_run: false, completeness: 'timed_out', is_authoritative: false,
    }));
    mocks.recordComplianceRun.mockResolvedValue({ run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [] });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const running = runComplianceHeartbeatJob({ limit: 4 });
    try {
      await vi.waitFor(() => expect(started.size).toBe(2));
      expect(started.has('https://three.example/mcp')).toBe(false);
      expect(started.has('https://four.example/mcp')).toBe(false);
      releases.get('https://one.example/mcp')?.();
      await vi.waitFor(() => expect(started.size).toBe(3));
      expect(started.has('https://four.example/mcp')).toBe(false);
      releases.get('https://two.example/mcp')?.();
      await vi.waitFor(() => expect(started.size).toBe(4));
    } finally {
      for (const release of releases.values()) release();
    }
    await expect(running).resolves.toEqual({ checked: 0, passed: 0, failed: 0, skipped: 4 });
    expect(mocks.acquireHeartbeatExecutionFence).toHaveBeenCalledTimes(4);
  });

  it('attributes recorded heartbeat evidence to the saved credential organization', async () => {
    mocks.resolveOwnerAuth.mockImplementationOnce(async (_url, _checkpoint, onResolvedOrg) => {
      onResolvedOrg('org_credential_owner');
      return { type: 'bearer', token: 'fixture-token' };
    });
    mocks.complianceResultToDbInput.mockReturnValueOnce({
      agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing', overall_status: 'failing',
      tracks_json: [], storyboard_statuses: [], dry_run: false, completeness: 'timed_out', is_authoritative: false,
    });
    mocks.comply.mockResolvedValueOnce({
      completeness: 'timed_out', agent_profile: { adcp_supported_versions: ['3.1'] }, summary: { headline: 'Incomplete run' },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({ run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [] });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await runComplianceHeartbeatJob({ limit: 1 });

    expect(mocks.recordComplianceRun).toHaveBeenCalledWith(
      expect.objectContaining({ triggered_org_id: 'org_credential_owner' }),
    );
  });

  it.each([true, false])('preserves badges, notifications, and public timestamps for a timed-out run (eligible=%s)', async eligible => {
    const partialInput = {
      agent_url: 'https://agent.example.com/mcp', overall_status: 'failing',
      completeness: 'timed_out', is_authoritative: false,
      tracks_json: [], storyboard_statuses: [], replace_storyboard_statuses: true,
    };
    mocks.complianceResultToDbInput.mockReturnValue(partialInput);
    mocks.comply.mockResolvedValue({
      completeness: 'timed_out', overall_status: 'passing', observations: [],
      agent_profile: { specialisms: eligible ? ['signals-audience-activation'] : [], adcp_supported_versions: ['3.1'] },
      summary: { headline: 'Incomplete run' },
    });
    mocks.recordComplianceRun.mockResolvedValue({ run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [] });
    mocks.badgeEligibleVersionsForTargetSelection.mockReturnValue(eligible ? ['3.1'] : []);
    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const { notifyComplianceChange, notifyVerificationChange } = await import('../../src/notifications/compliance.js');
    expect(await runComplianceHeartbeatJob({ limit: 1 })).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    const healthCall = mocks.loggerInfo.mock.calls.find(
      ([, message]) => message === 'Compliance heartbeat shadow flush completed after public processing',
    );
    expect(healthCall).toBeDefined();
    const healthFields = healthCall?.[0] as {
      outcomes: { skipped: number };
      skipReasons: Record<string, number>;
    };
    expect(healthFields.skipReasons.audit_only).toBe(1);
    expect(Object.values(healthFields.skipReasons).reduce((total, count) => total + count, 0))
      .toBe(healthFields.outcomes.skipped);
    expect(mocks.recordComplianceRun).toHaveBeenCalledWith(expect.objectContaining({ completeness: 'timed_out', is_authoritative: false, dry_run: false }));
    expect(mocks.runBadgeFanOut).not.toHaveBeenCalled();
    expect(mocks.revokeUnsupportedPublicBadges).not.toHaveBeenCalled();
    expect(notifyComplianceChange).not.toHaveBeenCalled();
    expect(notifyVerificationChange).not.toHaveBeenCalled();
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp', { exponentialBackoff: true });
    expect(mocks.query.mock.calls.every(([sql]) => !String(sql).includes('last_checked_at'))).toBe(true);
    expect(claimCalls()[0][0]).toContain('next_compliance_check_at');
  });

  // adcp#8268 — a heartbeat that runs out of time is never published, so the
  // owner's only signal is a card that silently stops advancing unless we DM
  // them. Both shapes count: a runner-reported `timed_out`, and a run the hard
  // deadline had to abort (recorded `not_completed` under a timeout headline).
  describe('timed-out heartbeat owner notification', () => {
    const COVERAGE_MESSAGE =
      'Compliance timeout budget of 600000ms was reached. Stopped starting new storyboards after 68/74 selected storyboard(s).';
    const AGENT_URL = 'https://agent.example.com/mcp';

    const heartbeatRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'audit-run',
      tested_at: new Date('2026-10-01T10:07:00Z'),
      completeness: 'timed_out',
      headline: 'Assessment stopped at the time budget',
      total_duration_ms: 654_321,
      provenance_json: { timeout_ms: 600_000 },
      observations_json: [{ category: 'performance', severity: 'warning', message: COVERAGE_MESSAGE }],
      ...overrides,
    });

    const arrangeTimedOutRun = () => {
      mocks.comply.mockResolvedValue({
        completeness: 'timed_out', overall_status: 'passing',
        observations: [{ category: 'performance', severity: 'warning', message: COVERAGE_MESSAGE }],
        agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
        summary: { headline: 'Incomplete run' },
      });
      mocks.complianceResultToDbInput.mockReturnValue({
        agent_url: AGENT_URL, overall_status: 'failing',
        completeness: 'timed_out', is_authoritative: false, total_duration_ms: 654_321,
        tracks_json: [], storyboard_statuses: [], replace_storyboard_statuses: true,
      });
      mocks.recordComplianceRun.mockResolvedValue({
        run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [],
      });
      mocks.getRecentHeartbeatAttempts.mockResolvedValue([heartbeatRow()]);
    };

    it('tells the owner what timed out, for how long, and against which budget', async () => {
      arrangeTimedOutRun();
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      expect(notifyComplianceTimeout).toHaveBeenCalledWith({
        agentUrl: AGENT_URL,
        summary: 'Last heartbeat timed out at 2026-10-01T10:07:00.000Z after 654s of its 600s budget'
          + ' (68/74 storyboards completed). The published compliance result was not updated.',
      });
    });

    it('also notifies when the hard deadline had to abort a hung runner', async () => {
      mocks.comply.mockRejectedValue(new Error('The operation timed out'));
      mocks.recordComplianceRun.mockResolvedValue({
        run: { id: 'aborted-run' }, statusTransition: null, storyboardStatuses: [],
      });
      mocks.getRecentHeartbeatAttempts.mockResolvedValue([heartbeatRow({
        id: 'aborted-run',
        completeness: 'not_completed',
        headline: 'Timed out: assessment did not complete within 600s',
        total_duration_ms: 912_000,
        observations_json: [],
      })]);
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      // The aborted run is recorded with the wall-clock it burned and the
      // budget it was given, so the DM can name both.
      expect(mocks.recordComplianceRun).toHaveBeenCalledWith(expect.objectContaining({
        completeness: 'not_completed',
        headline: 'Timed out: assessment did not complete within 600s',
        total_duration_ms: expect.any(Number),
        provenance_json: expect.objectContaining({ timeout_ms: 600_000 }),
      }));
      expect(notifyComplianceTimeout).toHaveBeenCalledWith(expect.objectContaining({
        summary: expect.stringContaining('after 912s of its 600s budget'),
      }));
    });

    it('reports the escalated budget the run actually received', async () => {
      arrangeTimedOutRun();
      mocks.getLatestComplianceAttempt.mockResolvedValueOnce({
        completeness: 'complete', total_duration_ms: 590_000,
      });
      mocks.getRecentHeartbeatAttempts.mockResolvedValue([
        heartbeatRow({ provenance_json: { timeout_ms: 1_800_000 } }),
      ]);
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      expect(mocks.comply).toHaveBeenCalledWith(
        AGENT_URL, expect.objectContaining({ timeout_ms: 1_800_000 }), target,
      );
      expect(notifyComplianceTimeout).toHaveBeenCalledWith(expect.objectContaining({
        summary: expect.stringContaining('after 654s of its 1800s budget'),
      }));
    });

    it('stays quiet while the agent is already in a timed-out streak', async () => {
      arrangeTimedOutRun();
      mocks.getRecentHeartbeatAttempts.mockResolvedValue([heartbeatRow(), heartbeatRow({ id: 'older' })]);
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      expect(notifyComplianceTimeout).not.toHaveBeenCalled();
    });

    // A co-claiming organization can run its own owner_test against the same
    // URL at will. Reading the heartbeat stream — not the newest run of any
    // trigger — keeps it from suppressing or duplicating the owner's alert.
    it('ignores non-heartbeat runs when deciding whether the streak is new', async () => {
      arrangeTimedOutRun();
      mocks.getLatestComplianceAttempt.mockResolvedValueOnce({ completeness: 'timed_out' });
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      expect(mocks.getRecentHeartbeatAttempts).toHaveBeenCalledWith(AGENT_URL, null, 20);
      expect(notifyComplianceTimeout).toHaveBeenCalledTimes(1);
    });

    it('does not notify for audit-only runs that completed inside the budget', async () => {
      mocks.comply.mockResolvedValue({
        completeness: 'complete', overall_status: 'auth_required', observations: [],
        agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
        summary: { headline: 'Auth required' },
      });
      mocks.complianceResultToDbInput.mockReturnValue({
        agent_url: AGENT_URL, overall_status: 'failing',
        completeness: 'complete', is_authoritative: false,
        tracks_json: [], storyboard_statuses: [], replace_storyboard_statuses: true,
      });
      mocks.recordComplianceRun.mockResolvedValue({
        run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [],
      });
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await runComplianceHeartbeatJob({ limit: 1 });

      expect(notifyComplianceTimeout).not.toHaveBeenCalled();
      expect(mocks.getRecentHeartbeatAttempts).not.toHaveBeenCalled();
    });

    it('keeps the batch running when the owner notification fails', async () => {
      arrangeTimedOutRun();
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');
      vi.mocked(notifyComplianceTimeout).mockRejectedValueOnce(new Error('Slack is down'));
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');

      await expect(runComplianceHeartbeatJob({ limit: 1 }))
        .resolves.toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
      expect(mocks.releaseExecutionFence).toHaveBeenCalled();
    });

    it('keeps the batch running when the streak lookup fails', async () => {
      arrangeTimedOutRun();
      mocks.getRecentHeartbeatAttempts.mockRejectedValueOnce(new Error('Transient database failure'));
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');

      await expect(runComplianceHeartbeatJob({ limit: 1 }))
        .resolves.toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
      expect(notifyComplianceTimeout).not.toHaveBeenCalled();
    });

    it('stops waiting on a hanging notification instead of holding the suite slot', async () => {
      arrangeTimedOutRun();
      const { notifyComplianceTimeout } = await import('../../src/notifications/compliance.js');
      // Slack has no fetch timeout and sleeps a minute per rate-limited retry.
      // The agent still holds its execution fence here, so the worker must not
      // let that decide how long the slot stays occupied.
      vi.mocked(notifyComplianceTimeout).mockReturnValueOnce(new Promise<void>(() => {}));
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');

      vi.useFakeTimers();
      try {
        const running = runComplianceHeartbeatJob({ limit: 1 });
        await vi.advanceTimersByTimeAsync(20_000);
        await expect(running).resolves.toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
      } finally {
        vi.useRealTimers();
      }
      expect(mocks.releaseExecutionFence).toHaveBeenCalled();
    });
  });

  it.each(['record', 'defer'])('keeps a timed-out run audit-only after a transient %s failure', async failure => {
    mocks.comply.mockResolvedValue({
      completeness: 'timed_out', overall_status: 'passing', observations: [],
      agent_profile: { adcp_supported_versions: ['3.1'] }, summary: { headline: 'Incomplete run' },
    });
    mocks.complianceResultToDbInput.mockReturnValue({
      agent_url: 'https://agent.example.com/mcp', completeness: 'timed_out', is_authoritative: false,
      overall_status: 'passing', tracks_json: [], storyboard_statuses: [],
    });
    mocks.recordComplianceRun.mockResolvedValue({ run: { id: 'audit-run' }, statusTransition: null, storyboardStatuses: [] });
    if (failure === 'record') mocks.recordComplianceRun.mockRejectedValueOnce(new Error('Transient database failure'));
    else mocks.deferComplianceCheckAfterInconclusiveTarget.mockRejectedValueOnce(new Error('Transient scheduling failure'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const { notifyComplianceChange, notifyVerificationChange } = await import('../../src/notifications/compliance.js');
    expect(await runComplianceHeartbeatJob({ limit: 1 })).toMatchObject({ checked: 0, skipped: 1 });
    expect(mocks.recordComplianceRun).toHaveBeenCalledTimes(2);
    expect(mocks.recordComplianceRun.mock.calls.every(([input]) => input.is_authoritative === false)).toBe(true);
    expect(mocks.runBadgeFanOut).not.toHaveBeenCalled();
    expect(mocks.revokeUnsupportedPublicBadges).not.toHaveBeenCalled();
    expect(notifyComplianceChange).not.toHaveBeenCalled();
    expect(notifyVerificationChange).not.toHaveBeenCalled();
  });

  it('reports the full due backlog without increasing the selected batch', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([
      {
        agent_url: 'https://agent.example.com/mcp',
        lifecycle_stage: 'testing',
        last_checked_at: null,
        eligible_backlog: 37,
      },
    ]);
    mocks.comply.mockResolvedValueOnce({
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    });
    mocks.recordComplianceRun.mockResolvedValueOnce({
      run: { id: 'run-backlog' },
      statusTransition: null,
      storyboardStatuses: [],
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    await runComplianceHeartbeatJob({ limit: 1 });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { eligibleBacklog: 37, selectedCount: 1, batchLimit: 1 },
      }),
      'Compliance heartbeat shadow flush completed after public processing',
    );
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
      expect.stringContaining('RETURNING agent_url'),
      [['https://agent.example.com/mcp'], expect.any(Date), expect.any(String)],
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

  it('uses the extended budget after a timed-out attempt and retains it for slow complete suites', async () => {
    const runOnce = async () => {
      mocks.comply.mockResolvedValueOnce({
        overall_status: 'passing',
        summary: { headline: 'All good' },
        agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
      });
      mocks.recordComplianceRun.mockResolvedValueOnce({
        run: { id: 'extended-run' }, statusTransition: null, storyboardStatuses: [],
      });
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      await runComplianceHeartbeatJob({ limit: 1 });
      expect(mocks.comply).toHaveBeenCalledWith(
        'https://agent.example.com/mcp',
        expect.objectContaining({ timeout_ms: 1_800_000 }),
        target,
      );
      mocks.comply.mockClear();
    };

    mocks.getLatestComplianceAttempt.mockResolvedValueOnce({ completeness: 'timed_out' });
    await runOnce();
    mocks.getLatestComplianceAttempt.mockResolvedValueOnce({
      completeness: 'complete', total_duration_ms: 1_200_000,
    });
    await runOnce();
  });

  it('retries soon without executing when a suite slot or agent fence is busy', async () => {
    mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce(null);

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterContention)
      .toHaveBeenCalledWith('https://agent.example.com/mcp', expect.any(Date));
    expect(mocks.comply).not.toHaveBeenCalled();
  });

  it('does not persist when the shared execution fence is lost during comply', async () => {
    let fenceValid = true;
    mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce({
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
    mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce({
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

  it('records comparison evidence from every authoritative heartbeat', async () => {
    const complianceResult = {
      overall_status: 'passing',
      summary: { headline: 'All good' },
      agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
    };
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
  });

  it('keeps public compliance successful when shadow persistence fails', async () => {
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

  it('flushes every comparison write after public processing', async () => {
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

    expect(mocks.recordVerificationProfileShadowAssessment).toHaveBeenCalledTimes(2);
    expect(mocks.recordVerificationProfileShadowAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRunId: 'run-one' }),
    );
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

  it('records the invoking runner version when comply throws without a result', async () => {
    mocks.comply.mockRejectedValueOnce(new Error('Timed out'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.complianceResultToDbInput).not.toHaveBeenCalled();
    expect(mocks.recordComplianceRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agent_url: 'https://agent.example.com/mcp',
        adcp_version: target.version,
        runner_capability_version: LIBRARY_VERSION,
        overall_status: 'failing',
        triggered_by: 'heartbeat',
        dry_run: false,
      }),
    );
  });

  it('records malformed saved Basic auth as audit-only setup evidence', async () => {
    mocks.comply.mockRejectedValueOnce(new Error('step.auth.basic.username must be a non-empty string'));

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
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
        is_authoritative: false,
        completeness: 'not_completed',
        headline: 'Saved Basic auth credentials are malformed',
        observations_json: [{
          category: 'authentication',
          severity: 'warning',
          message: 'The saved Basic auth credentials for this agent must include a non-empty username.',
        }],
      }),
    );
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp', { exponentialBackoff: true });
  });

  it('backs off target selection when no trustworthy target exists', async () => {
    mocks.getAgentsDueForCheck.mockResolvedValueOnce([
      { agent_url: 'https://agent.example.com/mcp', lifecycle_stage: 'testing', last_checked_at: null },
    ]);
    mocks.getLastKnownSupportedVersions.mockResolvedValueOnce([]);
    mocks.selectComplianceTargetForAgentSelection.mockResolvedValueOnce({
      target,
      confirmed: false,
      source: 'default',
    });

    const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    const result = await runComplianceHeartbeatJob({ limit: 1 });

    expect(result).toEqual({ checked: 0, passed: 0, failed: 0, skipped: 1 });
    expect(mocks.deferComplianceCheckAfterInconclusiveTarget)
      .toHaveBeenCalledWith('https://agent.example.com/mcp', { exponentialBackoff: true });
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
      .toHaveBeenCalledWith('https://agent.example.com/mcp', { exponentialBackoff: true });
    expect(mocks.recordComplianceRun).not.toHaveBeenCalled();
  });

  describe('batch claim ownership', () => {
    const identity = { machineId: 'machine-1', owner: 'machine-1:test-process' };
    const agentUrl = 'https://agent.example.com/mcp';
    const dueAgent = (name: string, heartbeat_orphan_streak = 0) => ({
      agent_url: `https://${name}.example/mcp`,
      lifecycle_stage: 'testing',
      last_checked_at: null,
      heartbeat_orphan_streak,
    });
    const queryOrder = (calls: ReturnType<typeof sqlCalls>) =>
      mocks.query.mock.invocationCallOrder[mocks.query.mock.calls.indexOf(calls[0])];
    const completeRuns = () => {
      mocks.comply.mockResolvedValue({
        overall_status: 'passing',
        summary: { headline: 'All good' },
        agent_profile: { specialisms: [], adcp_supported_versions: ['3.1'] },
      });
      mocks.recordComplianceRun.mockResolvedValue({ run: { id: 'run' }, statusTransition: null, storyboardStatuses: [] });
    };
    const run = async (options: { limit: number }, signal?: AbortSignal) => {
      const { runComplianceHeartbeatJob } = await import('../../src/addie/jobs/compliance-heartbeat.js');
      return runComplianceHeartbeatJob({ ...options, processIdentity: identity }, signal);
    };
    const claimedUrls = () => claimCalls()[0][1][0] as string[];

    it('reconciles orphaned claims for this machine before selecting due agents', async () => {
      completeRuns();
      await run({ limit: 1 });

      expect(reconcileCalls()).toHaveLength(1);
      expect(reconcileCalls()[0][1]).toEqual([identity.owner, 'machine-1:']);
      expect(queryOrder(reconcileCalls())).toBeLessThan(mocks.getAgentsDueForCheck.mock.invocationCallOrder[0]);
    });

    it('claims selected agents under this process identity', async () => {
      completeRuns();
      await run({ limit: 1 });

      expect(claimCalls()[0][1]).toEqual([[agentUrl], expect.any(Date), identity.owner]);
    });

    it('marks the suite started once the execution fence is held and before the suite runs', async () => {
      completeRuns();
      await run({ limit: 1 });

      expect(startMarkerCalls()).toHaveLength(1);
      expect(startMarkerCalls()[0][1]).toEqual([agentUrl, identity.owner]);
      const markerOrder = queryOrder(startMarkerCalls());
      expect(markerOrder).toBeGreaterThan(mocks.acquireHeartbeatExecutionFence.mock.invocationCallOrder[0]);
      expect(markerOrder).toBeLessThan(mocks.comply.mock.invocationCallOrder[0]);
    });

    it('releases the claim after a normal completion without touching the schedule', async () => {
      completeRuns();
      await run({ limit: 1 });

      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0][1]).toEqual([agentUrl, identity.owner]);
      expect(String(releaseCalls()[0][0])).not.toContain('next_compliance_check_at');
      expect(queryOrder(releaseCalls())).toBeGreaterThan(mocks.comply.mock.invocationCallOrder[0]);
    });

    it.each([
      ['the execution fence is busy', () => {
        mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce(null);
      }],
      ['no trustworthy target can be selected', () => {
        mocks.selectComplianceTargetForAgentSelection.mockResolvedValueOnce({ target, confirmed: false, source: 'default' });
      }],
      ['the suite throws', () => {
        mocks.comply.mockRejectedValueOnce(new Error('connection reset'));
      }],
      ['the execution fence is lost', () => {
        mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce({ isValid: () => false, release: mocks.releaseExecutionFence });
      }],
    ])('releases the claim when %s', async (_label, arrange) => {
      completeRuns();
      arrange();

      await expect(run({ limit: 1 })).resolves.toMatchObject({ skipped: 1 });

      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0][1]).toEqual([agentUrl, identity.owner]);
    });

    it('does not mark the suite started when the execution fence is busy', async () => {
      mocks.acquireHeartbeatExecutionFence.mockResolvedValueOnce(null);
      await run({ limit: 1 });

      expect(startMarkerCalls()).toHaveLength(0);
    });

    it('keeps the job result when releasing a claim fails, and reports it', async () => {
      completeRuns();
      mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (String(sql).includes('heartbeat_orphan_streak = CASE WHEN heartbeat_started_at IS NOT NULL THEN 0')) {
          throw new Error('database unavailable');
        }
        return {
          rows: String(sql).includes('INSERT INTO agent_registry_metadata')
            ? ((params?.[0] as string[]) ?? []).map(agent_url => ({ agent_url })) : [],
          rowCount: 0,
        };
      });

      await expect(run({ limit: 1 })).resolves.toMatchObject({ checked: 1 });
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ agentUrl }),
        expect.stringContaining('Failed to release compliance heartbeat claim'),
      );
    });

    it('runs a previously fatal agent alone when it is first in the selection', async () => {
      completeRuns();
      mocks.getAgentsDueForCheck.mockResolvedValueOnce([
        { ...dueAgent('suspect', 2), eligible_backlog: 3 },
        dueAgent('b'),
        dueAgent('c'),
      ]);

      await run({ limit: 3 });

      expect(claimedUrls()).toEqual(['https://suspect.example/mcp']);
      expect(mocks.comply.mock.calls.map(([url]) => url)).toEqual(['https://suspect.example/mcp']);
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        expect.objectContaining({ queue: { eligibleBacklog: 3, selectedCount: 1, batchLimit: 3 } }),
        'Compliance heartbeat shadow flush completed after public processing',
      );
    });

    it('stops the batch before a previously fatal agent later in the selection', async () => {
      completeRuns();
      mocks.getAgentsDueForCheck.mockResolvedValueOnce([
        dueAgent('a'),
        dueAgent('b'),
        dueAgent('suspect', 1),
        dueAgent('d'),
      ]);

      await run({ limit: 4 });

      expect(claimedUrls()).toEqual(['https://a.example/mcp', 'https://b.example/mcp']);
      expect(mocks.comply.mock.calls.map(([url]) => url).sort()).toEqual(['https://a.example/mcp', 'https://b.example/mcp']);
    });

    it('sizes the claim lock for the isolated batch rather than the full selection', async () => {
      completeRuns();
      mocks.getAgentsDueForCheck.mockResolvedValueOnce([
        dueAgent('suspect', 1), dueAgent('b'), dueAgent('c'), dueAgent('d'),
      ]);
      const before = Date.now();

      await run({ limit: 4 });

      // One agent is one wave: budget + target discovery + 5 minute margin.
      const oneWaveMs = 1_800_000 + 300_000 + (2 * 30_000) + 300_000;
      const lockUntil = (claimCalls()[0][1][1] as Date).getTime();
      expect(lockUntil - before).toBeGreaterThanOrEqual(oneWaveMs);
      expect(lockUntil - before).toBeLessThan(oneWaveMs + 10_000);
    });

    it('releases claims that never started when the batch stops on a failure', async () => {
      completeRuns();
      const names = ['one', 'two', 'three', 'four'];
      const urls = names.map(name => `https://${name}.example/mcp`);
      mocks.getAgentsDueForCheck.mockResolvedValueOnce(names.map(name => dueAgent(name)));
      mocks.acquireHeartbeatExecutionFence.mockRejectedValueOnce(new Error('fence store unavailable'));

      await expect(run({ limit: 4 })).rejects.toThrow('fence store unavailable');

      expect(unstartedReleaseCalls()).toHaveLength(1);
      expect(unstartedReleaseCalls()[0][1]).toEqual([urls, identity.owner]);
    });

    it('releases claims that never started when the scheduler aborts the batch', async () => {
      const controller = new AbortController();
      mocks.getAgentsDueForCheck.mockResolvedValueOnce([dueAgent('one'), dueAgent('two'), dueAgent('three')]);
      mocks.comply.mockImplementation(async () => {
        controller.abort(new Error('heartbeat execution timed out'));
        throw new Error('aborted');
      });

      await expect(run({ limit: 3 }, controller.signal)).rejects.toThrow('heartbeat execution timed out');

      expect(unstartedReleaseCalls()).toHaveLength(1);
      expect(unstartedReleaseCalls()[0][1][1]).toBe(identity.owner);
      expect(releaseCalls().map(([, params]) => params[0])).toEqual(
        expect.arrayContaining(['https://one.example/mcp', 'https://two.example/mcp']),
      );
    });
  });
});

describe('assertComplianceHeartbeatOperationalProgress', () => {
  const diagnostics = {
    eligibleBacklog: 56,
    selectedAgents: Array.from({ length: 10 }, (_, index) => `https://agent-${index}.example/mcp`),
    runsRecorded: 0,
    requestedComplianceTarget: '3.0',
    complianceBundleVersion: '3.0.18',
    sdkVersion: LIBRARY_VERSION,
    skipReasons: {
      execution_fence_busy: 0,
      execution_fence_lost: 0,
      target_unconfirmed: 9,
      target_superseded: 1,
      audit_only: 0,
      pre_target_error: 0,
      agent_error: 0,
    },
  };

  it.each([
    ['mixed target skips', { target_unconfirmed: 9, target_superseded: 1 }, 0],
    ['all unconfirmed targets', { target_unconfirmed: 10, target_superseded: 0 }, 0],
    ['one setup error among agent target skips', { target_unconfirmed: 9, target_superseded: 0, pre_target_error: 1 }, 0],
    ['audit-only runs', { target_unconfirmed: 0, target_superseded: 0, audit_only: 10 }, 10],
  ])('treats %s as completed batch work', async (_label, reasons, runsRecorded) => {
    const { assertComplianceHeartbeatOperationalProgress } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    expect(() => assertComplianceHeartbeatOperationalProgress({
      checked: 0, passed: 0, failed: 0, skipped: 10,
      diagnostics: {
        ...diagnostics,
        runsRecorded,
        skipReasons: { ...diagnostics.skipReasons, ...reasons },
      },
    })).not.toThrow();
  });

  it.each([
    ['setup failures', { pre_target_error: 10, agent_error: 0 }],
    ['failed audit persistence', { pre_target_error: 0, agent_error: 10 }],
  ])('reports a batch blocked entirely by %s', async (_label, workerReasons) => {
    const { assertComplianceHeartbeatOperationalProgress } = await import('../../src/addie/jobs/compliance-heartbeat.js');
    expect(() => assertComplianceHeartbeatOperationalProgress({
      checked: 0, passed: 0, failed: 0, skipped: 10,
      diagnostics: {
        ...diagnostics,
        skipReasons: { ...diagnostics.skipReasons, target_unconfirmed: 0, target_superseded: 0, ...workerReasons },
      },
    })).toThrow('Compliance heartbeat could not process any of 10 selected agents');
  });
});
