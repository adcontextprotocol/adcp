import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCheckAndAwardCredentials,
  mockCreateEscalation,
  mockGetAttempt,
  mockGetEscalationChannel,
  mockGetStuckAttempts,
  mockHasEligibleMissingCredentialForModule,
  mockMarkNotificationSent,
  mockReconcilePassedAttemptModule,
  mockSendChannelMessage,
} = vi.hoisted(() => ({
  mockCheckAndAwardCredentials: vi.fn<any>(),
  mockCreateEscalation: vi.fn<any>(),
  mockGetAttempt: vi.fn<any>(),
  mockGetEscalationChannel: vi.fn<any>(),
  mockGetStuckAttempts: vi.fn<any>(),
  mockHasEligibleMissingCredentialForModule: vi.fn<any>(),
  mockMarkNotificationSent: vi.fn<any>(),
  mockReconcilePassedAttemptModule: vi.fn<any>(),
  mockSendChannelMessage: vi.fn<any>(),
}));

vi.mock('../../server/src/db/certification-db.js', () => ({
  checkAndAwardCredentials: (...args: unknown[]) => mockCheckAndAwardCredentials(...args),
  getAttempt: (...args: unknown[]) => mockGetAttempt(...args),
  getStuckAttempts: (...args: unknown[]) => mockGetStuckAttempts(...args),
  hasEligibleMissingCredentialForModule: (...args: unknown[]) => mockHasEligibleMissingCredentialForModule(...args),
  reconcilePassedAttemptModule: (...args: unknown[]) => mockReconcilePassedAttemptModule(...args),
}));

vi.mock('../../server/src/db/escalation-db.js', () => ({
  createEscalation: (...args: unknown[]) => mockCreateEscalation(...args),
  markNotificationSent: (...args: unknown[]) => mockMarkNotificationSent(...args),
}));

vi.mock('../../server/src/db/system-settings-db.js', () => ({
  getEscalationChannel: (...args: unknown[]) => mockGetEscalationChannel(...args),
}));

vi.mock('../../server/src/slack/client.js', () => ({
  sendChannelMessage: (...args: unknown[]) => mockSendChannelMessage(...args),
}));

import { runCertificationRecoveryJob } from '../../server/src/addie/jobs/certification-recovery.js';

function stuckAttempt(overrides: Partial<any> = {}) {
  return {
    id: 'attempt_123',
    workos_user_id: 'user_123',
    name: 'Test User',
    email: 'test@example.com',
    track_id: 'specialist',
    module_id: 'module_a',
    status: 'passed',
    credential_name: 'Specialist',
    started_at: '2026-06-01T12:00:00Z',
    days_stuck: 16,
    ...overrides,
  };
}

function fullAttempt(overrides: Partial<any> = {}) {
  return {
    id: 'attempt_123',
    workos_user_id: 'user_123',
    module_id: 'module_a',
    status: 'passed',
    passing: true,
    scores: { criterion_a: 1, _admin_completed: true },
    ...overrides,
  };
}

beforeEach(() => {
  mockCheckAndAwardCredentials.mockReset();
  mockCreateEscalation.mockReset();
  mockGetAttempt.mockReset();
  mockGetEscalationChannel.mockReset();
  mockGetStuckAttempts.mockReset();
  mockHasEligibleMissingCredentialForModule.mockReset();
  mockMarkNotificationSent.mockReset();
  mockReconcilePassedAttemptModule.mockReset();
  mockSendChannelMessage.mockReset();

  mockGetStuckAttempts.mockResolvedValue([stuckAttempt()]);
  mockGetAttempt.mockResolvedValue(fullAttempt());
  mockCheckAndAwardCredentials.mockResolvedValue([]);
  mockHasEligibleMissingCredentialForModule.mockResolvedValue(false);
  mockReconcilePassedAttemptModule.mockResolvedValue(undefined);
  mockGetEscalationChannel.mockResolvedValue({ channel_id: 'C_ESCALATIONS' });
  mockSendChannelMessage.mockResolvedValue({ ok: true, ts: '1710000000.000' });
  mockCreateEscalation.mockResolvedValue({
    id: 77,
    workos_user_id: 'user_123',
    notification_message_ts: null,
  });
});

describe('runCertificationRecoveryJob', () => {
  it('does not escalate when the credential is still blocked by other requirements', async () => {
    const result = await runCertificationRecoveryJob();

    expect(result.scanned).toBe(1);
    expect(result.escalated).toBe(0);
    expect(mockReconcilePassedAttemptModule).toHaveBeenCalled();
    expect(mockHasEligibleMissingCredentialForModule).toHaveBeenCalledWith('user_123', 'module_a');
    expect(mockCreateEscalation).not.toHaveBeenCalled();
    expect(mockSendChannelMessage).not.toHaveBeenCalled();
  });

  it('escalates when an eligible missing credential still was not awarded', async () => {
    mockHasEligibleMissingCredentialForModule.mockResolvedValue(true);

    const result = await runCertificationRecoveryJob();

    expect(result.escalated).toBe(1);
    expect(result.notified).toBe(1);
    expect(mockCreateEscalation).toHaveBeenCalledWith(expect.objectContaining({
      dedup_key: 'certification-recovery:attempt_123',
      priority: 'high',
    }));
    expect(mockMarkNotificationSent).toHaveBeenCalledWith(77, 'C_ESCALATIONS', '1710000000.000');
  });
});
