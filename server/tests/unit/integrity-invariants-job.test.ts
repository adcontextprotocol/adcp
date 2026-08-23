import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectEnvMismatch: vi.fn(),
  runAllInvariants: vi.fn(),
  notifySystemError: vi.fn(),
  claimEscalationNotification: vi.fn(),
  createEscalation: vi.fn(),
  markNotificationSent: vi.fn(),
  releaseEscalationNotificationClaim: vi.fn(),
  getEscalationChannel: vi.fn(),
  sendChannelMessage: vi.fn(),
  getPool: vi.fn(() => ({ query: vi.fn() })),
  getWorkos: vi.fn(() => ({})),
}));

async function loadJob(stripeValue: unknown = { customers: {} }) {
  vi.resetModules();

  vi.doMock('../../src/audit/integrity/index.js', () => ({
    ALL_INVARIANTS: [{ name: 'stripe-customer-resolves' }],
    runAllInvariants: mocks.runAllInvariants,
  }));
  vi.doMock('../../src/audit/integrity/env-mismatch.js', () => ({
    detectEnvMismatch: mocks.detectEnvMismatch,
  }));
  vi.doMock('../../src/db/client.js', () => ({
    getPool: mocks.getPool,
  }));
  vi.doMock('../../src/billing/stripe-client.js', () => ({
    stripe: stripeValue,
  }));
  vi.doMock('../../src/auth/workos-client.js', () => ({
    getWorkos: mocks.getWorkos,
  }));
  vi.doMock('../../src/addie/error-notifier.js', () => ({
    notifySystemError: mocks.notifySystemError,
  }));
  vi.doMock('../../src/db/escalation-db.js', () => ({
    claimEscalationNotification: mocks.claimEscalationNotification,
    createEscalation: mocks.createEscalation,
    markNotificationSent: mocks.markNotificationSent,
    releaseEscalationNotificationClaim: mocks.releaseEscalationNotificationClaim,
  }));
  vi.doMock('../../src/db/system-settings-db.js', () => ({
    getEscalationChannel: mocks.getEscalationChannel,
  }));
  vi.doMock('../../src/slack/client.js', () => ({
    sendChannelMessage: mocks.sendChannelMessage,
  }));

  return import('../../src/addie/jobs/integrity-invariants.js');
}

