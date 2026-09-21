import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCertDb = vi.hoisted(() => ({
  getAttempt: vi.fn(),
  getModule: vi.fn(),
  hasEffectiveMembershipForUser: vi.fn(),
  getTeachingCheckpointForAttempt: vi.fn(),
  adminResolveAttempt: vi.fn(),
  completeModule: vi.fn(),
  checkAndAwardCredentials: vi.fn(),
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY ??= 'sk_test_mock_key';
  process.env.WORKOS_CLIENT_ID ??= 'client_mock_id';
  process.env.WORKOS_COOKIE_PASSWORD ??= 'test-cookie-password-at-least-32-chars-long';
});

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.user = { id: 'user_test_admin', email: 'admin@test.local' };
    next();
  };
  const passThrough = (_req: any, _res: any, next: any) => next();
  return {
    ...(await importOriginal<typeof import('../../src/middleware/auth.js')>()),
    requireAuth: mockedRequireAuth,
    requireAdmin: passThrough,
    requireGlobalAdmin: [mockedRequireAuth, passThrough, passThrough],
    optionalAuth: passThrough,
  };
});

vi.mock('../../src/db/certification-db.js', () => mockCertDb);

import { createCertificationRouters } from '../../src/routes/certification.js';

const ATTEMPT_ID = 'e2b055f6-b403-40db-8159-233e7f005b57';
const CHECKPOINT_ID = '8328872b-9606-4d32-8bbf-a7b34dfe005b';
const attempt = {
  id: ATTEMPT_ID,
  workos_user_id: 'user_learner',
  track_id: 'S',
  module_id: 'S7',
  status: 'in_progress',
  passing: null,
  scores: null,
  addie_thread_id: 'thread_attempt',
};
const moduleFixture = {
  id: 'S7',
  is_free: true,
  assessment_criteria: {
    passing_threshold: 70,
    dimensions: [
      { name: 'claim_verification', weight: 50, description: '', scoring_guide: {} },
      { name: 'identity_resolution', weight: 50, description: '', scoring_guide: {} },
    ],
  },
  exercise_definitions: [{
    id: 's7_ex1',
    title: 'Exercise',
    description: '',
    sandbox_actions: [],
    success_criteria: [{ id: 's7_ex1_sc0', text: 'Verifies the claim' }],
  }],
};
const scores = { claim_verification: 88, identity_resolution: 85 };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/certification', createCertificationRouters().adminRouter);
  return app;
}

describe('admin certification attempt resolution route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCertDb.getAttempt.mockResolvedValue(attempt);
    mockCertDb.getModule.mockResolvedValue(moduleFixture);
    mockCertDb.hasEffectiveMembershipForUser.mockResolvedValue(true);
    mockCertDb.completeModule.mockResolvedValue({});
    mockCertDb.checkAndAwardCredentials.mockResolvedValue([]);
  });

  it('refuses completion without an exact checkpoint identifier', async () => {
    const response = await request(buildApp())
      .post(`/api/admin/certification/attempts/${ATTEMPT_ID}/resolve`)
      .send({ action: 'complete', scores, reason: 'Escalation evidence review' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('teaching_checkpoint_id');
    expect(mockCertDb.adminResolveAttempt).not.toHaveBeenCalled();
  });

  it('refuses a checkpoint outside the attempt learner/module/thread scope', async () => {
    mockCertDb.getTeachingCheckpointForAttempt.mockResolvedValue(null);
    const response = await request(buildApp())
      .post(`/api/admin/certification/attempts/${ATTEMPT_ID}/resolve`)
      .send({
        action: 'complete',
        scores,
        reason: 'Escalation evidence review',
        teaching_checkpoint_id: CHECKPOINT_ID,
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('does not match');
    expect(mockCertDb.adminResolveAttempt).not.toHaveBeenCalled();
  });

  it('binds validated evidence to an exactly-once audited transition', async () => {
    mockCertDb.getTeachingCheckpointForAttempt.mockResolvedValue({
      id: CHECKPOINT_ID,
      preliminary_scores: scores,
      demonstrations_verified: ['s7_ex1_sc0'],
    });
    mockCertDb.adminResolveAttempt.mockResolvedValue({
      attempt: { ...attempt, status: 'passed', passing: true },
      audit: { id: 'audit-attempt-1', action: 'complete', teaching_checkpoint_id: CHECKPOINT_ID },
    });

    const response = await request(buildApp())
      .post(`/api/admin/certification/attempts/${ATTEMPT_ID}/resolve`)
      .send({
        action: 'complete',
        scores,
        reason: 'Escalation evidence review',
        teaching_checkpoint_id: CHECKPOINT_ID,
      });

    expect(response.status).toBe(200);
    expect(response.body.audit.id).toBe('audit-attempt-1');
    expect(mockCertDb.adminResolveAttempt).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      action: 'complete',
      adminUserId: 'user_test_admin',
      reason: 'Escalation evidence review',
      scores,
      overallScore: 87,
      passing: true,
      moduleId: 'S7',
      teachingCheckpointId: CHECKPOINT_ID,
    });
  });
});

