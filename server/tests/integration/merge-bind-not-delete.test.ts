/**
 * mergeUsers — bind, don't delete (Phase 2a) integration tests.
 *
 * The new contract:
 *   - All of the secondary user's app-state rows move to the primary (same
 *     as before).
 *   - The secondary WorkOS user stays alive in `users`. Each linked email is
 *     a real sign-in credential.
 *   - Both WorkOS users end up bound to the primary's identity. The
 *     secondary's binding is `is_primary = FALSE`.
 *   - The secondary's orphaned singleton identity gets dropped.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeUsers } from '../../src/db/user-merge-db.js';
import type { Pool } from 'pg';

const PRIMARY_ID = 'user_bind_test_primary';
const SECONDARY_ID = 'user_bind_test_secondary';
const ORG_ID = 'org_bind_test';

describe('mergeUsers (bind, don\'t delete)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, 'primary@test.example', 'Primary', 'User', true, NOW(), NOW(), NOW(), NOW()),
              ($2, 'secondary@test.example', 'Secondary', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [PRIMARY_ID, SECONDARY_ID]
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Test Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_ID]
    );
  });

  async function cleanup() {
    await pool.query(`DELETE FROM users WHERE workos_user_id IN ($1, $2)`, [PRIMARY_ID, SECONDARY_ID]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ORG_ID]);
  }

  it('keeps the secondary WorkOS user alive after merge', async () => {
    await mergeUsers(PRIMARY_ID, SECONDARY_ID, PRIMARY_ID);

    const result = await pool.query(
      `SELECT workos_user_id FROM users WHERE workos_user_id IN ($1, $2)`,
      [PRIMARY_ID, SECONDARY_ID]
    );
    expect(result.rows.map(r => r.workos_user_id).sort()).toEqual([PRIMARY_ID, SECONDARY_ID].sort());
  });

  it('binds both WorkOS users to one identity, with the secondary marked non-primary', async () => {
    await mergeUsers(PRIMARY_ID, SECONDARY_ID, PRIMARY_ID);

    const result = await pool.query<{ workos_user_id: string; identity_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, identity_id, is_primary
         FROM identity_workos_users
        WHERE workos_user_id IN ($1, $2)
        ORDER BY workos_user_id`,
      [PRIMARY_ID, SECONDARY_ID]
    );

    expect(result.rows).toHaveLength(2);
    const [primary, secondary] = result.rows.sort((a, b) =>
      a.workos_user_id === PRIMARY_ID ? -1 : 1
    );
    expect(primary.workos_user_id).toBe(PRIMARY_ID);
    expect(primary.is_primary).toBe(true);
    expect(secondary.workos_user_id).toBe(SECONDARY_ID);
    expect(secondary.is_primary).toBe(false);
    expect(primary.identity_id).toBe(secondary.identity_id);
  });

  it('drops the secondary user\'s orphaned singleton identity', async () => {
    // Capture the secondary's pre-merge identity id, then verify it's gone after.
    const before = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [SECONDARY_ID]
    );
    const secondaryIdentityBefore = before.rows[0].identity_id;

    await mergeUsers(PRIMARY_ID, SECONDARY_ID, PRIMARY_ID);

    const after = await pool.query(
      `SELECT 1 FROM identities WHERE id = $1`,
      [secondaryIdentityBefore]
    );
    expect(after.rows).toEqual([]);
  });

  it('moves organization memberships from secondary to primary (existing read paths still work)', async () => {
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at)
       VALUES ($1, $2, 'secondary@test.example', 'member', NOW(), NOW())`,
      [SECONDARY_ID, ORG_ID]
    );

    await mergeUsers(PRIMARY_ID, SECONDARY_ID, PRIMARY_ID);

    const result = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM organization_memberships WHERE workos_organization_id = $1`,
      [ORG_ID]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].workos_user_id).toBe(PRIMARY_ID);
  });

  it('records a merge_user audit row', async () => {
    await mergeUsers(PRIMARY_ID, SECONDARY_ID, PRIMARY_ID);

    const result = await pool.query<{ resource_id: string; details: { primary_user_id: string; secondary_user_id: string } }>(
      `SELECT resource_id, details
         FROM registry_audit_log
        WHERE action = 'merge_user' AND resource_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [SECONDARY_ID]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].details.primary_user_id).toBe(PRIMARY_ID);
    expect(result.rows[0].details.secondary_user_id).toBe(SECONDARY_ID);
  });
});
