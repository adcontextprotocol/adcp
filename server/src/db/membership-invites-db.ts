import { randomBytes } from 'node:crypto';
import { query } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('membership-invites-db');

export interface MembershipInvite {
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
  return updated;
}

export async function revokeMembershipInvite(
  token: string,
  revokedByUserId: string
): Promise<MembershipInvite | null> {
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
  return result.rows[0] || null;
}
