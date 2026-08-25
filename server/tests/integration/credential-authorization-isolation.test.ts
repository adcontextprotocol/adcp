import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  attachStateEmptyCredential,
  CredentialAlreadyLinkedError,
  CredentialHasStateError,
  USER_STATE_REFERENCES,
  USER_STATE_REFERENCE_EXCEPTIONS,
} from '../../src/db/user-merge-db.js';
import { resolveUserOrgMembership } from '../../src/utils/resolve-user-org-membership.js';

const HOST_A = 'user_auth_isolation_host_a';
const HOST_B = 'user_auth_isolation_host_b';
const CREDENTIAL = 'user_auth_isolation_credential';
const ORG_ID = 'org_auth_isolation';
const USER_IDS = [HOST_A, HOST_B, CREDENTIAL];

describe('credential authorization isolation', () => {
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
       VALUES ($1, 'host-a@test.example', 'Host', 'A', true, NOW(), NOW(), NOW(), NOW()),
              ($2, 'host-b@test.example', 'Host', 'B', true, NOW(), NOW(), NOW(), NOW()),
              ($3, 'credential@test.example', 'Credential', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      USER_IDS,
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Authorization Isolation Org', NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [ORG_ID],
    );
  });

  async function cleanup() {
    await pool.query(`DELETE FROM working_group_leaders WHERE user_id = ANY($1)`, [USER_IDS]);
    await pool.query(`DELETE FROM working_groups WHERE slug = 'auth-isolation-leadership'`);
    await pool.query(`DELETE FROM organization_credential_grants WHERE workos_organization_id = $1`, [ORG_ID]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_organization_id = $1`, [ORG_ID]);
    await pool.query(
      `DELETE FROM registry_audit_log
        WHERE action = 'attach_state_empty_credential'
          AND resource_id = ANY($1)`,
      [USER_IDS],
    );
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [USER_IDS]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = $1`, [ORG_ID]);
  }

  async function epochFor(userId: string): Promise<number> {
    const result = await pool.query<{ authorization_epoch: string }>(
      `SELECT i.authorization_epoch
         FROM identities i
         JOIN identity_workos_users iwu ON iwu.identity_id = i.id
        WHERE iwu.workos_user_id = $1`,
      [userId],
    );
    return Number(result.rows[0].authorization_epoch);
  }

  async function authorizationVersionFor(userId: string): Promise<{
    identityId: string;
    identityEpoch: number;
    credentialEpoch: number;
  }> {
    const result = await pool.query<{
      identity_id: string;
      identity_authorization_epoch: string;
      credential_authorization_epoch: string;
    }>(
      `SELECT iwu.identity_id,
              i.authorization_epoch AS identity_authorization_epoch,
              iwu.authorization_epoch AS credential_authorization_epoch
         FROM identity_workos_users iwu
         JOIN identities i ON i.id = iwu.identity_id
        WHERE iwu.workos_user_id = $1`,
      [userId],
    );
    return {
      identityId: result.rows[0].identity_id,
      identityEpoch: Number(result.rows[0].identity_authorization_epoch),
      credentialEpoch: Number(result.rows[0].credential_authorization_epoch),
    };
  }

  it('bumps the persisted epoch on binding and membership changes', async () => {
    const beforeAttach = await epochFor(HOST_A);
    await attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A);
    const afterAttach = await epochFor(HOST_A);
    expect(afterAttach).toBeGreaterThan(beforeAttach);

    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role,
          seat_type, provisioning_source, created_at, updated_at)
       VALUES ($1, $2, 'om_auth_isolation', 'credential@test.example', 'member',
               'community_only', 'webhook', NOW(), NOW())`,
      [CREDENTIAL, ORG_ID],
    );
    const afterInsert = await epochFor(CREDENTIAL);
    expect(afterInsert).toBeGreaterThan(afterAttach);

    await pool.query(
      `UPDATE organization_memberships SET role = 'admin'
        WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [CREDENTIAL, ORG_ID],
    );
    const afterUpdate = await epochFor(CREDENTIAL);
    expect(afterUpdate).toBeGreaterThan(afterInsert);

    await pool.query(
      `DELETE FROM organization_memberships
        WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [CREDENTIAL, ORG_ID],
    );
    expect(await epochFor(CREDENTIAL)).toBeGreaterThan(afterUpdate);
  });

  it('keeps the credential-local epoch across a binding move and bumps it on later revocation', async () => {
    const initial = await authorizationVersionFor(CREDENTIAL);
    await pool.query(
      `INSERT INTO organization_credential_grants (
         workos_organization_id, workos_user_id, role, granted_by_workos_user_id, reason
       ) VALUES ($1, $2, 'member', $3, 'binding move epoch test')`,
      [ORG_ID, CREDENTIAL, HOST_A],
    );
    const granted = await authorizationVersionFor(CREDENTIAL);
    expect(granted.credentialEpoch).toBeGreaterThan(initial.credentialEpoch);

    await attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A);
    const moved = await authorizationVersionFor(CREDENTIAL);
    expect(moved.identityId).not.toBe(initial.identityId);
    expect(moved.credentialEpoch).toBe(granted.credentialEpoch);

    await pool.query(
      `UPDATE organization_credential_grants
          SET revoked_at = NOW(), revoked_by_workos_user_id = $3, updated_at = NOW()
        WHERE workos_organization_id = $1 AND workos_user_id = $2`,
      [ORG_ID, CREDENTIAL, HOST_A],
    );
    const revoked = await authorizationVersionFor(CREDENTIAL);
    expect(revoked.identityId).toBe(moved.identityId);
    expect(revoked.credentialEpoch).toBeGreaterThan(moved.credentialEpoch);
    expect(revoked.identityEpoch).toBeGreaterThan(moved.identityEpoch);
  });

  it('rejects attachment when membership provenance exists and leaves every field unchanged', async () => {
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role,
          seat_type, provisioning_source, created_at, updated_at)
       VALUES ($1, $2, 'om_auth_isolation', 'credential@test.example', 'admin',
               'contributor', 'admin_added', NOW(), NOW())`,
      [CREDENTIAL, ORG_ID],
    );
    const membershipBefore = await pool.query(
      `SELECT * FROM organization_memberships
        WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [CREDENTIAL, ORG_ID],
    );
    const bindingBefore = await pool.query(
      `SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
      [CREDENTIAL],
    );

    await expect(
      attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A),
    ).rejects.toBeInstanceOf(CredentialHasStateError);

    const membershipAfter = await pool.query(
      `SELECT * FROM organization_memberships
        WHERE workos_user_id = $1 AND workos_organization_id = $2`,
      [CREDENTIAL, ORG_ID],
    );
    const bindingAfter = await pool.query(
      `SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
      [CREDENTIAL],
    );
    expect(membershipAfter.rows).toEqual(membershipBefore.rows);
    expect(bindingAfter.rows).toEqual(bindingBefore.rows);
  });

  it('serializes attachment against a concurrent state insert', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO organization_memberships
           (workos_user_id, workos_organization_id, workos_membership_id, email, role,
            seat_type, provisioning_source, created_at, updated_at)
         VALUES ($1, $2, 'om_auth_isolation_race', 'credential@test.example', 'member',
                 'community_only', 'webhook', NOW(), NOW())`,
        [CREDENTIAL, ORG_ID],
      );

      const attach = attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writer.query('COMMIT');

      await expect(attach).rejects.toMatchObject({
        references: expect.arrayContaining([
          { table: 'organization_memberships', column: 'workos_user_id' },
        ]),
      });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
  });

  it('rejects attachment when the credential carries a working-group leadership grant', async () => {
    const group = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, status)
       VALUES ('Authorization isolation', 'auth-isolation-leadership', 'active')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2)`,
      [group.rows[0].id, CREDENTIAL],
    );

    await expect(
      attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A),
    ).rejects.toMatchObject({
      references: expect.arrayContaining([
        { table: 'working_group_leaders', column: 'user_id' },
      ]),
    });
  });

  it('classifies every schema column that can carry a WorkOS user id', async () => {
    const candidates = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           USING (table_schema, table_name)
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.column_name NOT LIKE '%slack_user_id'
          AND (
            c.column_name ~ '(^|_)(workos_)?user_id$'
            OR c.column_name ~ '_by$'
          )
        ORDER BY c.table_name, c.column_name`,
    );
    const classified = new Set([
      ...USER_STATE_REFERENCES.map((ref) => `${ref.name}.${ref.col}`),
      ...USER_STATE_REFERENCE_EXCEPTIONS.map((ref) => `${ref.name}.${ref.col}`),
    ]);

    expect(
      candidates.rows
        .map((row) => `${row.table_name}.${row.column_name}`)
        .filter((reference) => !classified.has(reference)),
    ).toEqual([]);
  });

  it('makes same-host replay idempotent and rejects cross-identity replay', async () => {
    await attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A);
    await expect(attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A)).resolves.toBeUndefined();
    await expect(
      attachStateEmptyCredential(HOST_B, CREDENTIAL, HOST_B),
    ).rejects.toBeInstanceOf(CredentialAlreadyLinkedError);

    const bindings = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id
         FROM identity_workos_users
        WHERE identity_id = (
          SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
        )
        ORDER BY workos_user_id`,
      [CREDENTIAL],
    );
    expect(bindings.rows.map((row) => row.workos_user_id)).toEqual([HOST_A, CREDENTIAL].sort());
  });

  it('authorizes only the exact credential through an explicit grant and revokes via epoch', async () => {
    await attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A);
    const mockWorkos = {
      userManagement: {
        listOrganizationMemberships: async () => ({ data: [] }),
      },
    } as unknown as WorkOS;

    const beforeGrant = await epochFor(CREDENTIAL);
    await pool.query(
      `INSERT INTO organization_credential_grants (
         workos_organization_id, workos_user_id, role, granted_by_workos_user_id, reason
       ) VALUES ($1, $2, 'admin', $3, 'integration test')`,
      [ORG_ID, CREDENTIAL, HOST_A],
    );
    expect(await epochFor(CREDENTIAL)).toBeGreaterThan(beforeGrant);

    const granted = await resolveUserOrgMembership(
      mockWorkos,
      { id: HOST_A, authWorkosUserId: CREDENTIAL },
      ORG_ID,
    );
    expect(granted).toMatchObject({
      organizationId: ORG_ID,
      role: 'admin',
      via_credential_grant: true,
    });
    await expect(resolveUserOrgMembership(mockWorkos, { id: HOST_A }, ORG_ID)).resolves.toBeNull();

    const beforeRevoke = await epochFor(CREDENTIAL);
    await pool.query(
      `UPDATE organization_credential_grants
          SET revoked_at = NOW(), revoked_by_workos_user_id = $3, updated_at = NOW()
        WHERE workos_organization_id = $1 AND workos_user_id = $2`,
      [ORG_ID, CREDENTIAL, HOST_A],
    );
    expect(await epochFor(CREDENTIAL)).toBeGreaterThan(beforeRevoke);
    await expect(
      resolveUserOrgMembership(
        mockWorkos,
        { id: HOST_A, authWorkosUserId: CREDENTIAL },
        ORG_ID,
      ),
    ).resolves.toBeNull();
  });

  it('allows at most one concurrent host to attach a credential', async () => {
    const outcomes = await Promise.allSettled([
      attachStateEmptyCredential(HOST_A, CREDENTIAL, HOST_A),
      attachStateEmptyCredential(HOST_B, CREDENTIAL, HOST_B),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CredentialAlreadyLinkedError);

    const credentialIdentity = await pool.query<{ workos_user_id: string }>(
      `SELECT workos_user_id
         FROM identity_workos_users
        WHERE identity_id = (
          SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
        )`,
      [CREDENTIAL],
    );
    expect(credentialIdentity.rows).toHaveLength(2);
    expect(credentialIdentity.rows.map((row) => row.workos_user_id)).toContain(CREDENTIAL);
  });
});
