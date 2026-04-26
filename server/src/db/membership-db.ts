/**
 * Database operations for organization memberships.
 *
 * Extracted from the WorkOS webhook handler so the SQL can be exercised
 * by integration tests against a real PostgreSQL instance.
 */

import type { WorkOS } from '@workos-inc/node';
import { getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('membership-db');

// ── Types ────────────────────────────────────────────────────────────

export interface MembershipUpsertParams {
  user_id: string;
  organization_id: string;
  membership_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;          // raw role slug from WorkOS (e.g. 'member', 'admin', 'owner')
  seat_type: string;     // resolved seat type ('contributor' | 'community_only')
  has_explicit_seat_type: boolean;
}

export interface MembershipUpsertResult {
  assigned_role: string;
}

// ── Upsert ───────────────────────────────────────────────────────────

/**
 * Insert or update an organization membership.
 *
 * Auto-promotes to owner when the org has no admin/owner and the incoming
 * role is 'member'. The NOT EXISTS subquery is race-safe.
 *
 * Returns the role that was actually written (may differ from the input
 * role if auto-promotion fired).
 */
export async function upsertOrganizationMembership(
  params: MembershipUpsertParams,
): Promise<MembershipUpsertResult> {
  const pool = getPool();

  const effectiveRole = params.role === 'member' ? '__auto__' : params.role;

  const result = await pool.query<{ role: string }>(
    `INSERT INTO organization_memberships (
      workos_user_id,
      workos_organization_id,
      workos_membership_id,
      email,
      first_name,
      last_name,
      role,
      seat_type,
      synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      CASE
        WHEN $7 = '__auto__' AND NOT EXISTS (
          SELECT 1 FROM organization_memberships
          WHERE workos_organization_id = $2::varchar
            AND role IN ('admin', 'owner')
            AND workos_user_id != $1::varchar
        ) THEN 'owner'
        WHEN $7 = '__auto__' THEN 'member'
        ELSE $7
      END,
      $8, NOW()
    )
    ON CONFLICT (workos_user_id, workos_organization_id)
    DO UPDATE SET
      workos_membership_id = EXCLUDED.workos_membership_id,
      email = EXCLUDED.email,
      first_name = COALESCE(NULLIF(TRIM(organization_memberships.first_name), ''), EXCLUDED.first_name),
      last_name = COALESCE(NULLIF(TRIM(organization_memberships.last_name), ''), EXCLUDED.last_name),
      role = EXCLUDED.role,
      seat_type = CASE
        WHEN $9::boolean THEN EXCLUDED.seat_type
        ELSE organization_memberships.seat_type
      END,
      synced_at = NOW(),
      updated_at = NOW()
    RETURNING role`,
    [
      params.user_id,
      params.organization_id,
      params.membership_id,
      params.email,
      params.first_name,
      params.last_name,
      effectiveRole,
      params.seat_type,
      params.has_explicit_seat_type,
    ],
  );

  const assigned_role = result.rows[0]?.role || params.role;

  logger.info({
    membershipId: params.membership_id,
    userId: params.user_id,
    orgId: params.organization_id,
    role: assigned_role,
  }, 'Upserted organization membership');

  return { assigned_role };
}

// ── Delete ───────────────────────────────────────────────────────────

/**
 * Delete an organization membership. Returns the role of the deleted
 * row (or null if the row didn't exist).
 */
export async function deleteOrganizationMembership(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query<{ role: string }>(
    `DELETE FROM organization_memberships
     WHERE workos_user_id = $1 AND workos_organization_id = $2
     RETURNING role`,
    [userId, organizationId],
  );

  return result.rows[0]?.role ?? null;
}

// ── Invitation seat type ─────────────────────────────────────────────

/**
 * Consume any pending seat_type assignment from an invitation.
 * Returns the seat type if one was found, or null.
 */
export async function consumeInvitationSeatType(
  organizationId: string,
  email: string,
): Promise<string | null> {
  const pool = getPool();

  const result = await pool.query<{ seat_type: string }>(
    `DELETE FROM invitation_seat_types
     WHERE workos_organization_id = $1 AND lower(email) = lower($2)
     RETURNING seat_type`,
    [organizationId, email],
  );

  return result.rows[0]?.seat_type ?? null;
}

// ── Successor promotion query ────────────────────────────────────────

/**
 * Find the longest-tenured member to promote when an owner/admin is removed.
 * Only returns a row when the org has zero remaining admin/owner members.
 */
export async function findSuccessorForPromotion(
  organizationId: string,
): Promise<{ workos_user_id: string; workos_membership_id: string | null } | null> {
  const pool = getPool();

  const result = await pool.query<{ workos_user_id: string; workos_membership_id: string | null }>(
    `SELECT workos_user_id, workos_membership_id FROM organization_memberships
     WHERE workos_organization_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM organization_memberships
         WHERE workos_organization_id = $1 AND role IN ('admin', 'owner')
       )
     ORDER BY created_at ASC
     LIMIT 1`,
    [organizationId],
  );

  return result.rows[0] ?? null;
}

/**
 * Set the role of a membership in the local database.
 */
export async function setMembershipRole(
  userId: string,
  organizationId: string,
  role: string,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE organization_memberships SET role = $3, updated_at = NOW()
     WHERE workos_user_id = $1 AND workos_organization_id = $2`,
    [userId, organizationId, role],
  );
}

// ── Auto-link by verified domain ────────────────────────────────────

export interface DomainLinkResult {
  organizationId: string;
  organizationName: string;
  role: string;
}

/**
 * Check whether a user's email domain matches a verified domain on an
 * organization with an active subscription. If so, create a WorkOS membership
 * for them.
 *
 * Idempotent: short-circuits when the user is already in the candidate org's
 * local membership cache, and treats `organization_membership_already_exists`
 * from WorkOS as success. Safe to call on every authenticated request.
 *
 * Honors the per-org `auto_provision_verified_domain` opt-out: orgs that
 * prefer explicit invites only set this to false.
 */
export async function autoLinkByVerifiedDomain(
  workos: WorkOS,
  userId: string,
  email: string,
): Promise<DomainLinkResult | null> {
  const pool = getPool();
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return null;

  const result = await pool.query<{
    workos_organization_id: string;
    org_name: string;
    user_already_member: boolean;
  }>(`
    SELECT
      od.workos_organization_id,
      o.name AS org_name,
      EXISTS (
        SELECT 1 FROM organization_memberships om
        WHERE om.workos_organization_id = od.workos_organization_id
          AND om.workos_user_id = $2
      ) AS user_already_member
    FROM organization_domains od
    JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
    WHERE LOWER(od.domain) = $1
      AND od.verified = true
      AND o.subscription_status = 'active'
      AND o.subscription_canceled_at IS NULL
      AND COALESCE(o.auto_provision_verified_domain, true) = true
    LIMIT 1
  `, [emailDomain, userId]);

  if (result.rows.length === 0) return null;

  const {
    workos_organization_id: orgId,
    org_name: orgName,
    user_already_member: userAlreadyMember,
  } = result.rows[0];

  if (userAlreadyMember) return null;

  // Always create as member. Auto-promotion to owner for ownerless orgs is
  // handled atomically by upsertOrganizationMembership when the
  // organization_membership.created webhook fires — that path uses a NOT EXISTS
  // subquery against the live membership table, which is race-safe and not
  // vulnerable to the local-cache skew that a `has_admin` lookup here would be.
  try {
    await workos.userManagement.createOrganizationMembership({
      userId,
      organizationId: orgId,
      roleSlug: 'member',
    });

    logger.info({ userId, email, orgId, orgName }, 'Auto-linked user to organization via verified domain');
    return { organizationId: orgId, organizationName: orgName, role: 'member' };
  } catch (err: any) {
    if (err?.code === 'organization_membership_already_exists') {
      // Membership exists but wasn't returned by list — return as success
      logger.info({ userId, orgId }, 'Auto-link skipped: membership already exists in WorkOS');
      return { organizationId: orgId, organizationName: orgName, role: 'member' };
    }
    logger.warn({ err, userId, orgId }, 'Failed to auto-link user to organization');
    return null;
  }
}
