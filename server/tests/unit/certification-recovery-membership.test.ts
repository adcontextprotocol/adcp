import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStuckAttempts: vi.fn(),
  getAttempt: vi.fn(),
  getModule: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
  reconcilePassedAttemptModule: vi.fn(),
  checkAndAwardCredentials: vi.fn(),
  hasEligibleMissingCredentialForModule: vi.fn(),
  createEscalation: vi.fn(),
  getEscalationChannel: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getStuckAttempts: mocks.getStuckAttempts,
  getAttempt: mocks.getAttempt,
  getModule: mocks.getModule,
  hasEffectiveMembershipForUser: mocks.hasEffectiveMembershipForUser,
  reconcilePassedAttemptModule: mocks.reconcilePassedAttemptModule,
  checkAndAwardCredentials: mocks.checkAndAwardCredentials,
  hasEligibleMissingCredentialForModule: mocks.hasEligibleMissingCredentialForModule,
}));

vi.mock('../../src/db/escalation-db.js', () => ({
  createEscalation: mocks.createEscalation,
  markNotificationSent: vi.fn(),
}));

vi.mock('../../src/db/system-settings-db.js', () => ({
  getEscalationChannel: mocks.getEscalationChannel,
}));

vi.mock('../../src/slack/client.js', () => ({
  sendChannelMessage: vi.fn(),
}));

import { runCertificationRecoveryJob } from '../../src/addie/jobs/certification-recovery.js';

const attempt = {
  id: 'attempt_1',
  workos_user_id: 'user_inactive',
  module_id: 'S1',
  status: 'passed',
  passing: true,
  scores: { protocol_mastery: 90 },
};

describe('certification recovery membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStuckAttempts.mockResolvedValue([{
      ...attempt,
      name: 'Learner',
      email: 'learner@example.test',
    }]);
    mocks.getAttempt.mockResolvedValue(attempt);
    mocks.getModule.mockResolvedValue({ id: 'S1', is_free: false });
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(false);
    mocks.createEscalation.mockResolvedValue({
      id: 42,
      workos_user_id: 'user_inactive',
      notification_message_ts: null,
    });
    mocks.getEscalationChannel.mockResolvedValue({ channel_id: null });
  });

  it('does not reconcile paid completion and opens an entitlement review when membership is inactive', async () => {
    const result = await runCertificationRecoveryJob();

    expect(result.scanned).toBe(1);
    expect(mocks.hasEffectiveMembershipForUser).toHaveBeenCalledWith('user_inactive');
    expect(mocks.reconcilePassedAttemptModule).not.toHaveBeenCalled();
    expect(mocks.checkAndAwardCredentials).not.toHaveBeenCalled();
    expect(mocks.hasEligibleMissingCredentialForModule).not.toHaveBeenCalled();
    expect(mocks.createEscalation).toHaveBeenCalledWith(expect.objectContaining({
      dedup_key: 'certification-recovery-entitlement:attempt_1',
      category: 'needs_human_action',
    }));
    expect(result.escalated).toBe(1);
    expect(result.skipped_no_channel).toBe(1);
  });
});
