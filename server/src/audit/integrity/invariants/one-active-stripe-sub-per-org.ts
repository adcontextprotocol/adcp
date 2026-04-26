/**
 * Invariant: no org has more than one live Stripe subscription on its
 * Stripe customer. "Live" here means active, trialing, or past_due —
 * the same set blockIfActiveSubscription refuses to mint over (#3171).
 *
 * Triton had two simultaneous active subscriptions ($10K Corporate +
 * duplicate $3K Builder) for ~5 months before anyone noticed. This is
 * the invariant that would have surfaced it.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';

const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
}

export const oneActiveStripeSubPerOrgInvariant: Invariant = {
  name: 'one-active-stripe-sub-per-org',
  description:
    'For every org with a Stripe customer, the customer has at most one live ' +
    '(active/trialing/past_due) subscription. Two live subs on the same ' +
    'customer is the literal failure mode of the Triton/Encypher incident.',
  severity: 'critical',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, stripe, logger } = ctx;
    const violations: Violation[] = [];

    const result = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name, stripe_customer_id
         FROM organizations
        WHERE stripe_customer_id IS NOT NULL`,
    );

    for (const org of result.rows) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: org.stripe_customer_id,
          status: 'all',
          limit: 20,
        });
        const live = subs.data.filter((s) => LIVE_STATUSES.has(s.status));
        if (live.length <= 1) continue;

        violations.push({
          invariant: 'one-active-stripe-sub-per-org',
          severity: 'critical',
          subject_type: 'organization',
          subject_id: org.workos_organization_id,
          message:
            `Stripe customer ${org.stripe_customer_id} has ${live.length} live subscriptions ` +
            `(expected ≤ 1)`,
          details: {
            org_name: org.name,
            stripe_customer_id: org.stripe_customer_id,
            subscriptions: live.map((s) => ({
              id: s.id,
              status: s.status,
              lookup_key: s.items.data[0]?.price?.lookup_key ?? null,
              unit_amount: s.items.data[0]?.price?.unit_amount ?? null,
              created: s.created,
            })),
          },
          remediation_hint:
            'Identify the duplicate (usually the most recently created or the one with a voided invoice), ' +
            'cancel it via Stripe API or dashboard, and re-sync the org row from the surviving subscription.',
        });
      } catch (err) {
        logger.warn(
          { err, orgId: org.workos_organization_id, customerId: org.stripe_customer_id },
          'one-active-stripe-sub-per-org: subscriptions.list failed; recording transient violation',
        );
        violations.push({
          invariant: 'one-active-stripe-sub-per-org',
          severity: 'warning',
          subject_type: 'organization',
          subject_id: org.workos_organization_id,
          message: `Could not list Stripe subscriptions for ${org.stripe_customer_id}: ${err instanceof Error ? err.message : String(err)}`,
          details: { org_name: org.name, stripe_customer_id: org.stripe_customer_id },
        });
      }
    }

    return { checked: result.rows.length, violations };
  },
};
