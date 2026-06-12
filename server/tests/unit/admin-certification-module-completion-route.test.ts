import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCertDb = vi.hoisted(() => ({
  getModule: vi.fn(),
  getLatestCheckpointForThread: vi.fn(),
  adminCompleteModule: vi.fn(),
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
    optionalAuth: passThrough,
  };
});

vi.mock('../../src/db/certification-db.js', () => mockCertDb);

import { createCertificationRouters } from '../../src/routes/certification.js';

const moduleFixture = {
  id: 'A1',
  assessment_criteria: {
    passing_threshold: 70,
    dimensions: [
      { name: 'protocol_mastery', weight: 50, description: '', scoring_guide: {} },
      { name: 'practical_application', weight: 50, description: '', scoring_guide: {} },
    ],
  },
  exercise_definitions: [
    {
      id: 'a1_ex1',
      title: 'Exercise',
      description: '',
      sandbox_actions: [],
      success_criteria: [
        { id: 'a1_ex1_sc0', text: 'Explains the protocol' },
        { id: 'a1_ex1_sc1', text: 'Applies the protocol' },
      ],
    },
  ],
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/certification', createCertificationRouters().adminRouter);
  return app;
}

describe('admin certification module completion route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCertDb.getModule.mockResolvedValue(moduleFixture);
    mockCertDb.checkAndAwardCredentials.mockResolvedValue([]);
  });

  it('refuses to write without a checkpoint for the supplied Addie thread', async () => {
    mockCertDb.getLatestCheckpointForThread.mockResolvedValue(null);
    const app = buildApp();

    const response = await request(app)
      .post('/api/admin/certification/learners/user_learner/modules/A1/complete')
      .send({
        addie_thread_id: 'thread_missing',
        scores: { protocol_mastery: 82, practical_application: 80 },
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('No teaching checkpoint');
    expect(mockCertDb.adminCompleteModule).not.toHaveBeenCalled();
  });

  it('applies score, checkpoint, and demonstration gates before writing audit provenance', async () => {
    mockCertDb.getLatestCheckpointForThread.mockResolvedValue({
      id: 'checkpoint_1',
      workos_user_id: 'user_learner',
      module_id: 'A1',
      thread_id: 'thread_123',
      concepts_covered: [],
      concepts_remaining: [],
      learner_strengths: [],
      learner_gaps: [],
      current_phase: 'assessment',
      preliminary_scores: { protocol_mastery: 75, practical_application: 74 },
      demonstrations_verified: ['a1_ex1_sc0', 'a1_ex1_sc1'],
      demonstration_evidence: {},
      notes: null,
      created_at: new Date().toISOString(),
    });
    mockCertDb.adminCompleteModule.mockResolvedValue({
      progress: {
        id: 'progress_1',
        workos_user_id: 'user_learner',
        module_id: 'A1',
        status: 'completed',
        started_at: null,
        completed_at: new Date().toISOString(),
        score: { protocol_mastery: 82, practical_application: 80 },
        addie_thread_id: 'thread_123',
        attempts: 0,
      },
      audit: {
        id: 'audit_1',
        workos_user_id: 'user_learner',
        module_id: 'A1',
        admin_user_id: 'user_test_admin',
        completed_by: 'admin',
        addie_thread_id: 'thread_123',
        score: { protocol_mastery: 82, practical_application: 80 },
        note: 'Escalation #5414',
        teaching_checkpoint_id: 'checkpoint_1',
        learner_progress_id: 'progress_1',
        created_at: new Date().toISOString(),
      },
    });
    const app = buildApp();

    const response = await request(app)
      .post('/api/admin/certification/learners/user_learner/modules/a1/complete')
      .send({
        addie_thread_id: 'thread_123',
        scores: { protocol_mastery: 82, practical_application: 80 },
        note: 'Escalation #5414',
      });

    expect(response.status).toBe(200);
    expect(response.body.audit.completed_by).toBe('admin');
    expect(mockCertDb.adminCompleteModule).toHaveBeenCalledWith({
      userId: 'user_learner',
      moduleId: 'A1',
      adminUserId: 'user_test_admin',
      addieThreadId: 'thread_123',
      score: { protocol_mastery: 82, practical_application: 80 },
      note: 'Escalation #5414',
      teachingCheckpointId: 'checkpoint_1',
    });
  });

  it('rejects scores that jump more than 20 points from the checkpoint', async () => {
    mockCertDb.getLatestCheckpointForThread.mockResolvedValue({
      id: 'checkpoint_1',
      preliminary_scores: { protocol_mastery: 60, practical_application: 80 },
      demonstrations_verified: ['a1_ex1_sc0', 'a1_ex1_sc1'],
    });
    const app = buildApp();

    const response = await request(app)
      .post('/api/admin/certification/learners/user_learner/modules/A1/complete')
      .send({
        addie_thread_id: 'thread_123',
        scores: { protocol_mastery: 82, practical_application: 80 },
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('>20 points');
    expect(mockCertDb.adminCompleteModule).not.toHaveBeenCalled();
  });
});
