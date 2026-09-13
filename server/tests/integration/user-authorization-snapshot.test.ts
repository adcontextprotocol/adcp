import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  AuthorizationSnapshotUnavailableError,
  loadAuthorizationSnapshot,
  sameAuthorizationIdentity,
  sameAuthorizationSnapshot,
  type AuthorizationSnapshot,
} from '../../src/db/user-authorization-snapshot-db.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';

const PERSONAL_ID = 'user_authorization_snapshot_personal';
const CORPORATE_ID = 'user_authorization_snapshot_corporate';
const PERSONAL_ORG = 'org_authorization_snapshot_personal';
const CORPORATE_ORG = 'org_authorization_snapshot_corporate';
const USER_IDS = [PERSONAL_ID, CORPORATE_ID];
const ORG_IDS = [PERSONAL_ORG, CORPORATE_ORG];

describe('primary database authorization snapshots', () => {
  let pool: Pool;
  let fixtureIdentityIds: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  async function cleanup() {
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = ANY($1)', [ORG_IDS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ORG_IDS]);
    const identities = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [USER_IDS],
    );
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM identities WHERE id = ANY($1)', [
      [...fixtureIdentityIds, ...identities.rows.map(row => row.identity_id)],
    ]);
    fixtureIdentityIds = [];
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at)
       VALUES ($1, 'sam.personal@example.test', 'Sam', 'Adeyemi', true, NOW(), NOW()),
              ($2, 'sam@pinnacle.example', 'Sam', 'Adeyemi', true, NOW(), NOW())`,
      USER_IDS,
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name)
       VALUES ($1, 'Sam personal organization'), ($2, 'Pinnacle Agency')`,
      ORG_IDS,
    );
    const identities = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)', [USER_IDS],
    );
    fixtureIdentityIds = identities.rows.map(row => row.identity_id);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) await cleanup();
    await closeDatabase();
  });

  async function snapshot(userId = PERSONAL_ID, organizationId: string | null = null) {
    const result = await loadAuthorizationSnapshot(userId, organizationId);
    expect(result).not.toBeNull();
    return result!;
  }

  async function link(primaryId: string, secondaryId: string, db: Pool | PoolClient = pool) {
    await db.query(
      `UPDATE identity_workos_users
          SET identity_id = (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1),
              is_primary = FALSE
        WHERE workos_user_id = $2`,
      [primaryId, secondaryId],
    );
  }

  async function grant(
    userId: string,
    organizationId: string,
    options: { from?: string; until?: string | null; revoked?: boolean; role?: 'member' | 'admin' | 'owner' } = {},
  ) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO organization_credential_grants
         (workos_user_id, workos_organization_id, role, granted_by_workos_user_id,
          effective_from, effective_until, revoked_at, revoked_by_workos_user_id)
       VALUES ($1, $2, $3, $1, $4, $5,
               CASE WHEN $6 THEN NOW() ELSE NULL END,
               CASE WHEN $6 THEN $1::varchar ELSE NULL END)
       RETURNING id`,
      [userId, organizationId, options.role ?? 'member', options.from ?? '2000-01-01T00:00:00.123456Z',
        options.until ?? null, options.revoked ?? false],
    );
    return result.rows[0].id;
  }

  it('hydrates a cold exact credential with epoch zero and no implicit organization', async () => {
    await grant(PERSONAL_ID, PERSONAL_ORG);
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
       VALUES ($1, $2, 'sam.personal@example.test', 'owner')`,
      [PERSONAL_ID, CORPORATE_ORG],
    );

    const cold = await snapshot();
    expect(cold).toMatchObject({
      authenticatedUserId: PERSONAL_ID,
      canonicalUserId: PERSONAL_ID,
      authorizationEpoch: '0',
      selectedOrganizationId: null,
      credentialGrant: null,
      credential: { email: 'sam.personal@example.test', firstName: 'Sam', lastName: 'Adeyemi' },
    });
    expect(cold.identityId).toBeTruthy();
    expect(Object.isFrozen(cold)).toBe(true);
    expect(Object.isFrozen(cold.credential)).toBe(true);
    expect(await snapshot(PERSONAL_ID, '')).toEqual(cold);
    expect((await snapshot(PERSONAL_ID, CORPORATE_ORG)).credentialGrant).toBeNull();
  });

  it.each([
    { direction: 'personal primary', primaryId: PERSONAL_ID, secondaryId: CORPORATE_ID },
    { direction: 'corporate primary', primaryId: CORPORATE_ID, secondaryId: PERSONAL_ID },
  ])('keeps exact credential grants isolated with $direction', async ({ primaryId, secondaryId }) => {
    await link(primaryId, secondaryId);
    const personalGrantId = await grant(PERSONAL_ID, PERSONAL_ORG);
    const corporateGrantId = await grant(CORPORATE_ID, CORPORATE_ORG, { role: 'admin' });
    // Stale consolidated membership state is deliberately stronger than the
    // exact grants. Neither identity direction may inherit it as authority.
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role)
       VALUES ($1, $2, 'sam@pinnacle.example', 'owner'),
              ($1, $3, 'sam@pinnacle.example', 'owner')`,
      [primaryId, PERSONAL_ORG, CORPORATE_ORG],
    );

    const personal = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    const corporate = await snapshot(CORPORATE_ID, CORPORATE_ORG);
    expect(personal.canonicalUserId).toBe(primaryId);
    expect(corporate.canonicalUserId).toBe(primaryId);
    expect(personal.identityId).toBe(corporate.identityId);
    expect(personal.credential.email).toBe('sam.personal@example.test');
    expect(corporate.credential.email).toBe('sam@pinnacle.example');
    expect(personal.credentialGrant).toEqual({
      id: personalGrantId, organizationId: PERSONAL_ORG, role: 'member',
      effectiveFrom: '2000-01-01T00:00:00.123456Z', effectiveUntil: null,
    });
    expect(corporate.credentialGrant?.id).toBe(corporateGrantId);
    expect(corporate.credentialGrant?.role).toBe('admin');
    expect(Object.isFrozen(personal.credentialGrant)).toBe(true);
    expect((await snapshot(PERSONAL_ID, CORPORATE_ORG)).credentialGrant).toBeNull();
    expect((await snapshot(CORPORATE_ID, PERSONAL_ORG)).credentialGrant).toBeNull();
    expect((await snapshot(secondaryId, null)).credentialGrant).toBeNull();
    expect(sameAuthorizationIdentity(personal, corporate)).toBe(false);
  });

  it.each([
    { state: 'expired', from: '2000-01-01T00:00:00Z', until: '2001-01-01T00:00:00Z' },
    { state: 'future', from: '2999-01-01T00:00:00Z', until: null },
    { state: 'revoked', revoked: true },
  ])('excludes $state grants on a cold read', async options => {
    await grant(PERSONAL_ID, PERSONAL_ORG, options);
    const cold = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    expect(cold.selectedOrganizationId).toBe(PERSONAL_ORG);
    expect(cold.credentialGrant).toBeNull();
  });

  it('does not reuse a previously loaded grant after revocation', async () => {
    const grantId = await grant(PERSONAL_ID, PERSONAL_ORG);
    const cached = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    await pool.query(
      `UPDATE organization_credential_grants
          SET revoked_at = NOW(), revoked_by_workos_user_id = $2 WHERE id = $1`,
      [grantId, PERSONAL_ID],
    );
    const fresh = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    expect(fresh.credentialGrant).toBeNull();
    expect(sameAuthorizationIdentity(cached, fresh)).toBe(true);
    expect(sameAuthorizationSnapshot(cached, fresh)).toBe(false);
  });

  it('preserves bigint epochs and rejects forwards and backwards replay', async () => {
    await pool.query(
      'INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ($1, $2)',
      [PERSONAL_ID, '9007199254740992'],
    );
    const old = await snapshot();
    await bumpAuthorizationEpochs(pool, [PERSONAL_ID]);
    const bumped = await snapshot();
    expect(old.authorizationEpoch).toBe('9007199254740992');
    expect(bumped.authorizationEpoch).toBe('9007199254740993');
    expect(sameAuthorizationSnapshot(old, bumped)).toBe(false);
    expect(sameAuthorizationSnapshot(bumped, old)).toBe(false);
    await pool.query('DELETE FROM authorization_epochs WHERE workos_user_id = $1', [PERSONAL_ID]);
    const absent = await snapshot();
    expect(absent.authorizationEpoch).toBe('0');
    expect(sameAuthorizationSnapshot(bumped, absent)).toBe(false);
  });

  it('rejects replays with altered credential, identity, selection, or grant details', async () => {
    await grant(PERSONAL_ID, PERSONAL_ORG, { until: '2999-01-01T00:00:00.654321Z' });
    const current = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    expect(current.credentialGrant?.effectiveUntil).toBe('2999-01-01T00:00:00.654321Z');
    expect(sameAuthorizationSnapshot(current, structuredClone(current))).toBe(true);
    const identityChanges: Partial<AuthorizationSnapshot>[] = [
      { authenticatedUserId: CORPORATE_ID },
      { canonicalUserId: CORPORATE_ID },
      { identityId: null },
      { authorizationEpoch: '1' },
      { credential: { ...current.credential, email: 'changed@example.test' } },
    ];
    for (const change of identityChanges) {
      expect(sameAuthorizationIdentity(current, { ...current, ...change })).toBe(false);
      expect(sameAuthorizationSnapshot(current, { ...current, ...change })).toBe(false);
    }
    expect(sameAuthorizationSnapshot(current, { ...current, selectedOrganizationId: CORPORATE_ORG })).toBe(false);
    expect(sameAuthorizationSnapshot(current, { ...current, credentialGrant: null })).toBe(false);
    const grantChanges: Partial<NonNullable<AuthorizationSnapshot['credentialGrant']>>[] = [
      { id: 'replacement-grant' },
      { organizationId: CORPORATE_ORG },
      { role: 'owner' },
      { effectiveFrom: '2000-01-01T00:00:00.123457Z' },
      { effectiveUntil: '2999-01-01T00:00:00.654322Z' },
    ];
    for (const change of grantChanges) {
      expect(sameAuthorizationSnapshot(current, {
        ...current, credentialGrant: { ...current.credentialGrant!, ...change },
      })).toBe(false);
    }
  });

  it.each([
    { direction: 'personal into corporate', primaryId: CORPORATE_ID, secondaryId: PERSONAL_ID },
    { direction: 'corporate into personal', primaryId: PERSONAL_ID, secondaryId: CORPORATE_ID },
  ])('cannot stamp old identity with a newly committed epoch: $direction', async ({ primaryId, secondaryId }) => {
    const before = await snapshot(secondaryId);
    const writer = await pool.connect();
    let releaseRead!: () => void;
    let readCompleted!: () => void;
    const readBarrier = new Promise<void>(resolve => { readCompleted = resolve; });
    const deliveryBarrier = new Promise<void>(resolve => { releaseRead = resolve; });
    let pendingRead: Promise<AuthorizationSnapshot | null> | undefined;
    const actualQuery = pool.query.bind(pool);
    try {
      await writer.query('BEGIN');
      await link(primaryId, secondaryId, writer);
      // An observer while identity changed but before the transactional epoch
      // write still sees the complete old state through PostgreSQL MVCC.
      expect(await snapshot(secondaryId)).toEqual(before);
      await bumpAuthorizationEpochs(writer, [primaryId, secondaryId]);

      // Hold delivery of the first real SQL result while the writer commits.
      // A split identity/epoch loader would then issue its epoch query against
      // the new commit and return old identity + new epoch. No rows are mocked.
      const readSpy = vi.spyOn(pool, 'query').mockImplementationOnce(async (...args: any[]) => {
        const result = await (actualQuery as (...queryArgs: any[]) => Promise<unknown>)(...args);
        readCompleted();
        await deliveryBarrier;
        return result;
      });
      pendingRead = loadAuthorizationSnapshot(secondaryId, null);
      await Promise.race([readBarrier, pendingRead.then(() => {
        throw new Error('Snapshot returned without waiting for the database read');
      })]);
      await writer.query('COMMIT');
      releaseRead();
      const overlapping = await pendingRead;
      expect(overlapping).toEqual(before);
      expect(readSpy).toHaveBeenCalledTimes(1);
      readSpy.mockRestore();

      const after = await snapshot(secondaryId);
      expect(after.canonicalUserId).toBe(primaryId);
      expect(after.identityId).not.toBe(before.identityId);
      expect(after.authorizationEpoch).toBe('1');
      expect(sameAuthorizationSnapshot(before, after)).toBe(false);
      expect(sameAuthorizationSnapshot(after, before)).toBe(false);
    } finally {
      releaseRead();
      await writer.query('ROLLBACK');
      await pendingRead?.catch(() => undefined);
      vi.restoreAllMocks();
      writer.release();
    }
  });

  it('returns null for a missing exact credential, without using its former canonical person', async () => {
    await link(CORPORATE_ID, PERSONAL_ID);
    const cached = await snapshot(PERSONAL_ID);
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [PERSONAL_ID]);
    expect(await loadAuthorizationSnapshot(PERSONAL_ID, CORPORATE_ORG)).toBeNull();
    expect((await snapshot(CORPORATE_ID)).canonicalUserId).toBe(cached.canonicalUserId);
  });

  it.each(['binding', 'primary'])('fails unavailable for a missing identity %s', async missing => {
    if (missing === 'binding') {
      await pool.query('DELETE FROM identity_workos_users WHERE workos_user_id = $1', [PERSONAL_ID]);
    } else {
      await pool.query('UPDATE identity_workos_users SET is_primary = FALSE WHERE workos_user_id = $1', [PERSONAL_ID]);
    }
    await expect(loadAuthorizationSnapshot(PERSONAL_ID, null))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
  });

  it('fails unavailable on database errors instead of replaying a warm snapshot', async () => {
    await snapshot(PERSONAL_ID, PERSONAL_ORG);
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('private database connection details'));
    await expect(loadAuthorizationSnapshot(PERSONAL_ID, PERSONAL_ORG))
      .rejects.toThrow(new AuthorizationSnapshotUnavailableError());
  });

  it.each([
    { state: 'valid credential', hasUser: true },
    { state: 'absent credential', hasUser: false },
  ])('rejects a recovering replica with $state', async ({ hasUser }) => {
    const primary = await snapshot(PERSONAL_ID, PERSONAL_ORG);
    // The integration database is a primary. Simulate only the single query
    // result from a recovering replica, including its no-user anchor row.
    const readSpy = vi.spyOn(pool, 'query').mockResolvedValueOnce({
      rows: [{
        in_recovery: true,
        authenticated_user_id: hasUser ? primary.authenticatedUserId : null,
        canonical_user_id: hasUser ? primary.canonicalUserId : null,
        identity_id: hasUser ? primary.identityId : null,
        authorization_epoch: '0',
        email: hasUser ? primary.credential.email : null,
        first_name: hasUser ? primary.credential.firstName : null,
        last_name: hasUser ? primary.credential.lastName : null,
        grant_id: null,
        grant_organization_id: null,
        grant_role: null,
        grant_effective_from: null,
        grant_effective_until: null,
      }],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });
    await expect(loadAuthorizationSnapshot(PERSONAL_ID, PERSONAL_ORG))
      .rejects.toBeInstanceOf(AuthorizationSnapshotUnavailableError);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});
