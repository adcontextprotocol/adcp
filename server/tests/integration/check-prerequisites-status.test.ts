/**
 * Tests for checkPrerequisites per-prereq status reporting.
 *
 * Verifies that the function distinguishes "not_started" from "in_progress"
 * so callers (start_certification_module) can tell Sage to finish the open
 * module instead of offering a placement assessment to skip it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import * as certDb from '../../src/db/certification-db.js';

const TEST_USER = 'test-prereq-status-001';

async function cleanupTestUser() {
  await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [TEST_USER]);
  await query(
    `INSERT INTO users (workos_user_id, email) VALUES ($1, $2)
     ON CONFLICT (workos_user_id) DO NOTHING`,
    [TEST_USER, `${TEST_USER}@test.example.com`]
  );
}

async function setProgress(moduleId: string, status: 'in_progress' | 'completed' | 'tested_out' | 'failed' | 'expired') {
  await query(
    `INSERT INTO learner_progress (workos_user_id, module_id, status, started_at, completed_at)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (workos_user_id, module_id) DO UPDATE
       SET status = EXCLUDED.status,
           completed_at = EXCLUDED.completed_at`,
    [TEST_USER, moduleId, status, status === 'in_progress' ? null : new Date()]
  );
}

describe('checkPrerequisites per-prereq status', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
    await cleanupTestUser();
  });

  afterAll(async () => {
    await query('DELETE FROM teaching_checkpoints WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM user_credentials WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM users WHERE workos_user_id = $1', [TEST_USER]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
  });

  it('reports met=true when the target module has no prerequisites', async () => {
    // A1 has no prerequisites
    const result = await certDb.checkPrerequisites(TEST_USER, 'A1');
    expect(result.met).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports met=true when prerequisite is completed', async () => {
    // B2 requires B1
    await setProgress('B1', 'completed');
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('treats tested_out as a passing terminal state', async () => {
    await setProgress('B1', 'tested_out');
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports status=not_started when prerequisite has no learner_progress row', async () => {
    // No row for B1
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ moduleId: 'B1', status: 'not_started' }]);
  });

  it('reports status=in_progress when prerequisite is mid-flight', async () => {
    await setProgress('B1', 'in_progress');
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ moduleId: 'B1', status: 'in_progress' }]);
  });

  it('reports status=failed when prerequisite is failed', async () => {
    // Defensive: production code does not currently write 'failed' to
    // learner_progress (it lives on certification_attempts), but the
    // function's normalization branch should still classify it correctly
    // if a future writer introduces it.
    await setProgress('B1', 'failed');
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ moduleId: 'B1', status: 'failed' }]);
  });

  it('reports status=expired when prerequisite is expired', async () => {
    // Same defensive coverage as the failed case, for the other
    // documented non-terminal branch.
    await setProgress('B1', 'expired');
    const result = await certDb.checkPrerequisites(TEST_USER, 'B2');
    expect(result.met).toBe(false);
    expect(result.missing).toEqual([{ moduleId: 'B1', status: 'expired' }]);
  });

  it('reports each missing prereq individually when statuses are mixed', async () => {
    // Synthesise a multi-prereq target by inserting a custom module with
    // two prereqs. The seed modules all have 0 or 1 prereq today, so we
    // construct this case directly to cover the template-branching logic
    // (`prereqs.missing.filter(m => m.status === 'in_progress')`).
    await query(
      `INSERT INTO certification_modules (id, track_id, title, format, duration_minutes, sort_order, is_free, prerequisites)
       VALUES ('TMIX1', 'B', 'Test mixed-prereq target', 'lesson', 5, 999, true, ARRAY['B1','B2'])
       ON CONFLICT (id) DO UPDATE SET prerequisites = EXCLUDED.prerequisites`,
    );
    try {
      await setProgress('B1', 'in_progress');
      // B2 deliberately has no row → not_started
      const result = await certDb.checkPrerequisites(TEST_USER, 'TMIX1');
      expect(result.met).toBe(false);
      // Order follows mod.prerequisites order (B1 first, B2 second).
      expect(result.missing).toEqual([
        { moduleId: 'B1', status: 'in_progress' },
        { moduleId: 'B2', status: 'not_started' },
      ]);
    } finally {
      await query(`DELETE FROM certification_modules WHERE id = 'TMIX1'`);
    }
  });
});
