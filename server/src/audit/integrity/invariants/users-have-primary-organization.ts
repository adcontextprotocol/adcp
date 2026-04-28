/**
 * Invariant: every user with at least one organization_memberships row in a
 * non-personal org has users.primary_organization_id set.
 *
 * A NULL pointer silently breaks every read site that queries the column
 * directly without falling back to organization_memberships. This caused
 * paid Founding members to see "no directory listing" / "not a member" on
 * the member-profile page and Addie tools in April 2026.
 *
 * Drift sources:
 *   - user.created vs organization_membership.created webhook-order race
 *     (membership webhook's backfill UPDATE no-ops if the users row doesn't
 *     exist yet)
 *   - fire-and-forget backfill failures in enrichUserWithMembership
 *   - direct DB inserts that bypass the webhook handlers
 *
 * The remediation hint maps to the centralized helper that does the right
 * read-with-fallback in production: users-db.ts:resolvePrimaryOrganization.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

const DEFAULT_LIMIT = 1000;

interface MismatchRow {
  workos_user_id: string;
  email: string;
  inferred_org_id: string;
  inferred_org_name: string;
}

export const usersHavePrimaryOrganizationInvariant: Invariant = {
  name: 'users-have-primary-organization',
  description:
    'Every user with at least one organization_memberships row in a non-personal ' +
    'org has users.primary_organization_id set. Catches webhook-order races and ' +
    'silent backfill failures that break read sites which do not fall back from ' +
    'the column to organization_memberships.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, options } = ctx;
    const limit = Math.min(options?.sampleSize ?? DEFAULT_LIMIT, 5000);
    const violations: Violation[] = [];

    const result = await pool.query<MismatchRow>(`
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

    for (const row of result.rows) {
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

    return { checked: result.rows.length, violations };
  },
};
