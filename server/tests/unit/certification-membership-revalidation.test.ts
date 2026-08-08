import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeAttempt: vi.fn(),
  completeModule: vi.fn(),
  getAttemptForUser: vi.fn(),
  getModule: vi.fn(),
  getProgress: vi.fn(),
  saveTeachingCheckpoint: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  S2_CANONICAL_FORMATS_MODULE_ID: 'S2',
  completeAttempt: mocks.completeAttempt,
  completeModule: mocks.completeModule,
  getAttemptForUser: mocks.getAttemptForUser,
  getModule: mocks.getModule,
  getProgress: mocks.getProgress,
  saveTeachingCheckpoint: mocks.saveTeachingCheckpoint,
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
    mocks.getModule.mockResolvedValue({
      id: 'B1',
      is_free: false,
      format: 'lesson',
      assessment_criteria: null,
      exercise_definitions: [],
    });
    mocks.getProgress.mockResolvedValue([{ module_id: 'B1', status: 'in_progress' }]);
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
});
