import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeAttempt: vi.fn(),
  completeModule: vi.fn(),
  reconcilePassedAttemptModule: vi.fn(),
  getAttemptForUser: vi.fn(),
  getModule: vi.fn(),
  getProgress: vi.fn(),
  saveTeachingCheckpoint: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
  attemptStripeReconciliation: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  S2_CANONICAL_FORMATS_MODULE_ID: 'S2',
  completeAttempt: mocks.completeAttempt,
  completeModule: mocks.completeModule,
  reconcilePassedAttemptModule: mocks.reconcilePassedAttemptModule,
  getAttemptForUser: mocks.getAttemptForUser,
  getModule: mocks.getModule,
  getProgress: mocks.getProgress,
  saveTeachingCheckpoint: mocks.saveTeachingCheckpoint,
  hasEffectiveMembershipForUser: mocks.hasEffectiveMembershipForUser,
}));

vi.mock('../../src/billing/stripe-client.js', () => ({ stripe: {} }));

vi.mock('../../src/billing/lazy-reconcile.js', () => ({
  attemptStripeReconciliation: mocks.attemptStripeReconciliation,
}));

vi.mock('../../src/db/client.js', () => ({
  getPool: vi.fn(() => ({})),
  query: vi.fn(),
}));

import { createCertificationToolHandlers, NOT_COMPLETED_SENTINEL } from '../../src/addie/mcp/certification-tools.js';

const nonmemberContext = {
  is_member: false,
  workos_user: { workos_user_id: 'user_nonmember' },
  organization: { is_personal: true },
} as any;

describe('certification membership revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasEffectiveMembershipForUser.mockReset();
    mocks.attemptStripeReconciliation.mockReset();
    mocks.getModule.mockResolvedValue({
      id: 'B1',
      is_free: false,
      format: 'lesson',
      assessment_criteria: null,
      exercise_definitions: [],
    });
    mocks.getProgress.mockResolvedValue([{ module_id: 'B1', status: 'in_progress' }]);
    mocks.saveTeachingCheckpoint.mockResolvedValue({});
    mocks.hasEffectiveMembershipForUser.mockResolvedValue(false);
    mocks.attemptStripeReconciliation.mockResolvedValue({ healed: false, reason: 'no_stripe_customer' });
  });

  it('blocks completion of an in-progress paid module after membership ends', async () => {
    const handler = createCertificationToolHandlers(nonmemberContext).get('complete_certification_module');

    const result = await handler?.({ module_id: 'B1', scores: { knowledge: 90 } });

    expect(result).toContain(NOT_COMPLETED_SENTINEL);
    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.completeModule).not.toHaveBeenCalled();
  });

  it('blocks paid-module checkpoints after membership ends', async () => {
    const handler = createCertificationToolHandlers(nonmemberContext).get('checkpoint_teaching_progress');

    const result = await handler?.({ module_id: 'B1', current_phase: 'teaching' });

    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.saveTeachingCheckpoint).not.toHaveBeenCalled();
    expect(mocks.getProgress).not.toHaveBeenCalled();
  });

  it('blocks completion of an in-progress specialist exam after membership ends', async () => {
    const attemptId = '123e4567-e89b-42d3-a456-426614174000';
    mocks.getAttemptForUser.mockResolvedValue({
      id: attemptId,
      workos_user_id: 'user_nonmember',
      module_id: 'S1',
      track_id: 'S',
      status: 'in_progress',
      started_at: '2026-01-01T00:00:00.000Z',
    });
    mocks.getModule.mockResolvedValue({
      id: 'S1',
      is_free: false,
      format: 'capstone',
      assessment_criteria: null,
      exercise_definitions: [],
    });
    const handler = createCertificationToolHandlers(nonmemberContext).get('complete_certification_exam');

    const result = await handler?.({ attempt_id: attemptId, scores: { knowledge: 90 } });

    expect(result).toContain(NOT_COMPLETED_SENTINEL);
    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.completeAttempt).not.toHaveBeenCalled();
  });

  it('blocks reconciliation of an already-passed paid exam after membership ends', async () => {
    const attemptId = '123e4567-e89b-42d3-a456-426614174001';
    mocks.getAttemptForUser.mockResolvedValue({
      id: attemptId,
      workos_user_id: 'user_nonmember',
      module_id: 'S1',
      track_id: 'S',
      status: 'passed',
      passing: true,
      scores: { protocol_mastery: 90 },
      started_at: '2026-01-01T00:00:00.000Z',
    });
    mocks.getModule.mockResolvedValue({
      id: 'S1',
      is_free: false,
      format: 'capstone',
      assessment_criteria: null,
      exercise_definitions: [],
    });
    const handler = createCertificationToolHandlers(nonmemberContext).get('complete_certification_exam');

    const result = await handler?.({ attempt_id: attemptId, scores: { protocol_mastery: 90 } });

    expect(result).toContain(NOT_COMPLETED_SENTINEL);
    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.reconcilePassedAttemptModule).not.toHaveBeenCalled();
  });

  it('force-refreshes and rejects a stale positive member context', async () => {
    const staleMemberContext = {
      is_member: true,
      workos_user: { workos_user_id: 'user_stale' },
      organization: { workos_organization_id: 'org_stale', is_personal: false },
    } as any;
    const handler = createCertificationToolHandlers(staleMemberContext).get('checkpoint_teaching_progress');

    const result = await handler?.({ module_id: 'B1', current_phase: 'teaching' });

    expect(mocks.hasEffectiveMembershipForUser).toHaveBeenCalledWith('user_stale');
    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.saveTeachingCheckpoint).not.toHaveBeenCalled();
  });

  it('allows a canonical active membership after Stripe lazy reconciliation', async () => {
    const orgContext = {
      is_member: false,
      workos_user: { workos_user_id: 'user_healed' },
      organization: { workos_organization_id: 'org_healed', is_personal: false },
    } as any;
    mocks.hasEffectiveMembershipForUser
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.attemptStripeReconciliation.mockResolvedValue({
      healed: true,
      reason: 'healed_from_stripe',
      subscriptionStatus: 'active',
    });
    const handler = createCertificationToolHandlers(orgContext).get('checkpoint_teaching_progress');

    const result = await handler?.({ module_id: 'B1', current_phase: 'teaching' });

    expect(mocks.attemptStripeReconciliation).toHaveBeenCalled();
    expect(mocks.hasEffectiveMembershipForUser).toHaveBeenCalledTimes(2);
    expect(mocks.saveTeachingCheckpoint).toHaveBeenCalled();
    expect(result).toContain('checkpoint saved');
  });

  it('rejects a lazy-healed status that canonical membership does not accept', async () => {
    const orgContext = {
      is_member: false,
      workos_user: { workos_user_id: 'user_past_due' },
      organization: { workos_organization_id: 'org_past_due', is_personal: false },
    } as any;
    mocks.attemptStripeReconciliation.mockResolvedValue({
      healed: true,
      reason: 'healed_from_stripe',
      subscriptionStatus: 'past_due',
    });
    const handler = createCertificationToolHandlers(orgContext).get('checkpoint_teaching_progress');

    const result = await handler?.({ module_id: 'B1', current_phase: 'teaching' });

    expect(result).toContain('requires AgenticAdvertising.org membership');
    expect(mocks.saveTeachingCheckpoint).not.toHaveBeenCalled();
  });
});
