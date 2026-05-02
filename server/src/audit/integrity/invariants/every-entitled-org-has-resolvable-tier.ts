/**
 * Invariant: every org with an entitled subscription_status must produce a
 * non-null tier from `resolveMembershipTier()`. This is a backstop on the
 * function the dashboard and Addie's prompt rules actually consume — if it
 * returns null for a paying member, the UI silently falls through to the
 * Explorer / `individual_academic` upsell path and prompts them to upgrade
 * to Professional.
 *
 * Motivating incident — Adzymic / Travis Teo (May 2026): founding-member
 * org row had `subscription_status='active'` but NULL `subscription_price_lookup_key`
 * and NULL `subscription_amount`. The Stripe-side invariants didn't fire
 * (sub_id was NULL, so the row was filtered out of `org-row-matches-live-stripe-sub`;
 * the `stripe-sub-reflected-in-org-row` healthy predicate treated active
 * status as "reflected"). The tier resolver returned null. The dashboard
 * rendered "Explorer" and "Upgrade to Professional — $250/yr" to a paying
 * corporate member.
 *
 * This invariant tests the resolver directly, so it doesn't care *why* the
 * row is unresolvable (NULL columns today, future schema drift tomorrow).
 * If a future change leaves a class of entitled orgs unresolvable, this
 * fires before any UI code makes a member-facing mistake.
 *
 * Severity: critical. Member-visible misclassification is at least as bad
 * as denied entitlement — it actively insults paying customers.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';
import {
  resolveMembershipTier,
  MEMBERSHIP_TIER_COLUMNS,
  type MembershipTierRow,
} from '../../../db/organization-db.js';

const ENTITLED_STATUSES = new Set<string>(['active', 'trialing', 'past_due']);

interface OrgRow extends MembershipTierRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

export const everyEntitledOrgHasResolvableTierInvariant: Invariant = {
  name: 'every-entitled-org-has-resolvable-tier',
  description:
    'Every org with an entitled subscription_status (active, trialing, past_due) must produce a non-null membership tier from resolveMembershipTier(). Tests the function the dashboard and Addie consume, so it catches partial-truth rows the Stripe-side invariants miss — most notably founding-era orgs with status=active but NULL lookup_key/amount, which the dashboard misrenders as Explorer.',
  severity: 'critical',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool } = ctx;
    const violations: Violation[] = [];

    const result = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name, stripe_customer_id, stripe_subscription_id,
              ${MEMBERSHIP_TIER_COLUMNS.join(', ')}
         FROM organizations
        WHERE subscription_status = ANY($1::text[])`,
      [Array.from(ENTITLED_STATUSES)],
    );

    for (const org of result.rows) {
      const tier = resolveMembershipTier(org);
      if (tier !== null) continue;

      violations.push({
        invariant: 'every-entitled-org-has-resolvable-tier',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: org.workos_organization_id,
        message:
          `Org "${org.name}" has subscription_status=${JSON.stringify(org.subscription_status)} ` +
          `but resolveMembershipTier() returned null. Dashboard renders a neutral ` +
          `"tier pending sync" state instead of the actual tier; Addie's prompt ` +
          `rules treat the org as untiered.`,
        details: {
          org_name: org.name,
          stripe_customer_id: org.stripe_customer_id,
          stripe_subscription_id: org.stripe_subscription_id,
          subscription_status: org.subscription_status,
          subscription_price_lookup_key: org.subscription_price_lookup_key,
          subscription_amount: org.subscription_amount,
          subscription_interval: org.subscription_interval,
          membership_tier_column: org.membership_tier,
          is_personal: org.is_personal,
        },
        remediation_hint:
          `POST /api/admin/accounts/${org.workos_organization_id}/sync to re-pull Stripe state ` +
          `and populate subscription_price_lookup_key. If the row has no Stripe subscription ` +
          `(legacy founding deal), set membership_tier directly via admin tooling.`,
      });
    }

    return { checked: result.rows.length, violations };
  },
};
