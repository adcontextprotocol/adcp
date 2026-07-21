import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProgress: vi.fn(),
  getTrackProgress: vi.fn(),
  getCredentials: vi.fn(),
  getUserCredentials: vi.fn(),
  getTracks: vi.fn(),
  getDeltaStatus: vi.fn(),
  getUserAttempts: vi.fn(),
  getActiveAttemptForModule: vi.fn(),
  getAttemptForUser: vi.fn(),
  getModule: vi.fn(),
  getLatestCheckpoint: vi.fn(),
  completeAttempt: vi.fn(),
  completeModule: vi.fn(),
  checkAndAwardCredentials: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/db/certification-db.js', () => ({
  getProgress: mocks.getProgress,
  getTrackProgress: mocks.getTrackProgress,
  getCredentials: mocks.getCredentials,
  getUserCredentials: mocks.getUserCredentials,
  getTracks: mocks.getTracks,
  getDeltaStatus: mocks.getDeltaStatus,
  getUserAttempts: mocks.getUserAttempts,
  getActiveAttemptForModule: mocks.getActiveAttemptForModule,
  getAttemptForUser: mocks.getAttemptForUser,
  getModule: mocks.getModule,
  getLatestCheckpoint: mocks.getLatestCheckpoint,
  completeAttempt: mocks.completeAttempt,
  completeModule: mocks.completeModule,
  checkAndAwardCredentials: mocks.checkAndAwardCredentials,
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getPool: vi.fn(),
}));

import { createCertificationToolHandlers } from '../../src/addie/mcp/certification-tools.js';

const USER_ID = 'user_attempt_recovery';
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174000';

function memberContext() {
  return {
    workos_user: { workos_user_id: USER_ID },
    is_member: true,
  } as any;
}

