/**
 * Exercises POST /api/admin/certification/learners/:userId/modules/:moduleId/complete.
 *
 * The admin repair path must require Addie thread evidence, run the same
 * completion gates as the MCP tool, and leave append-only provenance.
 */

import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/middleware/auth.js', async (importOriginal) => {
  const mockedRequireAuth = (req: any, _res: any, next: any) => {
    req.user = {
      id: 'user_test_cert_admin',
      email: 'cert-admin@test.local',
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
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

import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { query } from '../../src/db/client.js';
import * as certDb from '../../src/db/certification-db.js';
import { createCertificationRouters } from '../../src/routes/certification.js';

const TEST_USER = 'user_test_admin_module_complete';
const ADMIN_USER = 'user_test_cert_admin';
const MODULE_ID = 'A1';
const ADDIE_THREAD_ID = 'thread_admin_module_complete';

function scoreMap(mod: certDb.CertificationModule, value: number): Record<string, number> {
  return Object.fromEntries(
    (mod.assessment_criteria?.dimensions ?? []).map(dim => [dim.name, value]),
  );
}

function criterionIds(mod: certDb.CertificationModule): string[] {
  return (mod.exercise_definitions ?? []).flatMap(ex =>
    (ex.success_criteria as Array<certDb.SuccessCriterion | string>).map(sc =>
      typeof sc === 'string' ? sc : sc.id,
    ),
  );
}

async function cleanup() {
  await query(
    `DELETE FROM admin_module_completions
     WHERE workos_user_id = $1 OR admin_user_id = $2`,
    [TEST_USER, ADMIN_USER],
  );
  await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [TEST_USER]);
  await query(`DELETE FROM rate_limit_hits WHERE key LIKE 'cert-admin-module-complete:%'`);
  await query('DELETE FROM users WHERE workos_user_id IN ($1, $2)', [TEST_USER, ADMIN_USER]);
}

describe('admin module completion repair', () => {
  const app = express();

  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
    app.use(express.json());
    app.use('/api/admin/certification', createCertificationRouters().adminRouter);
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await query(
      `INSERT INTO users (workos_user_id, email)
       VALUES ($1, 'learner@test.example'), ($2, 'admin@test.example')`,
      [TEST_USER, ADMIN_USER],
    );
  });

  it('refuses completion without thread-bound checkpoint evidence', async () => {
    const mod = await certDb.getModule(MODULE_ID);
    expect(mod).toBeTruthy();

    const response = await request(app)
      .post(`/api/admin/certification/learners/${TEST_USER}/modules/${MODULE_ID}/complete`)
      .send({
        scores: scoreMap(mod!, 82),
        addie_thread_id: 'thread_without_checkpoint',
        note: 'Escalation #5414',
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('No teaching checkpoint');

    const progress = await certDb.getModuleProgress(TEST_USER, MODULE_ID);
    expect(progress).toBeNull();
    const audits = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM admin_module_completions WHERE workos_user_id = $1',
      [TEST_USER],
    );
    expect(audits.rows[0]?.count).toBe('0');
  });

  it('marks progress complete and appends an audit row for each admin repair', async () => {
    const mod = await certDb.getModule(MODULE_ID);
    expect(mod).toBeTruthy();
    const scores = scoreMap(mod!, 82);
    const preliminaryScores = scoreMap(mod!, 75);
    const demonstrations = criterionIds(mod!);

    const checkpoint = await certDb.saveTeachingCheckpoint({
      workos_user_id: TEST_USER,
      module_id: MODULE_ID,
      thread_id: ADDIE_THREAD_ID,
      concepts_covered: ['Certification module repair test'],
      concepts_remaining: [],
      current_phase: 'assessment',
      preliminary_scores: preliminaryScores,
      demonstrations_verified: demonstrations,
      demonstration_evidence: Object.fromEntries(demonstrations.map(id => [id, `Evidence for ${id}`])),
      notes: 'Admin-visible checkpoint evidence',
    });

    const checkpointOnlyLearners = await request(app)
      .get('/api/admin/certification/learners?search=learner%40test.example');
    expect(checkpointOnlyLearners.status).toBe(200);
    expect(checkpointOnlyLearners.body.learners.map((l: { workos_user_id: string }) => l.workos_user_id)).toContain(TEST_USER);

    for (const note of ['Escalation #5414', 'Escalation #5414 rerun']) {
      const response = await request(app)
        .post(`/api/admin/certification/learners/${TEST_USER}/modules/${MODULE_ID}/complete`)
        .send({ scores, addie_thread_id: ADDIE_THREAD_ID, note });

      expect(response.status).toBe(200);
      expect(response.body.progress.status).toBe('completed');
      expect(response.body.progress.addie_thread_id).toBe(ADDIE_THREAD_ID);
      expect(response.body.audit.completed_by).toBe('admin');
      expect(response.body.audit.teaching_checkpoint_id).toBe(checkpoint.id);
    }

    const progress = await certDb.getModuleProgress(TEST_USER, MODULE_ID);
    expect(progress?.status).toBe('completed');
    expect(progress?.score).toMatchObject(scores);
    expect(progress?.addie_thread_id).toBe(ADDIE_THREAD_ID);

    const audits = await query<{
      completed_by: string;
      addie_thread_id: string;
      teaching_checkpoint_id: string;
      learner_progress_id: string;
      note: string | null;
    }>(
      `SELECT completed_by, addie_thread_id, teaching_checkpoint_id::text, learner_progress_id::text, note
       FROM admin_module_completions
       WHERE workos_user_id = $1
       ORDER BY created_at ASC`,
      [TEST_USER],
    );
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows.map(row => row.note)).toEqual(['Escalation #5414', 'Escalation #5414 rerun']);
    expect(audits.rows.every(row => row.completed_by === 'admin')).toBe(true);
    expect(audits.rows.every(row => row.addie_thread_id === ADDIE_THREAD_ID)).toBe(true);
    expect(audits.rows.every(row => row.teaching_checkpoint_id === checkpoint.id)).toBe(true);
    expect(audits.rows.every(row => row.learner_progress_id === progress?.id)).toBe(true);
  });
});
