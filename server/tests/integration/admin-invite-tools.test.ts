/**
 * Integration tests for the four membership-invite Addie tools added in #3581:
 *   list_invites_for_org, resend_invite, revoke_invite, diagnose_signin_block
 *
 * The handlers reach into person_relationships, membership_invites, and
 * organizations. Tests use a real DB (per project convention) and prefix-based
 * fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, query } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createAdminToolHandlers } from '../../src/addie/mcp/admin-tools.js';
import { createMembershipInvite } from '../../src/db/membership-invites-db.js';

const ORG_PUBX = 'org_admin_invite_tools_pubx';
const ORG_NONMEMBER = 'org_admin_invite_tools_nonmember';
const TEST_DOMAIN = 'admin-invite-tools.test';
const ADMIN_ID = 'user_admin_invite_tools_admin';
const ADMIN_EMAIL = `admin@${TEST_DOMAIN}`;

async function cleanup() {
  await query(
    `DELETE FROM person_events
     WHERE person_id IN (SELECT id FROM person_relationships WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  );
  await query('DELETE FROM person_relationships WHERE email LIKE $1', [`%@${TEST_DOMAIN}`]);
  await query('DELETE FROM membership_invites WHERE workos_organization_id IN ($1, $2)', [
    ORG_PUBX,
    ORG_NONMEMBER,
  ]);
  await query('DELETE FROM organizations WHERE workos_organization_id IN ($1, $2)', [
    ORG_PUBX,
    ORG_NONMEMBER,
  ]);
}

describe('admin invite tools', () => {
  let listInvites: (input: Record<string, unknown>) => Promise<string>;
  let resendInvite: (input: Record<string, unknown>) => Promise<string>;
  let revokeInvite: (input: Record<string, unknown>) => Promise<string>;
  let diagnoseSigninBlock: (input: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    await cleanup();

    const handlers = createAdminToolHandlers({
      is_mapped: true,
      is_member: true,
      workos_user: {
        workos_user_id: ADMIN_ID,
        email: ADMIN_EMAIL,
        first_name: 'Admin',
        last_name: 'User',
      },
    });

    listInvites = handlers.get('list_invites_for_org')!;
    resendInvite = handlers.get('resend_invite')!;
    revokeInvite = handlers.get('revoke_invite')!;
    diagnoseSigninBlock = handlers.get('diagnose_signin_block')!;
    if (!listInvites || !resendInvite || !revokeInvite || !diagnoseSigninBlock) {
      throw new Error('One or more invite tool handlers not registered');
    }
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
  });

  describe('list_invites_for_org', () => {
    it('rejects a missing or malformed org_id', async () => {
      expect(await listInvites({ org_id: '' })).toMatch(/org_id is required/);
      expect(await listInvites({ org_id: 'not-an-org-id' })).toMatch(/org_id is required/);
    });

    it('returns a totals header even when there are no matching invites', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx Tools Test', TEST_DOMAIN]
      );
      const out = await listInvites({ org_id: ORG_PUBX });
      expect(out).toContain('## Invitations for ' + ORG_PUBX);
      expect(out).toContain('0 pending, 0 expired, 0 accepted, 0 revoked');
      expect(out).toContain('No invites pending or expired');
    });

    it('defaults to pending+expired and exposes a token suffix per row', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx Tools Test', TEST_DOMAIN]
      );
      const pending = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `tej@${TEST_DOMAIN}`,
        contact_name: 'Tej Test',
        invited_by_user_id: ADMIN_ID,
      });
      const expired = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `keerthi@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
        [expired.id]
      );
      // An accepted one to make sure it's hidden by default
      const accepted = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `lukasz@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invoice_id = 'in_t' WHERE id = $2`,
        [ADMIN_ID, accepted.id]
      );

      const out = await listInvites({ org_id: ORG_PUBX });

      expect(out).toContain('1 pending, 1 expired, 1 accepted, 0 revoked');
      expect(out).toContain(pending.token.slice(0, 8));
      expect(out).toContain(expired.token.slice(0, 8));
      expect(out).not.toContain(accepted.token.slice(0, 8));
      expect(out).toContain(`tej@${TEST_DOMAIN}`);
      expect(out).toContain(`keerthi@${TEST_DOMAIN}`);
    });

    it('include_accepted surfaces accepted invites', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx Tools Test', TEST_DOMAIN]
      );
      const accepted = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `lukasz@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invoice_id = 'in_t' WHERE id = $2`,
        [ADMIN_ID, accepted.id]
      );

      const out = await listInvites({ org_id: ORG_PUBX, include_accepted: true });
      expect(out).toContain(accepted.token.slice(0, 8));
      expect(out).toContain('[accepted]');
    });
  });

  describe('revoke_invite', () => {
    it('rejects missing args', async () => {
      expect(await revokeInvite({ org_id: ORG_PUBX })).toMatch(/token is required/);
      expect(await revokeInvite({ token: 'x', org_id: 'invalid' })).toMatch(
        /org_id is required/
      );
    });

    it('returns not-found for cross-org token (defense-in-depth via SQL scope)', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()), ($4, $5, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN, ORG_NONMEMBER, 'Other Org']
      );
      const inv = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `tej@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      const out = await revokeInvite({ token: inv.token, org_id: ORG_NONMEMBER });
      expect(out).toMatch(/Invite not found/);
    });

    it('revokes a pending invite and reports previous status', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      const inv = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `tej@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });

      const out = await revokeInvite({ token: inv.token, org_id: ORG_PUBX });
      expect(out).toContain('Revoked invite');
      expect(out).toContain(`tej@${TEST_DOMAIN}`);
      expect(out).toContain('Was:** pending');
    });

    it('refuses to revoke an already-accepted invite', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      const inv = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `lukasz@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invoice_id = 'in_t' WHERE id = $2`,
        [ADMIN_ID, inv.id]
      );

      const out = await revokeInvite({ token: inv.token, org_id: ORG_PUBX });
      expect(out).toMatch(/already accepted/);
    });
  });

  describe('diagnose_signin_block', () => {
    it('rejects malformed args', async () => {
      expect(await diagnoseSigninBlock({ email: 'no-at-sign', org_id: ORG_PUBX })).toMatch(
        /email is required/
      );
      expect(await diagnoseSigninBlock({ email: 'ok@x.com', org_id: 'no' })).toMatch(
        /org_id is required/
      );
    });

    it('returns needs_signin when the person already has a WorkOS account', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      await query(
        `INSERT INTO person_relationships (email, workos_user_id, stage)
         VALUES ($1, $2, 'welcomed')`,
        [`signed-in@${TEST_DOMAIN}`, 'user_already_workos']
      );

      const out = await diagnoseSigninBlock({
        email: `signed-in@${TEST_DOMAIN}`,
        org_id: ORG_PUBX,
      });
      expect(out).toMatch(/Verdict: needs_signin/);
      expect(out).toMatch(/WorkOS account/);
    });

    it('returns needs_resend when the only invite is expired', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      const inv = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `expired-only@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '5 days' WHERE id = $1`,
        [inv.id]
      );

      const out = await diagnoseSigninBlock({
        email: `expired-only@${TEST_DOMAIN}`,
        org_id: ORG_PUBX,
      });
      expect(out).toMatch(/Verdict: needs_resend/);
      expect(out).toContain(inv.token.slice(0, 8));
      expect(out).toMatch(/resend_invite/);
    });

    it('returns needs_signin (auto-domain) when org pays + email_domain matches and no record exists', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, subscription_status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );

      const out = await diagnoseSigninBlock({
        email: `brand-new@${TEST_DOMAIN}`,
        org_id: ORG_PUBX,
      });
      expect(out).toMatch(/Verdict: needs_signin/);
      expect(out).toMatch(/auto-link/);
    });

    it('returns needs_human when org is not paying and there is no invite', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, subscription_status, created_at, updated_at)
         VALUES ($1, $2, $3, NULL, NOW(), NOW())`,
        [ORG_NONMEMBER, 'NonMember', TEST_DOMAIN]
      );

      const out = await diagnoseSigninBlock({
        email: `cold@${TEST_DOMAIN}`,
        org_id: ORG_NONMEMBER,
      });
      expect(out).toMatch(/Verdict: needs_human/);
    });

    it('returns needs_invite when org pays but the email_domain does not match', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, subscription_status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', `other-domain.${TEST_DOMAIN}`]
      );

      const out = await diagnoseSigninBlock({
        email: `mismatched@${TEST_DOMAIN}`,
        org_id: ORG_PUBX,
      });
      expect(out).toMatch(/Verdict: needs_invite/);
      expect(out).toMatch(/send_payment_request/);
    });
  });

  describe('add_member_to_org arg validation', () => {
    let addMemberToOrg: (input: Record<string, unknown>) => Promise<string>;
    beforeAll(() => {
      const handlers = createAdminToolHandlers({
        is_mapped: true,
        is_member: true,
        workos_user: {
          workos_user_id: ADMIN_ID,
          email: ADMIN_EMAIL,
          first_name: 'Admin',
          last_name: 'User',
        },
      });
      addMemberToOrg = handlers.get('add_member_to_org')!;
    });

    it('rejects missing email', async () => {
      expect(await addMemberToOrg({ org_id: ORG_PUBX })).toMatch(/email is required/);
    });

    it('rejects missing or malformed org_id', async () => {
      expect(await addMemberToOrg({ email: 'x@y.com' })).toMatch(/org_id is required/);
      expect(await addMemberToOrg({ email: 'x@y.com', org_id: 'not-an-org' })).toMatch(/org_id is required/);
    });

    it('rejects invalid role enum', async () => {
      expect(
        await addMemberToOrg({ email: 'x@y.com', org_id: ORG_PUBX, role: 'superadmin' })
      ).toMatch(/role must be one of/);
    });

    it('rejects invalid seat_type enum', async () => {
      expect(
        await addMemberToOrg({ email: 'x@y.com', org_id: ORG_PUBX, seat_type: 'corporate' })
      ).toMatch(/seat_type must be one of/);
    });

    it('refuses without admin context', async () => {
      const handlers = createAdminToolHandlers(null);
      const fn = handlers.get('add_member_to_org')!;
      expect(await fn({ email: 'x@y.com', org_id: ORG_PUBX })).toMatch(/no signed-in admin/);
    });
  });

  // resend_invite happy-path requires Stripe-backed product validation, which
  // isn't seeded in the test DB. The existing /reinvite HTTP route test in
  // invite-events.test.ts covers the underlying revoke-then-create flow via
  // the same primitives. We exercise resend_invite's auth + arg validation
  // and the not-found path here.
  describe('resend_invite', () => {
    it('rejects missing args', async () => {
      expect(await resendInvite({ org_id: ORG_PUBX })).toMatch(/token is required/);
      expect(await resendInvite({ token: 'x', org_id: 'no' })).toMatch(/org_id is required/);
    });

    it('returns not-found for cross-org or unknown token', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      const out = await resendInvite({ token: 'tok_unknown', org_id: ORG_PUBX });
      expect(out).toMatch(/Invite not found/);
    });

    it('refuses to resend an already-accepted invite', async () => {
      await query(
        `INSERT INTO organizations (workos_organization_id, name, email_domain, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [ORG_PUBX, 'Pubx', TEST_DOMAIN]
      );
      const inv = await createMembershipInvite({
        workos_organization_id: ORG_PUBX,
        lookup_key: 'aao_membership_professional',
        contact_email: `lukasz@${TEST_DOMAIN}`,
        invited_by_user_id: ADMIN_ID,
      });
      await query(
        `UPDATE membership_invites SET accepted_at = NOW(), accepted_by_user_id = $1, invoice_id = 'in_t' WHERE id = $2`,
        [ADMIN_ID, inv.id]
      );

      const out = await resendInvite({ token: inv.token, org_id: ORG_PUBX });
      expect(out).toMatch(/already accepted/);
    });
  });
});
