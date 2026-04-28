/**
 * Invariant: users.primary_organization_id is coherent with the user's
 * organization_memberships. Two failure modes:
 *
 *   1. Missing pointer — user has memberships but column is NULL.
 *      Caused by user.created vs organization_membership.created webhook-order
 *      races, fire-and-forget backfill failures, or direct DB inserts.
 *      Read sites that gate on the column treat the user as having no org.
 *
 *   2. Stale pointer — column points at an org the user no longer belongs to.
 *      Caused by missed delete webhooks (or pre-fix delete handlers that
 *      didn't clear the column). Read sites continue resolving the user into
 *      an org they were removed from — the same authorization-scope risk in
 *      reverse.
 *
 * Production fix lives in users-db.ts:resolvePrimaryOrganization (read-with-
 * fallback) and membership-db.ts:deleteOrganizationMembership (clears the
 * pointer in the same step as the membership delete).
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

const DEFAULT_LIMIT = 1000;

interface MissingPointerRow {
  workos_user_id: string;
  email: string;
  inferred_org_id: string;
  inferred_org_name: string;
}

interface StalePointerRow {
  workos_user_id: string;
  email: string;
  stale_org_id: string;
}

export const usersHavePrimaryOrganizationInvariant: Invariant = {
  name: 'users-have-primary-organization',
  description:
    'users.primary_organization_id is coherent with organization_memberships. ' +
    'Catches both missing pointers (column NULL despite memberships) and stale ' +
    'pointers (column set to an org the user no longer belongs to). Either drift ' +
    'silently broadens or narrows the read sites that gate on the column.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, options } = ctx;
    const limit = Math.min(options?.sampleSize ?? DEFAULT_LIMIT, 5000);
    const violations: Violation[] = [];

    // Failure mode 1: column NULL but memberships exist.
    const missing = await pool.query<MissingPointerRow>(`
      SELECT DISTINCT ON (u.workos_user_id)
        u.workos_user_id,
        u.email,
        om.workos_organization_id AS inferred_org_id,
        o.name AS inferred_org_name
      FROM users u
      JOIN organization_memberships om ON om.workos_user_id = u.workos_user_id
      JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
      WHERE u.primary_organization_id IS NULL
        AND COALESCE(o.is_personal, false) = false
      ORDER BY
        u.workos_user_id,
        CASE WHEN o.subscription_status = 'active' THEN 0 ELSE 1 END,
        om.created_at DESC
      LIMIT $1
    `, [limit]);

    for (const row of missing.rows) {
      violations.push({
        invariant: 'users-have-primary-organization',
        severity: 'warning',
        subject_type: 'user',
        subject_id: row.workos_user_id,
        message:
          `User ${row.workos_user_id} (${row.email}) has organization_memberships but ` +
          `users.primary_organization_id is NULL. Read sites that gate on the column ` +
          `(Addie member tools, brand-feeds, referrals, brand-claim, registry-api) ` +
          `silently treat this user as having no organization.`,
        details: {
          drift: 'missing_pointer',
          workos_user_id: row.workos_user_id,
          email: row.email,
          inferred_org_id: row.inferred_org_id,
          inferred_org_name: row.inferred_org_name,
        },
        remediation_hint:
          'Set users.primary_organization_id to inferred_org_id, or have the user ' +
          'load any authenticated page (which calls resolvePrimaryOrganization and ' +
          'opportunistically backfills the column).',
      });
    }

    // Failure mode 2: column points at an org with no current membership row.
    const stale = await pool.query<StalePointerRow>(`
      SELECT u.workos_user_id, u.email, u.primary_organization_id AS stale_org_id
      FROM users u
      LEFT JOIN organization_memberships om
        ON om.workos_user_id = u.workos_user_id
       AND om.workos_organization_id = u.primary_organization_id
      WHERE u.primary_organization_id IS NOT NULL
        AND om.workos_user_id IS NULL
      LIMIT $1
    `, [limit]);

    for (const row of stale.rows) {
      violations.push({
        invariant: 'users-have-primary-organization',
        severity: 'warning',
        subject_type: 'user',
        subject_id: row.workos_user_id,
        message:
          `User ${row.workos_user_id} (${row.email}) has primary_organization_id = ` +
          `${row.stale_org_id} but no organization_memberships row for that org. ` +
          `Read sites continue resolving the user into the removed org.`,
        details: {
          drift: 'stale_pointer',
          workos_user_id: row.workos_user_id,
          email: row.email,
          stale_org_id: row.stale_org_id,
        },
        remediation_hint:
          'Clear the column (UPDATE users SET primary_organization_id = NULL ...) ' +
          'and let resolvePrimaryOrganization re-derive from organization_memberships ' +
          'on the next request.',
      });
    }

    return { checked: missing.rows.length + stale.rows.length, violations };
  },
};
