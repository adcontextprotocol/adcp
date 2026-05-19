/**
 * Guards the Slack-link-time name backfill in `SlackDatabase.mapUser`.
 *
 * Scenario behind the test: a learner signs up via OAuth without filling
 * first/last in WorkOS (escalation #382 root cause), then later gets
 * Slack-linked via admin tooling or email-based auto-link. Before this
 * backfill, their `users.first_name/last_name` stayed NULL until their
 * NEXT OAuth callback fired — long enough that they could earn a
 * credential ("undefined undefined" certificate) in between.
 *
 * mapUser now does the cascade inline on every link.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SlackDatabase } from '../../src/db/slack-db.js';
import type { Pool } from 'pg';

const TEST_USER_PREFIX = 'user_namebackfill_';
const TEST_SLACK_PREFIX = 'U_namebackfill_';

describe.skipIf(!process.env.DATABASE_URL)('SlackDatabase.mapUser name backfill', () => {
  let pool: Pool;
  let slackDb: SlackDatabase;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    slackDb = new SlackDatabase();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1`, [`${TEST_SLACK_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM slack_user_mappings WHERE slack_user_id LIKE $1`, [`${TEST_SLACK_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
  });

  async function seedUser(suffix: string, opts: { first?: string | null; last?: string | null } = {}) {
    const workosUserId = `${TEST_USER_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())`,
      [workosUserId, `${suffix}@example.com`, opts.first ?? null, opts.last ?? null]
    );
    return workosUserId;
  }

  async function seedSlackUser(suffix: string, opts: { real?: string | null; display?: string | null }) {
    const slackUserId = `${TEST_SLACK_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO slack_user_mappings (slack_user_id, slack_email, slack_display_name, slack_real_name, mapping_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'unmapped', NOW(), NOW())`,
      [slackUserId, `${suffix}@example.com`, opts.display ?? null, opts.real ?? null]
    );
    return slackUserId;
  }

  async function getUserName(workosUserId: string) {
    const r = await pool.query<{ first_name: string | null; last_name: string | null }>(
      `SELECT first_name, last_name FROM users WHERE workos_user_id = $1`,
      [workosUserId]
    );
    return r.rows[0];
  }

  it('fills first/last from slack_real_name when both are NULL', async () => {
    const workosUserId = await seedUser('a');
    const slackUserId = await seedSlackUser('a', { real: 'Lillie Ratliff', display: 'lillie' });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: 'Lillie', last_name: 'Ratliff' });
  });

  it('falls back to slack_display_name when real_name is missing', async () => {
    const workosUserId = await seedUser('b');
    const slackUserId = await seedSlackUser('b', { real: null, display: 'Daniel Di Tullio' });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: 'Daniel', last_name: 'Di Tullio' });
  });

  it('handles single-word Slack names without inventing a last name', async () => {
    const workosUserId = await seedUser('c');
    const slackUserId = await seedSlackUser('c', { real: 'Cher', display: null });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: 'Cher', last_name: null });
  });

  it('does NOT overwrite existing user-set names', async () => {
    const workosUserId = await seedUser('d', { first: 'Kept', last: 'Original' });
    const slackUserId = await seedSlackUser('d', { real: 'Different Person', display: null });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: 'Kept', last_name: 'Original' });
  });

  it('fills only the missing half when one of first/last is already set', async () => {
    const workosUserId = await seedUser('e', { first: 'Davide', last: null });
    const slackUserId = await seedSlackUser('e', { real: 'Davide Astuto', display: null });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: 'Davide', last_name: 'Astuto' });
  });

  it('does nothing when the Slack mapping has no names', async () => {
    const workosUserId = await seedUser('f');
    const slackUserId = await seedSlackUser('f', { real: null, display: null });
    await slackDb.mapUser({ slack_user_id: slackUserId, workos_user_id: workosUserId, mapping_source: 'manual_admin' });
    expect(await getUserName(workosUserId)).toEqual({ first_name: null, last_name: null });
  });
});
