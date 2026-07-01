/**
 * Invariant: at most one non-personal organization row per email_domain.
 *
 * The April 2026 prospect-import re-ran without dedup, creating a second
 * org row for ~60 companies that already had one from the December 2025
 * import. Most pairs are stub-vs-stub (both `prospect`, 0 members,
 * harmless clutter) but the mixed shape — empty April stub vs. real
 * December row with members + Stripe customer + brand-domain mapping —
 * actively breaks admin search and confuses brand-domain lookups.
 *
 * Severity: `warning`. The duplicate doesn't deny entitlement (real
 * members are on the populated row) but admins repeatedly land on the
 * stub when searching, and any future automation that joins on
 * email_domain will pick non-deterministically.
 *
 * Fix: keep the row with the higher signal score (member_count, Stripe
 * link, brand-mapping); delete the empty stub. Done out-of-band; this
 * invariant only flags so admins can act.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

interface DuplicateGroup {
  email_domain: string;
  rows: Array<{
    workos_organization_id: string;
    name: string;
    created_at: string;
    member_count: number;
    has_stripe_customer: boolean;
    has_active_subscription: boolean;
    member_status: string | null;
  }>;
}

interface DuplicateRow {
  email_domain: string;
  workos_organization_id: string;
  name: string;
  created_at: string;
  member_count: number;
  has_stripe_customer: boolean;
  has_active_subscription: boolean;
  member_status: string | null;
}

/**
 * Score a duplicate-group member to identify which one to keep. Higher
 * is better. Ties break in favour of the older row (assumed canonical).
 *   active sub        +1000
 *   Stripe customer   +100
 *   member_count      +10 per member
 *   member_status='member'  +5
 *
 * The score is informational — admins decide which to keep — but having
 * a deterministic ranking lets the violation message recommend a winner.
 */
function score(row: DuplicateGroup['rows'][number]): number {
  let s = 0;
  if (row.has_active_subscription) s += 1000;
  if (row.has_stripe_customer) s += 100;
  s += row.member_count * 10;
  if (row.member_status === 'member') s += 5;
  return s;
}

export const uniqueOrgPerEmailDomainInvariant: Invariant = {
  name: 'unique-org-per-email-domain',
  description:
    'At most one non-personal organization row per email_domain. Catches duplicate prospect rows from re-running an import script without dedup (April 2026), which clutter admin search and break domain-keyed automation. Severity warning: real members and Stripe links sit on one row, the duplicate is empty.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool } = ctx;
    const violations: Violation[] = [];

    // One row per duplicate-org per group, with enough metadata to
    // pick the keeper. Personal workspaces are excluded — they share
    // an email_domain by construction (the user's personal email)
    // and aren't part of the company-import flow.
    const result = await pool.query<DuplicateRow>(`
      WITH dupes AS (
        SELECT email_domain
        FROM organizations
        WHERE email_domain IS NOT NULL
          AND email_domain <> ''
          AND COALESCE(is_personal, false) = false
        GROUP BY email_domain
        HAVING COUNT(*) > 1
      )
      SELECT
        o.email_domain,
        o.workos_organization_id,
        o.name,
        o.created_at::text AS created_at,
        (
          SELECT COUNT(*)::int
          FROM organization_memberships om
          WHERE om.workos_organization_id = o.workos_organization_id
        ) AS member_count,
        (o.stripe_customer_id IS NOT NULL) AS has_stripe_customer,
        (o.subscription_status IN ('active', 'trialing', 'past_due')) AS has_active_subscription,
        CASE
          WHEN o.subscription_status IN ('active', 'trialing', 'past_due') THEN 'member'
          WHEN o.subscription_status = 'canceled' THEN 'churned'
          ELSE 'prospect'
        END AS member_status
      FROM organizations o
      JOIN dupes d ON d.email_domain = o.email_domain
      WHERE COALESCE(o.is_personal, false) = false
      ORDER BY o.email_domain, o.created_at ASC
    `);

    // Group by email_domain.
    const groups = new Map<string, DuplicateGroup>();
    for (const row of result.rows) {
      let group = groups.get(row.email_domain);
      if (!group) {
        group = { email_domain: row.email_domain, rows: [] };
        groups.set(row.email_domain, group);
      }
      group.rows.push({
        workos_organization_id: row.workos_organization_id,
        name: row.name,
        created_at: row.created_at,
        member_count: row.member_count,
        has_stripe_customer: row.has_stripe_customer,
        has_active_subscription: row.has_active_subscription,
        member_status: row.member_status,
      });
    }

    for (const group of groups.values()) {
      // Pick keeper: highest score, then oldest. Tie-break on created_at
      // ascending mirrors the ORDER BY above so the choice is stable
      // across runs even when scores are equal.
      const ranked = [...group.rows].sort((a, b) => {
        const sd = score(b) - score(a);
        if (sd !== 0) return sd;
        return a.created_at < b.created_at ? -1 : 1;
      });
      const keeper = ranked[0];
      const dupes = ranked.slice(1);

      // Emit one violation per duplicate (not per group) so each row has
      // its own remediation entry in the report. Subject_id is the
      // duplicate's org id — the row that should be deleted/merged into
      // `keeper`.
      for (const dup of dupes) {
        violations.push({
          invariant: 'unique-org-per-email-domain',
          severity: 'warning',
          subject_type: 'organization',
          subject_id: dup.workos_organization_id,
          message:
            `Duplicate org for email_domain "${group.email_domain}": ` +
            `"${dup.name}" (${dup.workos_organization_id}, ${dup.member_count} members, ` +
            `${dup.has_stripe_customer ? 'has' : 'no'} Stripe customer) is a duplicate of ` +
            `"${keeper.name}" (${keeper.workos_organization_id}, ${keeper.member_count} members, ` +
            `${keeper.has_stripe_customer ? 'has' : 'no'} Stripe customer). Keep the latter; delete or merge this one.`,
          details: {
            email_domain: group.email_domain,
            duplicate: dup,
            keeper: {
              workos_organization_id: keeper.workos_organization_id,
              name: keeper.name,
              member_count: keeper.member_count,
              has_stripe_customer: keeper.has_stripe_customer,
              has_active_subscription: keeper.has_active_subscription,
            },
          },
          remediation_hint:
            // The merge endpoint (POST /api/admin/accounts/:source/merge-into/:target)
            // moves memberships and stripe state to `keeper`, then deletes the
            // empty row. Use that for stub-vs-real cases. For stub-vs-stub,
            // direct DELETE is fine after confirming both rows are empty.
            `If duplicate has 0 members AND no Stripe customer, DELETE FROM organizations ` +
            `WHERE workos_organization_id = '${dup.workos_organization_id}'. Otherwise use ` +
            `POST /api/admin/accounts/${dup.workos_organization_id}/merge-into/${keeper.workos_organization_id} ` +
            `(if implemented) to consolidate.`,
        });
      }
    }

    return { checked: result.rows.length, violations };
  },
};