describe('runIntegrityInvariantsJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.detectEnvMismatch.mockReturnValue(undefined);
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 0,
      violations_by_severity: { critical: 0, warning: 0, info: 0 },
      violations: [],
    });
    mocks.createEscalation.mockResolvedValue({
      id: 42,
      notification_claimed_at: null,
      notification_sent_at: null,
      notification_message_ts: null,
    });
    mocks.claimEscalationNotification.mockResolvedValue(true);
    mocks.markNotificationSent.mockResolvedValue(undefined);
    mocks.releaseEscalationNotificationClaim.mockResolvedValue(undefined);
    mocks.getEscalationChannel.mockResolvedValue({
      channel_id: 'C_ESCALATIONS',
      channel_name: 'admin-escalations',
    });
    mocks.sendChannelMessage.mockResolvedValue({ ok: true, ts: '123.456' });
  });

  it('notifies when the invariant runner is skipped due to environment mismatch', async () => {
    mocks.detectEnvMismatch.mockReturnValue('live Stripe key against staging database');
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: false,
      skippedReason: 'live Stripe key against staging database',
    }));
    expect(mocks.runAllInvariants).not.toHaveBeenCalled();
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: 'Integrity invariants skipped: live Stripe key against staging database',
    });
  });

  it('notifies when Stripe is not configured', async () => {
    const { runIntegrityInvariantsJob } = await loadJob(null);

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: false,
      skippedReason: 'STRIPE_SECRET_KEY not set',
    }));
    expect(mocks.runAllInvariants).not.toHaveBeenCalled();
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: 'Integrity invariants skipped: STRIPE_SECRET_KEY not set',
    });
  });

  it('notifies with a critical violation summary when invariants find stale Stripe state', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-customer-resolves',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_1',
        message: 'Org references non-existent Stripe customer cus_missing',
      }],
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: true,
      totalViolations: 1,
      criticalViolations: 1,
    }));
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: expect.stringContaining('stripe-customer-resolves'),
    });
  });

  it('persists and routes paying-member Stripe reflection blockers as urgent escalations', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
        remediation_hint: 'Run the canonical account sync.',
      }],
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 1,
      escalationErrors: 0,
    }));
    expect(mocks.createEscalation).toHaveBeenCalledWith(expect.objectContaining({
      category: 'needs_human_action',
      priority: 'urgent',
      dedup_key: 'integrity:stripe-sub-reflected-in-org-row:org_123',
    }));
    expect(mocks.claimEscalationNotification).toHaveBeenCalledWith(42);
    expect(mocks.sendChannelMessage).toHaveBeenCalledWith(
      'C_ESCALATIONS',
      { text: expect.stringContaining('/admin/accounts/org_123') },
      { requirePrivate: true },
    );
    expect(mocks.markNotificationSent).toHaveBeenCalledWith(42, 'C_ESCALATIONS', '123.456');
  });

  it('does not create a second Slack thread for an existing active escalation', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
      }],
    });
    mocks.createEscalation.mockResolvedValue({
      id: 42,
      notification_claimed_at: null,
      notification_sent_at: new Date('2026-08-19T00:00:00Z'),
      notification_message_ts: 'existing-thread-ts',
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 0,
      escalationErrors: 0,
    }));
    expect(mocks.getEscalationChannel).not.toHaveBeenCalled();
    expect(mocks.claimEscalationNotification).not.toHaveBeenCalled();
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
  });

  it('keeps the escalation durable when no Slack escalation channel is configured', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
      }],
    });
    mocks.getEscalationChannel.mockResolvedValue({
      channel_id: null,
      channel_name: null,
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 0,
      escalationErrors: 0,
    }));
    expect(mocks.createEscalation).toHaveBeenCalledOnce();
    expect(mocks.releaseEscalationNotificationClaim).toHaveBeenCalledWith(42);
    expect(mocks.sendChannelMessage).not.toHaveBeenCalled();
    expect(mocks.markNotificationSent).not.toHaveBeenCalled();
  });

  it('atomically routes only one Slack notification across concurrent runs', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
      }],
    });
    mocks.claimEscalationNotification
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { runIntegrityInvariantsJob } = await loadJob();

    const [first, second] = await Promise.all([
      runIntegrityInvariantsJob(),
      runIntegrityInvariantsJob(),
    ]);

    expect(first.durableEscalations + second.durableEscalations).toBe(2);
    expect(first.escalationNotifications + second.escalationNotifications).toBe(1);
    expect(mocks.createEscalation).toHaveBeenCalledTimes(2);
    expect(mocks.claimEscalationNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendChannelMessage).toHaveBeenCalledOnce();
    expect(mocks.markNotificationSent).toHaveBeenCalledOnce();
  });

  it('keeps the notification claim when Slack succeeds but recording its timestamp fails', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
      }],
    });
    mocks.markNotificationSent.mockRejectedValue(new Error('database unavailable'));
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 1,
      escalationErrors: 1,
    }));
    expect(mocks.releaseEscalationNotificationClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['channel lookup throws', () => {
      mocks.getEscalationChannel.mockRejectedValue(new Error('settings unavailable'));
    }],
    ['Slack rejects the message', () => {
      mocks.sendChannelMessage.mockResolvedValue({ ok: false, error: 'not_in_channel' });
    }],
  ])('preserves the durable escalation and releases the claim when %s', async (_name, arrange) => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_123',
        message: 'Stripe is active but the organization row has no subscription status.',
      }],
    });
    arrange();
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 0,
      escalationErrors: 1,
    }));
    expect(mocks.releaseEscalationNotificationClaim).toHaveBeenCalledWith(42);
    expect(mocks.markNotificationSent).not.toHaveBeenCalled();
  });

  it('continues processing after one escalation cannot be persisted', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 2,
      violations_by_severity: { critical: 2, warning: 0, info: 0 },
      violations: [
        {
          invariant: 'stripe-sub-reflected-in-org-row',
          severity: 'critical',
          subject_type: 'organization',
          subject_id: 'org_failed',
          message: 'First organization is stale.',
        },
        {
          invariant: 'stripe-sub-reflected-in-org-row',
          severity: 'critical',
          subject_type: 'organization',
          subject_id: 'org_succeeded',
          message: 'Second organization is stale.',
        },
      ],
    });
    mocks.createEscalation
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({
        id: 43,
        notification_claimed_at: null,
        notification_sent_at: null,
        notification_message_ts: null,
      });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      durableEscalations: 1,
      escalationNotifications: 1,
      escalationErrors: 1,
    }));
    expect(mocks.createEscalation).toHaveBeenCalledTimes(2);
    expect(mocks.markNotificationSent).toHaveBeenCalledWith(43, 'C_ESCALATIONS', '123.456');
  });

  it('does not escalate warning-level orphan customers', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 0, warning: 1, info: 0 },
      violations: [{
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'warning',
        subject_type: 'customer',
        subject_id: 'customer_orphan',
        message: 'Membership customer is not linked to an organization.',
      }],
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result.durableEscalations).toBe(0);
    expect(mocks.createEscalation).not.toHaveBeenCalled();
  });
});
