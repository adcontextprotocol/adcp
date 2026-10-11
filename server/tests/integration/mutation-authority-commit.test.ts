import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { syncMembershipAuthority, deleteOrganizationMembership } from '../../src/db/membership-db.js';
import { WorkingGroupDatabase } from '../../src/db/working-group-db.js';
import { captureAddieMutationAuthority, revalidateAddieMutationAuthority } from '../../src/addie/mutation-authority.js';
const actor = `user_dispatch_commit_actor_${randomUUID()}`;
const target = `user_dispatch_commit_target_${randomUUID()}`;
const input = { targetUserId: target, actorUserId: actor, actorCanonicalUserId: actor,
  actorAuthorizationMechanism: 'aao_admin_working_group' as const, reason: 'Dispatch transaction test' };

describe.skipIf(!process.env.DATABASE_URL)('mutation authority commit proofs', () => {
  let pool: Pool;
  const db = new WorkingGroupDatabase();
  async function cleanup() {
    await pool.query('DROP TRIGGER IF EXISTS suppress_dispatch_audit ON aao_admin_access_events');
    await pool.query('DROP FUNCTION IF EXISTS suppress_dispatch_audit()');
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [[actor,target]]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[actor,target]]);
  }
  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL! }); await runMigrations();
  });
  afterAll(async () => { await cleanup(); await closeDatabase(); });
  beforeEach(async () => {
    await cleanup();
    for (const id of [actor,target]) await pool.query('INSERT INTO users (workos_user_id,email) VALUES ($1,$2)', [id,`${id}@example.test`]);
  });
  it('commits AAO grant and revoke with exact target epoch and dual-actor audit receipts', async () => {
    await db.grantAAOAdminMembership(input);
    expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
    await db.revokeAAOAdminMembership(input);
    expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('2');
    const events = await pool.query('SELECT reason FROM aao_admin_access_events WHERE target_user_id=$1', [target]);
    expect(events.rowCount).toBe(2);
    for (const event of events.rows) expect(JSON.parse(event.reason)).toMatchObject({ authenticated_credential_id: actor, canonical_user_id: actor });
  });
  it.each(['grant', 'revoke'] as const)('rolls back %s membership and epoch when a trigger suppresses its audit receipt', async operation => {
    if (operation === 'revoke') await db.grantAAOAdminMembership(input);
    const before = (await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows;
    await pool.query(`CREATE FUNCTION suppress_dispatch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await pool.query(`CREATE TRIGGER suppress_dispatch_audit BEFORE INSERT ON aao_admin_access_events FOR EACH ROW WHEN (NEW.actor_user_id = '${actor}') EXECUTE FUNCTION suppress_dispatch_audit()`);
    await expect(operation === 'grant' ? db.grantAAOAdminMembership(input) : db.revokeAAOAdminMembership(input)).rejects.toThrow('audit did not persist exactly one row');
    expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows).toEqual(before);
    const membership = await pool.query("SELECT 1 FROM working_group_memberships m JOIN working_groups g ON g.id=m.working_group_id WHERE g.slug='aao-admin' AND m.workos_user_id=$1 AND m.status='active'", [target]);
    expect(membership.rowCount).toBe(operation === 'grant' ? 0 : 1);
  });
  it('commits synchronized role and membership ID, then deletion, with exact target epochs', async () => {
    const org = `org_dispatch_membership_${randomUUID()}`;
    await pool.query("INSERT INTO organizations (workos_organization_id,name) VALUES ($1,'Pinnacle Agency')", [org]);
    try {
      await pool.query("INSERT INTO organization_memberships (workos_user_id,workos_organization_id,workos_membership_id,email,role) VALUES ($1,$2,'om_old','member@example.test','member')", [target,org]);
      expect(await syncMembershipAuthority(target, org, { role: 'admin', membershipId: 'om_current' })).toBe(true);
      expect((await pool.query('SELECT role,workos_membership_id FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [target,org])).rows).toEqual([{ role: 'admin', workos_membership_id: 'om_current' }]);
      expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
      expect(await syncMembershipAuthority(target, org, { role: 'admin', membershipId: 'om_current' })).toBe(true);
      expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
      expect(await deleteOrganizationMembership(target, org)).toBe('admin');
      expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('2');
    } finally { await pool.query('DELETE FROM organizations WHERE workos_organization_id=$1', [org]); }
  });

  it('keeps an external-client deletion and its epoch atomic on rollback and commit', async () => {
    const org = `org_dispatch_external_${randomUUID()}`;
    await pool.query("INSERT INTO organizations (workos_organization_id,name) VALUES ($1,'Pinnacle Agency')", [org]);
    await pool.query("INSERT INTO organization_memberships (workos_user_id,workos_organization_id,email,role) VALUES ($1,$2,'member@example.test','admin')", [target,org]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await deleteOrganizationMembership(target, org, client)).toBe('admin');
      expect((await client.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
      await client.query('ROLLBACK');
      expect((await pool.query('SELECT 1 FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [target,org])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM authorization_epochs WHERE workos_user_id=$1', [target])).rowCount).toBe(0);
      await client.query('BEGIN');
      await deleteOrganizationMembership(target, org, client); await client.query('COMMIT');
      expect((await pool.query('SELECT 1 FROM organization_memberships WHERE workos_user_id=$1 AND workos_organization_id=$2', [target,org])).rowCount).toBe(0);
      expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
    } finally { await client.query('ROLLBACK'); client.release(); await pool.query('DELETE FROM organizations WHERE workos_organization_id=$1', [org]); }
  });

  it('reports an inactive revoke target without claiming its retained membership is absent', async () => {
    await db.grantAAOAdminMembership(input);
    await pool.query("INSERT INTO registry_audit_log (workos_organization_id,workos_user_id,action,resource_type,resource_id) VALUES ('identity-lifecycle', $1::text,'identity_primary_deletion_quarantined','user',$1::text)", [target]);
    await expect(db.revokeAAOAdminMembership(input)).rejects.toThrow('Site-admin target credential is inactive');
    expect((await pool.query("SELECT 1 FROM working_group_memberships m JOIN working_groups g ON g.id=m.working_group_id WHERE g.slug='aao-admin' AND m.workos_user_id=$1 AND m.status='active'", [target])).rowCount).toBe(1);
    expect((await pool.query('SELECT epoch::text FROM authorization_epochs WHERE workos_user_id=$1', [target])).rows[0].epoch).toBe('1');
  });

  it('rejects a retained users row with a committed quarantine tombstone at dispatch', async () => {
    const authority = await captureAddieMutationAuthority({
      principal: { id: actor, email: `${actor}@example.test` }, platformAdminMutationTools: [],
      revalidateCredentialLifecycle: async () => 'authorized',
    });
    await pool.query("INSERT INTO registry_audit_log (workos_organization_id,workos_user_id,action,resource_type,resource_id) VALUES ('identity-lifecycle', $1::text,'identity_primary_deletion_quarantined','user',$1::text)", [actor]);
    expect((await pool.query('SELECT 1 FROM users WHERE workos_user_id=$1', [actor])).rowCount).toBe(1);
    expect(await revalidateAddieMutationAuthority(authority, 'update_member_profile')).toEqual({ allowed: false, status: 'access_denied' });
  });
});
