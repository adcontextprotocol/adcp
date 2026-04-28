/**
 * Database operations for organization memberships.
 *
 * Extracted from the WorkOS webhook handler so the SQL can be exercised
 * by integration tests against a real PostgreSQL instance.
 */

import type { WorkOS } from '@workos-inc/node';
import { getPool, getClient } from './client.js';
import { findPayingOrgForDomain } from './org-filters.js';
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
      provisioning_source,
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
      $8, $10, NOW()
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
      effectiveRole,
      params.seat_type,
      params.has_explicit_seat_type,
      params.provisioning_source ?? null,
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
 *
 * Also clears users.primary_organization_id when it pointed at this org —
 * a stale pointer would let resolvePrimaryOrganization keep returning a
 * removed-org id, which read sites use as an authorization scope. Next
 * read backfills via resolvePreferredOrganization.
 */
export async function deleteOrganizationMembership(
  userId: string,
  organizationId: string,
): Promise<string | null> {
  // Atomic: DELETE membership and clear the cached pointer in one transaction.
  // If the DELETE succeeded but the pointer-clear UPDATE failed, we'd recreate
  // the exact stale-pointer state the integrity invariant exists to catch.
  const client = await getClient();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
    return result.rows[0]?.role ?? null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
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
): Promise<{ seat_type: string; source: ProvisioningSource | null } | null> {
  const pool = getPool();

  const result = await pool.query<{ seat_type: string; source: string | null }>(
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
 * Check whether a user's email domain matches a verified domain on an
 * organization with an active subscription — directly or via the brand
 * registry hierarchy (e.g. AnalyticsIQ → Alliant). If so, and the org has
 * consented to the relevant auto-provisioning class, create a WorkOS
 * membership for them on the resolved paying org.
 *
 * Two consent flags on the resolved org, with different defaults:
 *   - auto_provision_verified_domain (default true) gates DIRECT matches
 *     where the user's domain is a verified organization_domains row
 *     (DNS-verified by WorkOS). Low risk, on by default.
 *   - auto_provision_brand_hierarchy_children (default false) gates
 *     INHERITED matches where the user's domain reaches the org via
 *     brands.house_domain ascent. Higher risk because the edge comes from
 *     LLM classification or admin PATCH, ages on M&A, and the joining user
 *     gets no domain-level confirmation. Opt-in.
 *
 * Idempotent: short-circuits when the user is already in the resolved org's
 * local membership cache, and treats `organization_membership_already_exists`
 * from WorkOS as success. Safe to call on every authenticated request.
 *
 * Hierarchy walk uses the same trust gates as resolveEffectiveMembership
 * (high-confidence classifications, 180-day TTL, max 4 hops up) so pre-link
 * auto-provisioning and post-link inheritance stay coherent.
 */
export async function autoLinkByVerifiedDomain(
  workos: WorkOS,
  userId: string,
  email: string,
): Promise<DomainLinkResult | null> {
  const pool = getPool();
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return null;

  const owner = await findPayingOrgForDomain(emailDomain);
  if (!owner) return null;

  // Direct verified-domain auto-provisioning is on by default; hierarchical
  // is opt-in. The two flags are separate because the trust models differ:
  // direct = WorkOS DNS-verified the user's domain (strong signal); inherited
  // = LLM classifier (or admin PATCH) decided the input domain is a child of
  // the matched parent (weaker, ages on M&A, no domain-level confirmation
  // from the joining user).
  if (owner.is_inherited) {
    if (!owner.auto_provision_hierarchy_allowed) return null;

    // Cohort gate: only auto-join users whose users.created_at is on or
    // after the moment the parent enabled hierarchical auto-provisioning.
    // Without this, flipping the flag retroactively grafts the entire
    // backlog of child-domain users into the parent on their next request.
    // Grandfather semantics matches the SaaS norm.
    if (owner.auto_provision_hierarchy_enabled_at) {
      const userRow = await pool.query<{ created_at: Date | null }>(
        'SELECT created_at FROM users WHERE workos_user_id = $1',
        [userId],
      );
      const userCreatedAt = userRow.rows[0]?.created_at ?? null;
      // No user row yet → just-created via webhook; treat as new joiner.
      // Otherwise require the user's account to post-date the opt-in.
      if (userCreatedAt && userCreatedAt < owner.auto_provision_hierarchy_enabled_at) {
        logger.info(
          {
            userId,
            email,
            orgId: owner.organization_id,
            userCreatedAt,
            hierarchyEnabledAt: owner.auto_provision_hierarchy_enabled_at,
          },
          'Auto-link skipped: user predates hierarchy opt-in (grandfather semantics)',
        );
        return null;
      }
    }
  } else {
    if (!owner.auto_provision_direct_allowed) return null;
  }

  const orgId = owner.organization_id;
  const orgName = owner.organization_name;

  // Already a member of the resolved org? (Post-link, the membership exists
  // on the paying org regardless of which child domain the user matched
  // from.)
  const existing = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM organization_memberships
       WHERE workos_organization_id = $1 AND workos_user_id = $2
     ) AS exists`,
    [orgId, userId],
  );
  if (existing.rows[0]?.exists) return null;

  // Stage the provisioning source so the organization_membership.created
  // webhook handler can record 'verified_domain' on the local cache row.
  // Clear any stale (org, email) staging row first; consumeInvitationSeatType
  // matches by (org, email) and we don't want a leftover row from a prior
  // failed attempt to win.
  const stagingKey = `verified_domain_${orgId}_${userId}`;
  await pool.query(
    'DELETE FROM invitation_seat_types WHERE workos_organization_id = $1 AND lower(email) = lower($2)',
    [orgId, email],
  );
  await pool.query(
    `INSERT INTO invitation_seat_types (workos_invitation_id, workos_organization_id, email, seat_type, source)
     VALUES ($1, $2, $3, 'community_only', 'verified_domain')
     ON CONFLICT (workos_invitation_id) DO UPDATE SET seat_type = EXCLUDED.seat_type, source = EXCLUDED.source`,
    [stagingKey, orgId, email],
  );

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

    logger.info(
      {
        userId,
        email,
        orgId,
        orgName,
        matchedDomain: owner.matched_domain,
        isInherited: owner.is_inherited,
        hierarchyChain: owner.hierarchy_chain,
      },
      owner.is_inherited
        ? 'Auto-linked user to organization via inherited brand-hierarchy domain'
        : 'Auto-linked user to organization via verified domain',
    );
    return { organizationId: orgId, organizationName: orgName, role: 'member' };
  } catch (err: any) {
    if (err?.code === 'organization_membership_already_exists') {
      // Membership exists but wasn't returned by list — return as success
      logger.info({ userId, orgId }, 'Auto-link skipped: membership already exists in WorkOS');
      return { organizationId: orgId, organizationName: orgName, role: 'member' };
    }
    // Roll back the staging row so a stale 'verified_domain' source can't be
    // consumed by an unrelated future invite for the same (org, email) pair.
    try {
      await pool.query(
        'DELETE FROM invitation_seat_types WHERE workos_invitation_id = $1',
        [stagingKey],
      );
    } catch (rollbackErr) {
      logger.error(
        { err: rollbackErr, userId, orgId, email, stagingKey },
        'CRITICAL: failed to rollback verified_domain staging row after createOrganizationMembership failure — manually delete row to avoid source leak',
      );
    }
    logger.warn({ err, userId, orgId }, 'Failed to auto-link user to organization');
    return null;
  }
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
