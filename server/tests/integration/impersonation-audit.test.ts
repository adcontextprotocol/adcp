import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ThreadService } from '../../src/addie/thread-service.js';
import type { Pool } from 'pg';

/**
 * Impersonation Audit Logging Tests
 *
 * Tests for audit logging when admins impersonate users via WorkOS impersonation
 * sessions. Previously drove these through POST /api/addie/chat (see #3289 / #3320),
 * but the timer-deferred AddieClaudeClient init caused a 503. The relevant
 * invariant — impersonator fields written to addie_threads — is testable at the
 * ThreadService layer directly without the HTTP shell.
 *
 * Known gaps (follow-up issues):
 * 1. HTTP mapping: req.user.impersonator.email → impersonator_user_id in
 *    addie-chat.ts (lines 759, 1044) is untested here. That is the only code
 *    path connecting a live WorkOS session to a stored audit record. Consider
 *    extracting it into a testable pure helper.
 * 2. UPSERT "get" path: getOrCreateThread's ON CONFLICT clause does not update
 *    impersonator fields on subsequent calls to the same external_id. No test
 *    here verifies that impersonation fields survive a re-entry into an existing
 *    thread.
 *
 * Note: addie_thread_messages has no impersonation column. Impersonation context
 * is tracked at the thread level only (addie_threads). The legacy addie_messages
 * table had impersonator_email (migration 050); addie_thread_messages
 * (migration 064) does not carry that field.
 */

const TEST_USER_ID = 'user_impersonated_audit_test';
const TEST_EXTERNAL_PREFIX = 'audit-test-';

// Both describe blocks share a single pool lifecycle to avoid double-init hazards.
// Tests require a running PostgreSQL instance (set DATABASE_URL).
describe.skipIf(!process.env.DATABASE_URL)('Impersonation Audit', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL! });
    await runMigrations();
  });

  afterAll(async () => {
    await pool.query(
      'DELETE FROM addie_threads WHERE external_id LIKE $1',
      [`${TEST_EXTERNAL_PREFIX}%`],
    );
    await closeDatabase();
  });

  describe('Impersonation Audit Logging Tests', () => {
    let threadService: ThreadService;
    let seq = 0;

    // seq increments monotonically per test to keep external_ids unique within
    // a run; isolation depends on this uniqueness, not on UPSERT idempotency.
    function nextExternalId() {
      return `${TEST_EXTERNAL_PREFIX}${++seq}`;
    }

    beforeAll(async () => {
      threadService = new ThreadService();
    });

    beforeEach(async () => {
      await pool.query(
        'DELETE FROM addie_threads WHERE external_id LIKE $1',
        [`${TEST_EXTERNAL_PREFIX}%`],
      );
    });

    it('should record impersonator info when creating thread during impersonation', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
        impersonator_user_id: 'admin@example.com',
        impersonation_reason: 'Debugging user issue #123',
      });

      expect(thread.impersonator_user_id).toBe('admin@example.com');
      expect(thread.impersonation_reason).toBe('Debugging user issue #123');
    });

    it('should not record impersonator info for normal sessions', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
      });

      expect(thread.impersonator_user_id).toBeNull();
      expect(thread.impersonation_reason).toBeNull();
    });

    it('should handle impersonation without a reason', async () => {
      const thread = await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
        impersonator_user_id: 'admin@example.com',
      });

      expect(thread.impersonator_user_id).toBe('admin@example.com');
      expect(thread.impersonation_reason).toBeNull();
    });

    it('should be able to find all impersonated threads', async () => {
      await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
        impersonator_user_id: 'admin1@example.com',
        impersonation_reason: 'Support ticket #1',
      });

      await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
        impersonator_user_id: 'admin2@example.com',
        impersonation_reason: 'Support ticket #2',
      });

      // Normal session — should not appear in impersonated results
      await threadService.getOrCreateThread({
        channel: 'web',
        external_id: nextExternalId(),
        user_type: 'workos',
        user_id: TEST_USER_ID,
      });

      const result = await pool.query<{ impersonator_user_id: string; impersonation_reason: string }>(
        `SELECT impersonator_user_id, impersonation_reason
         FROM addie_threads
         WHERE user_id = $1
           AND impersonator_user_id IS NOT NULL
           AND external_id LIKE $2`,
        [TEST_USER_ID, `${TEST_EXTERNAL_PREFIX}%`],
      );

      expect(result.rows.length).toBe(2);
      expect(result.rows.some(r => r.impersonator_user_id === 'admin1@example.com')).toBe(true);
      expect(result.rows.some(r => r.impersonator_user_id === 'admin2@example.com')).toBe(true);
    });
  });

  // Confirms the live DB schema has the expected impersonation columns.
  // Previously verified addie_conversations / addie_messages (migration 050 legacy
  // tables). The live tables are addie_threads (migration 064); impersonation
  // context is on the thread row only.
  describe('Impersonation Database Schema', () => {
    it('should have impersonation columns on addie_threads', async () => {
      const result = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'addie_threads'
          AND column_name IN ('impersonator_user_id', 'impersonation_reason')
      `);

      const columns = result.rows.map(r => r.column_name as string);
      expect(columns).toContain('impersonator_user_id');
      expect(columns).toContain('impersonation_reason');
    });
  });
});
