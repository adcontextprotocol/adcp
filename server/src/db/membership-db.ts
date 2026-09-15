/**
 * Database operations for organization memberships.
 *
 * Extracted from the WorkOS webhook handler so the SQL can be exercised
 * by integration tests against a real PostgreSQL instance.
 */

import type { WorkOS } from '@workos-inc/node';
import type { PoolClient } from 'pg';
import { getPool, getClient } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('membership-db');

// ── Types ────────────────────────────────────────────────────────────

/** Tracks how each organization_memberships row came to exist. */
export type ProvisioningSource =
  | 'verified_domain'  // autoLinkByVerifiedDomain
  | 'invited'          // POST /:orgId/invitations or /members/by-email Path 1
  | 'admin_added'      // /members/by-email Path 2 direct add
  | 'webhook'          // organization_membership.created with no staged source
  | 'unknown';

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
  /**
   * Provisioning source to record on the local cache row. Only written when
   * the row is being inserted (or when the existing row has NULL/'unknown'
   * source) — once a membership is tagged, subsequent webhook upserts don't
   * overwrite the original attribution.
   */
  provisioning_source?: ProvisioningSource;
}

export interface MembershipUpsertResult {
  assigned_role: string;
}

// ── Upsert ───────────────────────────────────────────────────────────

