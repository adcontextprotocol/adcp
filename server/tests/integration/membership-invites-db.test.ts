import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createMembershipInvite,
  getMembershipInviteByToken,
  listMembershipInvitesForOrg,
  markMembershipInviteAccepted,
  revokeMembershipInvite,
  inviteStatus,
} from '../../src/db/membership-invites-db.js';
import { OrganizationDatabase, type BillingAddress } from '../../src/db/organization-db.js';
import type { Pool } from 'pg';

const TEST_ORG_PREFIX = 'org_invites_db_test';
const TEST_ADMIN_ID = 'user_invites_admin';
const TEST_ACCEPTOR_ID = 'user_invites_acceptor';

describe('membership-invites-db', () => {
  let pool: Pool;

  const createTestOrg = async (orgId: string, name = 'Test Org') => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, name]
    );
  };

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM membership_invites WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM membership_invites WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [`${TEST_ORG_PREFIX}%`]);
  });

  it('creates an invite with a unique 64-char hex token', async () => {
    const orgId = `${TEST_ORG_PREFIX}_create`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'Finance@Example.COM',
      contact_name: 'Finance Team',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.contact_email).toBe('finance@example.com'); // normalized
    expect(invite.contact_name).toBe('Finance Team');
    expect(invite.lookup_key).toBe('aao_membership_professional');
    expect(invite.accepted_at).toBeNull();
    expect(invite.revoked_at).toBeNull();
    expect(invite.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('honors expires_in_days', async () => {
    const orgId = `${TEST_ORG_PREFIX}_expiry`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'x@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
      expires_in_days: 7,
    });

    const daysUntilExpiry = (invite.expires_at.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysUntilExpiry).toBeGreaterThan(6.9);
    expect(daysUntilExpiry).toBeLessThan(7.1);
  });

  it('looks up invites by token and lists by org', async () => {
    const orgId = `${TEST_ORG_PREFIX}_list`;
    await createTestOrg(orgId);

    const a = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'a@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });
    const b = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_builder',
      contact_email: 'b@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    const fetched = await getMembershipInviteByToken(a.token);
    expect(fetched?.contact_email).toBe('a@example.com');

    const list = await listMembershipInvitesForOrg(orgId);
    expect(list.map(i => i.contact_email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('returns null for unknown tokens', async () => {
    const fetched = await getMembershipInviteByToken('nope');
    expect(fetched).toBeNull();
  });

  it('markAccepted succeeds exactly once (second attempt returns null)', async () => {
    const orgId = `${TEST_ORG_PREFIX}_accept`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'x@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    const first = await markMembershipInviteAccepted(invite.token, TEST_ACCEPTOR_ID, 'in_test1');
    expect(first).not.toBeNull();
    expect(first?.accepted_by_user_id).toBe(TEST_ACCEPTOR_ID);
    expect(first?.invoice_id).toBe('in_test1');

    const second = await markMembershipInviteAccepted(invite.token, TEST_ACCEPTOR_ID, 'in_test2');
    expect(second).toBeNull();
  });

  it('markAccepted rejects revoked or expired invites', async () => {
    const orgId = `${TEST_ORG_PREFIX}_reject`;
    await createTestOrg(orgId);

    const revoked = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'r@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await revokeMembershipInvite(revoked.token, TEST_ADMIN_ID);
    const revokedAccept = await markMembershipInviteAccepted(revoked.token, TEST_ACCEPTOR_ID, 'in_r');
    expect(revokedAccept).toBeNull();

    // Force-expire a fresh invite by updating directly
    const expired = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'e@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await pool.query(
      `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '1 minute' WHERE token = $1`,
      [expired.token]
    );
    const expiredAccept = await markMembershipInviteAccepted(expired.token, TEST_ACCEPTOR_ID, 'in_e');
    expect(expiredAccept).toBeNull();
  });

  it('revoke marks invite revoked and blocks future acceptance', async () => {
    const orgId = `${TEST_ORG_PREFIX}_revoke`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'r@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    const revoked = await revokeMembershipInvite(invite.token, TEST_ADMIN_ID);
    expect(revoked?.revoked_at).toBeInstanceOf(Date);
    expect(revoked?.revoked_by_user_id).toBe(TEST_ADMIN_ID);

    const status = inviteStatus(revoked!);
    expect(status).toBe('revoked');
  });

  it('revoke is idempotent only for pending invites — already-accepted invites cannot be revoked', async () => {
    const orgId = `${TEST_ORG_PREFIX}_revoke_accepted`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'ra@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await markMembershipInviteAccepted(invite.token, TEST_ACCEPTOR_ID, 'in_ra');

    const revokeAttempt = await revokeMembershipInvite(invite.token, TEST_ADMIN_ID);
    expect(revokeAttempt).toBeNull();
  });

  it('cascades invite deletion when the org is deleted', async () => {
    const orgId = `${TEST_ORG_PREFIX}_cascade`;
    await createTestOrg(orgId);
    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: 'c@example.com',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [orgId]);

    const found = await getMembershipInviteByToken(invite.token);
    expect(found).toBeNull();
  });
});

describe('organizations.billing_address', () => {
  let pool: Pool;
  let orgDb: OrganizationDatabase;
  const ADDRESS_ORG_ID = `${TEST_ORG_PREFIX}_addr`;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    orgDb = new OrganizationDatabase();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ADDRESS_ORG_ID]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ADDRESS_ORG_ID]);
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [ADDRESS_ORG_ID, 'Addr Test Org']
    );
  });

  it('round-trips a billing_address through updateOrganization', async () => {
    const address: BillingAddress = {
      line1: '123 Main St',
      line2: 'Suite 400',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    };
    await orgDb.updateOrganization(ADDRESS_ORG_ID, { billing_address: address });
    const org = await orgDb.getOrganization(ADDRESS_ORG_ID);
    expect(org?.billing_address).toEqual(address);
  });

  it('stores NULL when billing_address is not set', async () => {
    const org = await orgDb.getOrganization(ADDRESS_ORG_ID);
    expect(org?.billing_address).toBeNull();
  });
});
