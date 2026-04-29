/**
 * Tests for getDigestEmailRecipients SQL — specifically the per-track scoping
 * of cert_modules_completed / cert_total_modules via the "active track" LATERAL.
 *
 * Regression guard for two prior bugs:
 * 1. Crash: query referenced certification_modules.module_id / is_active (neither
 *    column exists; PK is id, and there is no activity flag).
 * 2. Semantics: counts were global across all tracks, so the newsletter nudge
 *    "You're X modules in — Y to go" overstated "Y to go" for single-track users.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getDigestEmailRecipients } from '../../src/db/digest-db.js';

const TEST_USER = 'test-digest-recip-001';
const TEST_EMAIL = `${TEST_USER}@test.example.com`;

async function seedUser() {
  await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM user_email_category_preferences WHERE user_preference_id IN (SELECT id FROM user_email_preferences WHERE workos_user_id = $1)', [TEST_USER]);
  await query('DELETE FROM user_email_preferences WHERE workos_user_id = $1', [TEST_USER]);
  await query('DELETE FROM users WHERE workos_user_id = $1', [TEST_USER]);

  await query(
    `INSERT INTO users (workos_user_id, email, first_name, last_name)
     VALUES ($1, $2, 'Test', 'User')`,
    [TEST_USER, TEST_EMAIL]
  );
  await query(
    `INSERT INTO user_email_preferences (workos_user_id, email, unsubscribe_token, marketing_opt_in, marketing_opt_in_at)
     VALUES ($1, $2, $3, TRUE, NOW())`,
    [TEST_USER, TEST_EMAIL, `tok-${TEST_USER}`]
  );
}

async function recipient() {
  const rows = await getDigestEmailRecipients();
  const r = rows.find(x => x.workos_user_id === TEST_USER);
  if (!r) throw new Error(`test user not returned by getDigestEmailRecipients`);
  return r;
}

describe('getDigestEmailRecipients — active track scoping', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
  });

  afterAll(async () => {
    await query('DELETE FROM learner_progress WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM user_email_category_preferences WHERE user_preference_id IN (SELECT id FROM user_email_preferences WHERE workos_user_id = $1)', [TEST_USER]);
    await query('DELETE FROM user_email_preferences WHERE workos_user_id = $1', [TEST_USER]);
    await query('DELETE FROM users WHERE workos_user_id = $1', [TEST_USER]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await seedUser();
  });

  it('returns 0/0 when the user has no learner_progress rows', async () => {
    const r = await recipient();
    expect(r.cert_modules_completed).toBe(0);
    expect(r.cert_total_modules).toBe(0);
  });

  it('scopes counts to the track most recently touched', async () => {
    // Track A: A1 + A2 completed, touched earlier (should NOT be the active track)
    await query(
      `INSERT INTO learner_progress (workos_user_id, module_id, status, updated_at)
       VALUES
         ($1, 'A1', 'completed', NOW() - INTERVAL '2 days'),
         ($1, 'A2', 'completed', NOW() - INTERVAL '2 days')`,
      [TEST_USER]
    );
    // Track B: B1 completed + B2 in_progress, touched most recently → active track = B
    await query(
      `INSERT INTO learner_progress (workos_user_id, module_id, status, updated_at)
       VALUES
         ($1, 'B1', 'completed', NOW() - INTERVAL '1 hour'),
         ($1, 'B2', 'in_progress', NOW())`,
      [TEST_USER]
    );

    const trackBTotal = (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM certification_modules WHERE track_id = 'B'`,
    )).rows[0].count;

    const r = await recipient();
    // Track B's module count comes from the live curriculum, not a hard-coded
    // fixture; new modules land in main and would otherwise drift this test.
    expect(r.cert_modules_completed).toBe(1);
    expect(r.cert_total_modules).toBe(Number(trackBTotal));
  });

  it('counts tested_out the same as completed', async () => {
    await query(
      `INSERT INTO learner_progress (workos_user_id, module_id, status, updated_at)
       VALUES
         ($1, 'A1', 'tested_out', NOW() - INTERVAL '1 hour'),
         ($1, 'A2', 'completed', NOW())`,
      [TEST_USER]
    );

    const r = await recipient();
    expect(r.cert_modules_completed).toBe(2);
    expect(r.cert_total_modules).toBe(3);
  });

  it('breaks updated_at ties deterministically via module_id DESC', async () => {
    // Two rows with identical updated_at on different tracks. The ORDER BY
    // tiebreak of module_id DESC should pick 'B1' > 'A1', so active track = B.
    await query(
      `INSERT INTO learner_progress (workos_user_id, module_id, status, updated_at)
       VALUES
         ($1, 'A1', 'in_progress', '2026-04-17 12:00:00+00'),
         ($1, 'B1', 'in_progress', '2026-04-17 12:00:00+00')`,
      [TEST_USER]
    );

    const trackBTotal = (await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM certification_modules WHERE track_id = 'B'`,
    )).rows[0].count;
    const expectedTotal = Number(trackBTotal);

    // Run several times to make sure the pick is stable (non-deterministic
    // behavior would show up as flakes here).
    for (let i = 0; i < 5; i++) {
      const r = await recipient();
      expect(r.cert_total_modules).toBe(expectedTotal);
      expect(r.cert_modules_completed).toBe(0);
    }
  });
});