/** Mirror the provider role; never infer an owner from organization cardinality. */
export async function upsertOrganizationMembership(
  params: MembershipUpsertParams,
  externalClient?: PoolClient,
): Promise<MembershipUpsertResult> {
  const database = externalClient ?? getPool();

  const result = await database.query<{ role: string }>(
    `INSERT INTO organization_memberships (
      workos_user_id,
      workos_organization_id,
      workos_membership_id,
      email,
      first_name,
      last_name,
      role,
      seat_type,
      provisioning_source,
      synced_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $10, NOW()
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
      -- Don't overwrite an existing attribution; later webhooks would be the
      -- 'webhook' source and would otherwise wipe a more specific origin.
      provisioning_source = COALESCE(organization_memberships.provisioning_source, EXCLUDED.provisioning_source),
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
      params.role,
      params.seat_type,
      params.has_explicit_seat_type,
      params.provisioning_source ?? null,
    ],
  );

  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error('Membership upsert did not write exactly one row');
  }
  const assigned_role = result.rows[0].role;

  logger.info({
    membershipId: params.membership_id,
    userId: params.user_id,
    orgId: params.organization_id,
    role: assigned_role,
  }, 'Upserted organization membership');

  return { assigned_role };
}

/**
 * Compatibility entry point. Ordinary membership events preserve the provider
 * role. First-owner and recovery grants require a separate explicit flow.
 */
export async function resolveRoleWithWorkosFirstPromote(args: {
  workos: WorkOS;
  membershipId: string;
  userId: string;
  organizationId: string;
  incomingRole: string;
}): Promise<{ role: string; promoted: boolean; promotionError?: unknown }> {
  return { role: args.incomingRole, promoted: false };
}

// ── Delete ───────────────────────────────────────────────────────────

/**
 * Delete an organization membership. Returns the role of the deleted
 * row (or null if the row didn't exist).
 *
 * Also clears users.primary_organization_id when it pointed at this org —
 * a stale pointer would let resolvePrimaryOrganization keep returning a
 * removed-org id, which read sites use as an authorization scope. Next
 * read backfills via resolvePreferredOrganization.
 *
 * @param externalClient — when provided, the caller owns the transaction;
 *   we run only the DELETE+UPDATE on that client without BEGIN/COMMIT.
 *   The caller MUST have already issued BEGIN on this client — otherwise
 *   the DELETE and UPDATE run as separate auto-commit statements and the
 *   atomic guarantee this helper exists to provide silently regresses.
 *   Lets a multi-step caller (admin transfer-member) wrap this with a
 *   sibling write in one atomic unit.
 */
export async function deleteOrganizationMembership(
  userId: string,
  organizationId: string,
  externalClient?: PoolClient,
): Promise<string | null> {
  // Atomic: DELETE membership and clear the cached pointer in one transaction.
  // If the DELETE succeeded but the pointer-clear UPDATE failed, we'd recreate
  // the exact stale-pointer state the integrity invariant exists to catch.
  const client = externalClient ?? await getClient();
  const ownsTransaction = externalClient === undefined;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const result = await client.query<{ role: string }>(
      `DELETE FROM organization_memberships
       WHERE workos_user_id = $1 AND workos_organization_id = $2
       RETURNING role`,
      [userId, organizationId],
    );
    await client.query(
      `UPDATE users SET primary_organization_id = NULL, updated_at = NOW()
       WHERE workos_user_id = $1 AND primary_organization_id = $2`,
      [userId, organizationId],
    );
    if (ownsTransaction) await client.query('COMMIT');
    return result.rows[0]?.role ?? null;
  } catch (err) {
    if (ownsTransaction) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    }
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/** Delete only the exact provider membership represented by a webhook event. */
export async function deleteExactOrganizationMembership(
  userId: string,
  organizationId: string,
  membershipId: string,
  client: PoolClient,
): Promise<string | null> {
  const result = await client.query<{ role: string }>(
    `DELETE FROM organization_memberships
     WHERE workos_user_id = $1 AND workos_organization_id = $2 AND workos_membership_id = $3
     RETURNING role`,
    [userId, organizationId, membershipId],
  );
  if (result.rowCount === 1) {
    await client.query(
      `UPDATE users SET primary_organization_id = NULL, updated_at = NOW()
       WHERE workos_user_id = $1 AND primary_organization_id = $2`,
      [userId, organizationId],
    );
  }
  return result.rows[0]?.role ?? null;
}

// ── Invitation seat type ─────────────────────────────────────────────

/**
 * Consume any pending seat_type and provisioning_source staged by the endpoint
 * that triggered the membership creation. Returns both fields when a row is
 * found; null when no staging row exists.
 */
export async function consumeInvitationSeatType(
  organizationId: string,
  email: string,
  externalClient?: PoolClient,
): Promise<{ seat_type: string; source: ProvisioningSource | null } | null> {
  const database = externalClient ?? getPool();

  const result = await database.query<{ seat_type: string; source: string | null }>(
    `DELETE FROM invitation_seat_types
     WHERE workos_organization_id = $1 AND lower(email) = lower($2)
     RETURNING seat_type, source`,
    [organizationId, email],
  );

  if (!result.rows[0]) return null;
  return {
    seat_type: result.rows[0].seat_type,
    source: (result.rows[0].source as ProvisioningSource | null) ?? null,
  };
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
 * Disabled: an email/domain match is neither exact-credential proof nor subject
 * consent. Keep this compatibility entry point inert for background callers.
 * Re-enabling requires an explicit authenticated action and durable audit.
 */
export async function autoLinkByVerifiedDomain(
  _workos: WorkOS,
  _userId: string,
  _email: string,
): Promise<DomainLinkResult | null> {
  return null;
}

// ── Auto-provision digest queries ───────────────────────────────────

/**
 * Row in the auto-provision digest payload — one per newly-auto-joined member
 * since the org's last digest watermark.
 */
export interface NewAutoProvisionedMember {
  workos_user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  seat_type: string;
  joined_at: Date;
}

/**
 * Find orgs that have at least one auto-provisioned member since their last
 * digest watermark. Returns one row per org (with the org's owner emails and
 * the count of new members) so the caller can iterate.
 *
 * Skip personal workspaces and orgs with auto_provision_verified_domain=false
 * (the latter shouldn't have any verified-domain members anyway, but the join
 * makes the intent explicit).
 */
export async function findOrgsWithNewAutoProvisionedMembers(): Promise<
  Array<{
    workos_organization_id: string;
    org_name: string;
    last_sent_at: Date | null;
    new_member_count: number;
  }>
> {
  const pool = getPool();
  const result = await pool.query<{
    workos_organization_id: string;
    org_name: string;
    last_sent_at: Date | null;
    new_member_count: string; // pg COUNT comes back as string
  }>(`
    SELECT
      o.workos_organization_id,
      o.name AS org_name,
      o.last_auto_provision_digest_sent_at AS last_sent_at,
      COUNT(om.workos_user_id) AS new_member_count
    FROM organizations o
    JOIN organization_memberships om
      ON om.workos_organization_id = o.workos_organization_id
    WHERE om.provisioning_source = 'verified_domain'
      AND om.created_at > COALESCE(o.last_auto_provision_digest_sent_at, 'epoch'::timestamptz)
      AND COALESCE(o.is_personal, false) = false
      AND COALESCE(o.auto_provision_verified_domain, true) = true
    GROUP BY o.workos_organization_id, o.name, o.last_auto_provision_digest_sent_at
    HAVING COUNT(om.workos_user_id) > 0
  `);

  return result.rows.map(r => ({
    workos_organization_id: r.workos_organization_id,
    org_name: r.org_name,
    last_sent_at: r.last_sent_at,
    new_member_count: parseInt(r.new_member_count, 10),
  }));
}

/**
 * List the auto-provisioned members added to a given org since the watermark.
 * Used to build the digest body once findOrgsWithNewAutoProvisionedMembers has
 * filtered to orgs with non-zero counts.
 */
export async function listNewAutoProvisionedMembers(
  organizationId: string,
  since: Date | null,
): Promise<NewAutoProvisionedMember[]> {
  const pool = getPool();
  const sinceTs = since ?? new Date(0);
  const result = await pool.query<NewAutoProvisionedMember>(`
    SELECT
      workos_user_id,
      email,
      first_name,
      last_name,
      role,
      seat_type,
      created_at AS joined_at
    FROM organization_memberships
    WHERE workos_organization_id = $1
      AND provisioning_source = 'verified_domain'
      AND created_at > $2
    ORDER BY created_at ASC
  `, [organizationId, sinceTs]);

  return result.rows;
}

/**
 * Mark the digest as sent for an organization. Called after successful delivery
 * so the next run skips the same members.
 */
export async function markAutoProvisionDigestSent(
  organizationId: string,
  sentAt: Date = new Date(),
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE organizations
     SET last_auto_provision_digest_sent_at = $2, updated_at = NOW()
     WHERE workos_organization_id = $1`,
    [organizationId, sentAt],
  );
}
