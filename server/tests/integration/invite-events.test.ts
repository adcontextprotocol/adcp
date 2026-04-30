import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  createMembershipInvite,
  markMembershipInviteAccepted,
  revokeMembershipInvite,
} from '../../src/db/membership-invites-db.js';
import { recordInviteEvent } from '../../src/db/person-events-db.js';
import { resolvePersonId } from '../../src/db/relationship-db.js';
import { runInviteExpirySweep } from '../../src/addie/jobs/invite-expiry-sweep.js';
import type { Pool } from 'pg';

const TEST_ORG_PREFIX = 'org_invite_events_test';
const TEST_EMAIL_DOMAIN = 'invite-events-test.example.com';
const TEST_ADMIN_ID = 'user_invite_events_admin';
const TEST_ACCEPTOR_ID = 'user_invite_events_acceptor';

interface InviteEventRow {
  event_type: string;
  occurred_at: Date;
  data: Record<string, unknown>;
}

describe('invite lifecycle events', () => {
  let pool: Pool;

  const createTestOrg = async (orgId: string, name = 'Invite Events Test Org') => {
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (workos_organization_id) DO NOTHING`,
      [orgId, name]
    );
  };

  const eventsForInvite = async (inviteId: string): Promise<InviteEventRow[]> => {
    const result = await pool.query(
      `SELECT event_type, occurred_at, data
       FROM person_events
       WHERE event_type IN ('invite_sent', 'invite_accepted', 'invite_revoked', 'invite_expired')
         AND data->>'invite_id' = $1
       ORDER BY occurred_at ASC`,
      [inviteId]
    );
    return result.rows.map((row) => ({
      event_type: row.event_type as string,
      occurred_at: new Date(row.occurred_at as string),
      data:
        typeof row.data === 'string'
          ? (JSON.parse(row.data as string) as Record<string, unknown>)
          : (row.data as Record<string, unknown>),
    }));
  };

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.query(
      `DELETE FROM person_events
       WHERE person_id IN (
         SELECT id FROM person_relationships WHERE email LIKE $1
       )`,
      [`%@${TEST_EMAIL_DOMAIN}`]
    );
    await pool.query('DELETE FROM person_relationships WHERE email LIKE $1', [
      `%@${TEST_EMAIL_DOMAIN}`,
    ]);
    await pool.query(
      'DELETE FROM membership_invites WHERE workos_organization_id LIKE $1',
      [`${TEST_ORG_PREFIX}%`]
    );
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [
      `${TEST_ORG_PREFIX}%`,
    ]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM person_events
       WHERE person_id IN (
         SELECT id FROM person_relationships WHERE email LIKE $1
       )`,
      [`%@${TEST_EMAIL_DOMAIN}`]
    );
    await pool.query('DELETE FROM person_relationships WHERE email LIKE $1', [
      `%@${TEST_EMAIL_DOMAIN}`,
    ]);
    await pool.query(
      'DELETE FROM membership_invites WHERE workos_organization_id LIKE $1',
      [`${TEST_ORG_PREFIX}%`]
    );
    await pool.query('DELETE FROM organizations WHERE workos_organization_id LIKE $1', [
      `${TEST_ORG_PREFIX}%`,
    ]);
  });

  it('createMembershipInvite emits invite_sent at created_at with the right payload', async () => {
    const orgId = `${TEST_ORG_PREFIX}_send`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `sent@${TEST_EMAIL_DOMAIN}`,
      contact_name: 'Sent User',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    const events = await eventsForInvite(invite.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('invite_sent');
    expect(events[0].occurred_at.getTime()).toBe(invite.created_at.getTime());
    expect(events[0].data.invite_id).toBe(invite.id);
    expect(events[0].data.token_prefix).toBe(invite.token.slice(0, 8));
    expect(events[0].data.org_id).toBe(orgId);
    expect(events[0].data.lookup_key).toBe('aao_membership_professional');
    expect(events[0].data.contact_name).toBe('Sent User');
    expect(events[0].data.invited_by_user_id).toBe(TEST_ADMIN_ID);
  });

  it('markMembershipInviteAccepted emits invite_accepted; duplicate accept does not duplicate the event', async () => {
    const orgId = `${TEST_ORG_PREFIX}_accept`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `accept@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });

    await markMembershipInviteAccepted(invite.token, TEST_ACCEPTOR_ID, 'in_accept_1');
    await markMembershipInviteAccepted(invite.token, TEST_ACCEPTOR_ID, 'in_accept_2');

    const events = await eventsForInvite(invite.id);
    expect(events.map((e) => e.event_type)).toEqual(['invite_sent', 'invite_accepted']);
    const accepted = events[1];
    expect(accepted.data.accepted_by_user_id).toBe(TEST_ACCEPTOR_ID);
    expect(accepted.data.invoice_id).toBe('in_accept_1');
  });

  it('revokeMembershipInvite captures previous_status: pending for a fresh invite', async () => {
    const orgId = `${TEST_ORG_PREFIX}_revoke_pending`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `revoke-pending@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });

    await revokeMembershipInvite(invite.token, TEST_ADMIN_ID);

    const events = await eventsForInvite(invite.id);
    expect(events.map((e) => e.event_type)).toEqual(['invite_sent', 'invite_revoked']);
    expect(events[1].data.previous_status).toBe('pending');
    expect(events[1].data.revoked_by_user_id).toBe(TEST_ADMIN_ID);
  });

  it('revokeMembershipInvite captures previous_status: expired for an already-expired invite', async () => {
    const orgId = `${TEST_ORG_PREFIX}_revoke_expired`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `revoke-expired@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await pool.query(
      `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
      [invite.id]
    );

    await revokeMembershipInvite(invite.token, TEST_ADMIN_ID);

    const events = await eventsForInvite(invite.id);
    const revoked = events.find((e) => e.event_type === 'invite_revoked');
    expect(revoked).toBeDefined();
    expect(revoked!.data.previous_status).toBe('expired');
  });

  it('recordInviteEvent is idempotent for the same (event_type, invite_id)', async () => {
    const orgId = `${TEST_ORG_PREFIX}_idem`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `idem@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });

    const personId = await resolvePersonId({ email: invite.contact_email });
    await recordInviteEvent(personId, 'invite_sent', invite.id, {
      data: { token_prefix: invite.token.slice(0, 8), org_id: orgId },
    });
    await recordInviteEvent(personId, 'invite_sent', invite.id, {
      data: { token_prefix: invite.token.slice(0, 8), org_id: orgId },
    });

    // The mutator already wrote one invite_sent at create time; manual re-writes
    // must not duplicate.
    const events = await eventsForInvite(invite.id);
    expect(events.filter((e) => e.event_type === 'invite_sent')).toHaveLength(1);
  });

  it('sweep emits invite_expired with occurred_at = expires_at and is idempotent', async () => {
    const orgId = `${TEST_ORG_PREFIX}_sweep`;
    await createTestOrg(orgId);

    const invite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `sweep@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await pool.query(
      `UPDATE membership_invites SET expires_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [invite.id]
    );
    const expiredAtRow = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM membership_invites WHERE id = $1`,
      [invite.id]
    );
    const expectedExpiresAt = new Date(expiredAtRow.rows[0].expires_at);

    const first = await runInviteExpirySweep();
    expect(first.candidates).toBe(1);
    expect(first.emitted).toBe(1);
    expect(first.resolveFailures).toBe(0);
    expect(first.recordFailures).toBe(0);

    const events = await eventsForInvite(invite.id);
    const expired = events.find((e) => e.event_type === 'invite_expired');
    expect(expired).toBeDefined();
    expect(expired!.occurred_at.getTime()).toBe(expectedExpiresAt.getTime());
    expect(expired!.data.detected_at).toBeTypeOf('string');

    const second = await runInviteExpirySweep();
    // The just-handled invite must not appear as a candidate again.
    const sweepedAgain = await eventsForInvite(invite.id);
    expect(sweepedAgain.filter((e) => e.event_type === 'invite_expired')).toHaveLength(1);
    expect(second.candidates).toBe(0);
    expect(second.emitted).toBe(0);
    expect(second.resolveFailures).toBe(0);
    expect(second.recordFailures).toBe(0);
  });

  it('sweep ignores invites that are revoked or accepted', async () => {
    const orgId = `${TEST_ORG_PREFIX}_sweep_terminal`;
    await createTestOrg(orgId);

    const revokedInvite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `revoked@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await pool.query(
      `UPDATE membership_invites
       SET expires_at = NOW() - INTERVAL '1 day',
           revoked_at = NOW() - INTERVAL '12 hours',
           revoked_by_user_id = $1
       WHERE id = $2`,
      [TEST_ADMIN_ID, revokedInvite.id]
    );

    const acceptedInvite = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `accepted@${TEST_EMAIL_DOMAIN}`,
      invited_by_user_id: TEST_ADMIN_ID,
    });
    await pool.query(
      `UPDATE membership_invites
       SET expires_at = NOW() - INTERVAL '1 day',
           accepted_at = NOW() - INTERVAL '12 hours',
           accepted_by_user_id = $1,
           invoice_id = 'in_accepted'
       WHERE id = $2`,
      [TEST_ACCEPTOR_ID, acceptedInvite.id]
    );

    await runInviteExpirySweep();

    const revokedEvents = await eventsForInvite(revokedInvite.id);
    expect(revokedEvents.find((e) => e.event_type === 'invite_expired')).toBeUndefined();
    const acceptedEvents = await eventsForInvite(acceptedInvite.id);
    expect(acceptedEvents.find((e) => e.event_type === 'invite_expired')).toBeUndefined();
  });

  it('reinvite flow: revoke original + create fresh share the recipient and emit distinct event chains', async () => {
    const orgId = `${TEST_ORG_PREFIX}_reinvite`;
    await createTestOrg(orgId);

    const original = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: 'aao_membership_professional',
      contact_email: `reinvite@${TEST_EMAIL_DOMAIN}`,
      contact_name: 'Reinvite Recipient',
      invited_by_user_id: TEST_ADMIN_ID,
    });

    // What the /reinvite endpoint does: revoke the original + create a fresh
    // invite with the same lookup_key/email/name.
    await revokeMembershipInvite(original.token, TEST_ADMIN_ID);
    const fresh = await createMembershipInvite({
      workos_organization_id: orgId,
      lookup_key: original.lookup_key,
      contact_email: original.contact_email,
      contact_name: original.contact_name ?? undefined,
      invited_by_user_id: TEST_ADMIN_ID,
    });

    expect(fresh.id).not.toBe(original.id);
    expect(fresh.token).not.toBe(original.token);
    expect(fresh.contact_email).toBe(original.contact_email);

    const originalEvents = await eventsForInvite(original.id);
    expect(originalEvents.map((e) => e.event_type)).toEqual([
      'invite_sent',
      'invite_revoked',
    ]);
    expect(originalEvents[1].data.previous_status).toBe('pending');

    const freshEvents = await eventsForInvite(fresh.id);
    expect(freshEvents.map((e) => e.event_type)).toEqual(['invite_sent']);

    // Both event chains attach to the same person_relationships row keyed by
    // contact_email — important for "show this person's invite history" use.
    const personIds = await pool.query<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM person_events
       WHERE data->>'invite_id' IN ($1, $2)`,
      [original.id, fresh.id]
    );
    expect(personIds.rows).toHaveLength(1);
  });
});
