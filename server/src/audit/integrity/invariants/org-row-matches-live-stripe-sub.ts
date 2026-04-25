/**
 * Invariant: when an AAO org row points to a live Stripe subscription, the
 * row's mirrored fields (subscription_amount, subscription_price_lookup_key,
 * subscription_status) match what Stripe currently reports. Catches drift
 * from missed webhooks or manual Stripe-dashboard edits.
 *
 * Severity is `warning`, not `critical`: tier mismatch could be transient
 * (webhook in flight) and we don't want to page on every brief skew.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';
import { isStripeNotFound } from '../stripe-helpers.js';

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_subscription_id: string;
  subscription_status: string | null;
  subscription_amount: number | null;
  subscription_price_lookup_key: string | null;
}

export const orgRowMatchesLiveStripeSubInvariant: Invariant = {
  name: 'org-row-matches-live-stripe-sub',
  description:
    'When an org has a stripe_subscription_id and a live (active/trialing/past_due) ' +
    'subscription_status, the row\'s mirrored fields (amount, lookup_key, status) ' +
    'match what Stripe reports for that subscription. Catches webhook-miss drift.',
  severity: 'warning',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, stripe, logger } = ctx;
    const violations: Violation[] = [];

    const result = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name, stripe_subscription_id,
              subscription_status, subscription_amount, subscription_price_lookup_key
         FROM organizations
        WHERE stripe_subscription_id IS NOT NULL
          AND subscription_status = ANY($1::text[])`,
      [Array.from(LIVE_STATUSES)],
    );

    for (const org of result.rows) {
      try {
        const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
        const price = sub.items.data[0]?.price;
        const stripeAmount = price?.unit_amount ?? null;
        const stripeLookupKey = price?.lookup_key ?? null;
        const stripeStatus = sub.status;

        const mismatches: Record<string, { row: unknown; stripe: unknown }> = {};

        if (org.subscription_status !== stripeStatus) {
          mismatches.status = { row: org.subscription_status, stripe: stripeStatus };
        }
        if (org.subscription_amount !== stripeAmount) {
          mismatches.amount = { row: org.subscription_amount, stripe: stripeAmount };
        }
        if (org.subscription_price_lookup_key !== stripeLookupKey) {
          mismatches.lookup_key = {
            row: org.subscription_price_lookup_key,
            stripe: stripeLookupKey,
          };
        }

        if (Object.keys(mismatches).length === 0) continue;

        violations.push({
          invariant: 'org-row-matches-live-stripe-sub',
          severity: 'warning',
          subject_type: 'organization',
          subject_id: org.workos_organization_id,
          message:
            `Org row drifts from Stripe subscription ${sub.id}: ` +
            Object.entries(mismatches)
              .map(([k, v]) => `${k} (row=${JSON.stringify(v.row)}, stripe=${JSON.stringify(v.stripe)})`)
              .join('; '),
          details: {
            org_name: org.name,
            stripe_subscription_id: sub.id,
            mismatches,
          },
          remediation_hint:
            'Run POST /api/admin/accounts/:orgId/sync to re-pull subscription state from Stripe, ' +
            'or replay the most recent customer.subscription.updated webhook for this customer.',
        });
      } catch (err) {
        if (isStripeNotFound(err)) {
          violations.push({
            invariant: 'org-row-matches-live-stripe-sub',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Org references non-existent Stripe subscription ${org.stripe_subscription_id}`,
            details: {
              org_name: org.name,
              stripe_subscription_id: org.stripe_subscription_id,
            },
            remediation_hint:
              'The subscription was deleted in Stripe but the org row still references it. ' +
              'Null out stripe_subscription_id and re-derive subscription state from current Stripe data.',
          });
        } else {
          logger.warn(
            { err, orgId: org.workos_organization_id, subId: org.stripe_subscription_id },
            'org-row-matches-live-stripe-sub: transient Stripe error',
          );
          violations.push({
            invariant: 'org-row-matches-live-stripe-sub',
            severity: 'warning',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Could not retrieve Stripe subscription ${org.stripe_subscription_id}: ${err instanceof Error ? err.message : String(err)}`,
            details: { org_name: org.name, stripe_subscription_id: org.stripe_subscription_id },
          });
        }
      }
    }

    return { checked: result.rows.length, violations };
  },
};
