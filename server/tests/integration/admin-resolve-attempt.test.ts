/**
 * Tests for admin attempt resolution (cancel and complete).
 *
 * Verifies that:
 * 1. cancelAttempt marks in_progress attempts as failed
 * 2. adminCompleteAttempt marks attempts as passed/failed with scores
 * 3. adminCompleteAttempt can reconcile already-passed attempts
 * 4. Both reject attempts that aren't in_progress or passed-repairable
 * 5. Cancelled attempts unblock new attempts on the same track
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import * as certDb from '../../src/db/certification-db.js';
import { query } from '../../src/db/client.js';

const TEST_USER = 'test-admin-resolve-001';

async function cleanupTestUser(userId: string) {
  await query('DELETE FROM certification_attempts WHERE workos_user_id = $1', [userId]);
  await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [userId]);
  await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [userId]);
  await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [userId]);
  await query(
    `INSERT INTO users (workos_user_id, email) VALUES ($1, $2)
     ON CONFLICT (workos_user_id) DO NOTHING`,
    [userId, `${userId}@test.example.com`]
  );
}

describe('Admin attempt resolution', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
    await cleanupTestUser(TEST_USER);
  });

  afterAll(async () => {
    await query('DELETE FROM certification_attempts WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM users WHERE workos_user_id = $1', [TEST_USER]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await query('DELETE FROM certification_attempts WHERE workos_user_id = $1', [TEST_USER]);
  });

  describe('cancelAttempt', () => {
    it('marks an in_progress attempt as failed', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');
      expect(attempt.status).toBe('in_progress');

      const cancelled = await certDb.cancelAttempt(attempt.id, 'Stuck attempt — escalation #197');
      expect(cancelled.status).toBe('failed');
      expect(cancelled.completed_at).toBeTruthy();
      expect(cancelled.scores).toEqual({
        _admin_cancelled: true,
        _reason: 'Stuck attempt — escalation #197',
      });
    });

    it('rejects attempts that are not in_progress', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');
      await certDb.completeAttempt(attempt.id, { protocol_mastery: 80 }, 80, true);

      await expect(
        certDb.cancelAttempt(attempt.id, 'should fail')
      ).rejects.toThrow('not found or not in_progress');
    });

    it('unblocks new attempts on the same track', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');

      // Active attempt blocks new ones
      const active = await certDb.getActiveAttempt(TEST_USER, 'S');
      expect(active).toBeTruthy();
      expect(active!.id).toBe(attempt.id);

      // Cancel it
      await certDb.cancelAttempt(attempt.id, 'unblock test');

      // No more active attempt
      const afterCancel = await certDb.getActiveAttempt(TEST_USER, 'S');
      expect(afterCancel).toBeNull();
    });
  });

  describe('adminCompleteAttempt', () => {
    it('marks an in_progress attempt as passed with scores', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');

      const scores = {
        protocol_mastery: 78,
        targeting_expertise: 85,
        analytical_skill: 80,
        problem_solving: 82,
      };
      const overallScore = 81;

      const completed = await certDb.adminCompleteAttempt(
        attempt.id, scores, overallScore, true, 'Learner demonstrated competency — escalation #197'
      );

      expect(completed.status).toBe('passed');
      expect(completed.overall_score).toBe(81);
      expect(completed.passing).toBe(true);
      expect(completed.completed_at).toBeTruthy();
      expect(completed.scores).toMatchObject(scores);
      expect(completed.scores._admin_completed).toBe(true);
    });

    it('marks an attempt as failed when scores are below threshold', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');

      const completed = await certDb.adminCompleteAttempt(
        attempt.id, { protocol_mastery: 50 }, 50, false, 'Did not meet threshold'
      );

      expect(completed.status).toBe('failed');
      expect(completed.passing).toBe(false);
    });

    it('rejects already-passed attempts so repair cannot rescore them', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');
      await certDb.completeAttempt(attempt.id, { protocol_mastery: 80 }, 80, true);

      await expect(
        certDb.adminCompleteAttempt(attempt.id, { protocol_mastery: 80 }, 80, true, 'should fail')
      ).rejects.toThrow('not found or not in_progress');
    });

    it('reconciles an already-passed attempt into learner progress without mutating the attempt', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');
      const passed = await certDb.completeAttempt(attempt.id, { protocol_mastery: 80 }, 80, true);

      const progress = await certDb.reconcilePassedAttemptModule(passed, 'S1', { protocol_mastery: 80 });
      expect(progress.status).toBe('completed');
      expect(progress.module_id).toBe('S1');
      expect(progress.score).toMatchObject({ protocol_mastery: 80 });

      const after = await certDb.getAttempt(attempt.id);
      expect(after?.scores).toMatchObject({ protocol_mastery: 80 });
      expect(after?.scores).not.toHaveProperty('_admin_completed');
    });

    it('rejects attempts that are failed', async () => {
      const attempt = await certDb.createAttempt(TEST_USER, 'S', undefined, 'S1');
      await certDb.cancelAttempt(attempt.id, 'pre-cancel');

      await expect(
        certDb.adminCompleteAttempt(attempt.id, { x: 80 }, 80, true, 'should fail')
      ).rejects.toThrow('not found or not in_progress');
    });
  });
});