describe('certification attempt recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTrackProgress.mockResolvedValue([]);
    mocks.getCredentials.mockResolvedValue([]);
    mocks.getUserCredentials.mockResolvedValue([]);
    mocks.getTracks.mockResolvedValue([]);
    mocks.getDeltaStatus.mockResolvedValue({ active: false, status: 'not_required' });
    mocks.checkAndAwardCredentials.mockResolvedValue([]);
  });

  it('surfaces an in-progress specialist attempt across handler sessions', async () => {
    mocks.getProgress.mockResolvedValue([
      { module_id: 'S3', status: 'in_progress' },
    ]);
    mocks.getUserAttempts.mockResolvedValue([
      {
        id: ATTEMPT_ID,
        workos_user_id: USER_ID,
        track_id: 'S',
        module_id: 'S3',
        status: 'in_progress',
        started_at: '2026-07-19T14:30:00.000Z',
      },
    ]);

    const firstSession = createCertificationToolHandlers(memberContext());
    const secondSession = createCertificationToolHandlers(memberContext());
    expect(firstSession).not.toBe(secondSession);

    const result = await secondSession.get('get_learner_progress')?.({});

    expect(result).toContain('- S3: in progress');
    expect(result).toContain(`Active attempt: ${ATTEMPT_ID} (started July 19, 2026)`);
    expect(mocks.getUserAttempts).toHaveBeenCalledWith(USER_ID);
  });

  it('marks scores when completion resolves an attempt from a module ID', async () => {
    const startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const attempt = {
      id: ATTEMPT_ID,
      workos_user_id: USER_ID,
      track_id: 'S',
      module_id: 'S3',
      status: 'in_progress',
      started_at: startedAt,
      passing: null,
    };
    const scores = { protocol_mastery: 85 };

    mocks.getActiveAttemptForModule.mockResolvedValue(attempt);
    mocks.getModule.mockResolvedValue({
      id: 'S3',
      assessment_criteria: {
        dimensions: [{ name: 'protocol_mastery', weight: 100, description: 'Mastery' }],
        passing_threshold: 70,
      },
      exercise_definitions: [],
    });
    mocks.getLatestCheckpoint.mockResolvedValue({
      preliminary_scores: { protocol_mastery: 85 },
      demonstrations_verified: [],
    });
    mocks.query.mockResolvedValue({ rows: [{ count: '6' }] });
    mocks.completeAttempt.mockResolvedValue({ ...attempt, status: 'passed', passing: true });
    mocks.completeModule.mockResolvedValue({ module_id: 'S3', status: 'completed' });

    const handler = createCertificationToolHandlers(memberContext(), { threadId: 'thread_123' })
      .get('complete_certification_exam');
    const result = await handler?.({ attempt_id: 's3', scores });

    expect(result).toContain('# Congratulations! The learner passed the capstone!');
    expect(mocks.getActiveAttemptForModule).toHaveBeenCalledWith(USER_ID, 'S3');
    expect(mocks.completeAttempt).toHaveBeenCalledWith(
      ATTEMPT_ID,
      { protocol_mastery: 85, _resolved_from_module_id: true },
      85,
      true,
    );
  });

  it('does not distinguish another learner\'s attempt UUID from a missing UUID', async () => {
    const otherUserAttemptId = '123e4567-e89b-42d3-a456-426614174001';
    const missingAttemptId = '123e4567-e89b-42d3-a456-426614174002';
    mocks.getAttemptForUser
      .mockResolvedValueOnce({
        id: otherUserAttemptId,
        workos_user_id: 'another_learner',
        track_id: 'S',
        module_id: 'S3',
        status: 'in_progress',
        started_at: new Date().toISOString(),
      })
      .mockResolvedValueOnce(null);

    const handler = createCertificationToolHandlers(memberContext())
      .get('complete_certification_exam');
    const otherUserResult = await handler?.({
      attempt_id: otherUserAttemptId,
      scores: { protocol_mastery: 85 },
    });
    const missingResult = await handler?.({
      attempt_id: missingAttemptId,
      scores: { protocol_mastery: 85 },
    });

    expect(otherUserResult).toBe('Exam attempt not found.');
    expect(missingResult).toBe(otherUserResult);
    expect(mocks.getAttemptForUser).toHaveBeenNthCalledWith(1, otherUserAttemptId, USER_ID);
    expect(mocks.getAttemptForUser).toHaveBeenNthCalledWith(2, missingAttemptId, USER_ID);
  });

  it('completes an owned attempt resolved from its UUID', async () => {
    const startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const attempt = {
      id: ATTEMPT_ID,
      workos_user_id: USER_ID,
      track_id: 'S',
      module_id: 'S3',
      status: 'in_progress',
      started_at: startedAt,
      passing: null,
    };
    const scores = { protocol_mastery: 85 };

    mocks.getAttemptForUser.mockResolvedValue(attempt);
    mocks.getModule.mockResolvedValue({
      id: 'S3',
      assessment_criteria: {
        dimensions: [{ name: 'protocol_mastery', weight: 100, description: 'Mastery' }],
        passing_threshold: 70,
      },
      exercise_definitions: [],
    });
    mocks.getLatestCheckpoint.mockResolvedValue({
      preliminary_scores: { protocol_mastery: 85 },
      demonstrations_verified: [],
    });
    mocks.query.mockResolvedValue({ rows: [{ count: '6' }] });
    mocks.completeAttempt.mockResolvedValue({ ...attempt, status: 'passed', passing: true });
    mocks.completeModule.mockResolvedValue({ module_id: 'S3', status: 'completed' });

    const result = await createCertificationToolHandlers(memberContext(), { threadId: 'thread_123' })
      .get('complete_certification_exam')?.({ attempt_id: ATTEMPT_ID, scores });

    expect(result).toContain('# Congratulations! The learner passed the capstone!');
    expect(mocks.getAttemptForUser).toHaveBeenCalledWith(ATTEMPT_ID, USER_ID);
    expect(mocks.completeAttempt).toHaveBeenCalledWith(ATTEMPT_ID, scores, 85, true);
  });
});
