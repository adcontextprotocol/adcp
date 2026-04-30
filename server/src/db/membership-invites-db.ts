import { randomBytes } from 'node:crypto';
import { query } from './client.js';
import { createLogger } from '../logger.js';
import { resolvePersonId } from './relationship-db.js';
import { recordInviteEvent } from './person-events-db.js';

const logger = createLogger('membership-invites-db');

export interface MembershipInvite {
  id: string;
  token: string;
  workos_organization_id: string;
  lookup_key: string;
  contact_email: string;
  contact_name: string | null;
  referral_code: string | null;
  invited_by_user_id: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_user_id: string | null;
  invoice_id: string | null;
  revoked_at: Date | null;
  revoked_by_user_id: string | null;
}

export interface CreateMembershipInviteInput {
  workos_organization_id: string;
  lookup_key: string;
  contact_email: string;
  contact_name?: string;
  referral_code?: string;
  invited_by_user_id: string;
  expires_in_days?: number;
}

export type InviteStatus =
  | 'pending'
  | 'accepted'
  | 'expired'
  | 'revoked';

export function inviteStatus(invite: MembershipInvite, now: Date = new Date()): InviteStatus {
  if (invite.revoked_at) return 'revoked';
  if (invite.accepted_at) return 'accepted';
  if (invite.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createMembershipInvite(
  input: CreateMembershipInviteInput
): Promise<MembershipInvite> {
  const token = generateToken();
  const expiresInDays = input.expires_in_days ?? 30;

  const result = await query<MembershipInvite>(
    `INSERT INTO membership_invites
       (token, workos_organization_id, lookup_key, contact_email, contact_name,
        referral_code, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::interval)
     RETURNING *`,
    [
      token,
      input.workos_organization_id,
      input.lookup_key,
      input.contact_email.trim().toLowerCase(),
      input.contact_name?.trim() || null,
      input.referral_code || null,
      input.invited_by_user_id,
      String(expiresInDays),
    ]
  );

  const created = result.rows[0];
  logger.info(
    {
      token: created.token.slice(0, 8) + '...',
      orgId: created.workos_organization_id,
      lookupKey: created.lookup_key,
      contactEmail: created.contact_email,
      invitedBy: created.invited_by_user_id,
    },
    'Membership invite created'
  );

  await emitInviteEvent('invite_sent', created, {
    occurredAt: created.created_at,
    extra: {
      lookup_key: created.lookup_key,
      contact_name: created.contact_name,
      expires_at: created.expires_at.toISOString(),
      invited_by_user_id: created.invited_by_user_id,
    },
  });

  return created;
}

export async function getMembershipInviteByToken(
  token: string
): Promise<MembershipInvite | null> {
  const result = await query<MembershipInvite>(
    'SELECT * FROM membership_invites WHERE token = $1',
    [token]
  );
  return result.rows[0] || null;
}

export async function listMembershipInvitesForOrg(
  workosOrganizationId: string
): Promise<MembershipInvite[]> {
  const result = await query<MembershipInvite>(
    `SELECT * FROM membership_invites
     WHERE workos_organization_id = $1
     ORDER BY created_at DESC`,
    [workosOrganizationId]
  );
  return result.rows;
}

/**
 * Marks the invite accepted and records the issued invoice. Returns the
 * updated row if the invite was pending at this moment, null otherwise —
 * the atomicity guards against a second accept racing with the first.
 */
export async function markMembershipInviteAccepted(
  token: string,
  acceptedByUserId: string,
  invoiceId: string
): Promise<MembershipInvite | null> {
  const result = await query<MembershipInvite>(
    `UPDATE membership_invites
     SET accepted_at = NOW(),
         accepted_by_user_id = $2,
         invoice_id = $3
     WHERE token = $1
       AND accepted_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [token, acceptedByUserId, invoiceId]
  );
  if (result.rows.length === 0) {
    return null;
  }
  const updated = result.rows[0];
  logger.info(
    {
      token: token.slice(0, 8) + '...',
      orgId: updated.workos_organization_id,
      acceptedBy: acceptedByUserId,
      invoiceId,
    },
    'Membership invite accepted'
  );

  await emitInviteEvent('invite_accepted', updated, {
    extra: {
      lookup_key: updated.lookup_key,
      accepted_by_user_id: acceptedByUserId,
      invoice_id: invoiceId,
    },
  });

  return updated;
}

export async function revokeMembershipInvite(
  token: string,
  revokedByUserId: string
): Promise<MembershipInvite | null> {
  const existing = await getMembershipInviteByToken(token);
  const previousStatus = existing ? inviteStatus(existing) : null;

  const result = await query<MembershipInvite>(
    `UPDATE membership_invites
     SET revoked_at = NOW(),
         revoked_by_user_id = $2
     WHERE token = $1
       AND accepted_at IS NULL
       AND revoked_at IS NULL
     RETURNING *`,
    [token, revokedByUserId]
  );
  const revoked = result.rows[0] || null;
  if (!revoked) {
    return null;
  }

  await emitInviteEvent('invite_revoked', revoked, {
    extra: {
      lookup_key: revoked.lookup_key,
      revoked_by_user_id: revokedByUserId,
      previous_status: previousStatus,
    },
  });

  return revoked;
}

/**
 * Resolve the recipient and emit a person_event for an invite lifecycle change.
 *
 * Person resolution failure must not abort the underlying invite operation —
 * the membership_invites row is the source of truth; the event log is history.
 * We log a warning and continue.
 */
async function emitInviteEvent(
  eventType: 'invite_sent' | 'invite_accepted' | 'invite_revoked',
  invite: MembershipInvite,
  options: {
    occurredAt?: Date;
    extra: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const personId = await resolvePersonId({
      email: invite.contact_email,
    });
    await recordInviteEvent(personId, eventType, invite.id, {
      occurredAt: options.occurredAt,
      data: {
        token_prefix: invite.token.slice(0, 8),
        org_id: invite.workos_organization_id,
        ...options.extra,
      },
    });
  } catch (err) {
    logger.warn(
      {
        err,
        eventType,
        inviteId: invite.id,
        orgId: invite.workos_organization_id,
        contactEmail: invite.contact_email,
      },
      'Failed to record invite event — invite operation succeeded'
    );
  }
}
