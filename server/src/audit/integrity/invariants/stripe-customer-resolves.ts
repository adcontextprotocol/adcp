/**
 * Invariant: every AAO `organizations.stripe_customer_id` resolves to a
 * non-deleted Stripe customer. Catches the "Stripe customer was hand-deleted
 * via dashboard but the FK on the org row is still set" case, which would
 * otherwise produce silent webhook drops on the next subscription event.
 */
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';
import { getStripeCustomerCached, isStripeNotFound } from '../stripe-helpers.js';

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
}

export const stripeCustomerResolvesInvariant: Invariant = {
  name: 'stripe-customer-resolves',
  description:
    'Every org.stripe_customer_id resolves to a Stripe customer that is not ' +
    'marked deleted. A dangling reference produces silent webhook drops on the ' +
    'next subscription event for that customer.',
  severity: 'critical',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, logger } = ctx;
    const violations: Violation[] = [];

    const result = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name, stripe_customer_id
         FROM organizations
        WHERE stripe_customer_id IS NOT NULL`,
    );

    for (const org of result.rows) {
      try {
        const customer = await getStripeCustomerCached(ctx, org.stripe_customer_id);
        if ('deleted' in customer && customer.deleted) {
          violations.push({
            invariant: 'stripe-customer-resolves',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Org references deleted Stripe customer ${org.stripe_customer_id}`,
            details: {
              org_name: org.name,
              stripe_customer_id: org.stripe_customer_id,
            },
            remediation_hint:
              'Either restore the customer in Stripe or null out the org\'s stripe_customer_id ' +
              '(after confirming no in-flight payments depend on it).',
          });
        }
      } catch (err) {
        // Stripe SDK throws on 404. We treat that as "doesn't exist" — same
        // as deleted from our perspective.
        if (isStripeNotFound(err)) {
          violations.push({
            invariant: 'stripe-customer-resolves',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Org references non-existent Stripe customer ${org.stripe_customer_id}`,
            details: {
              org_name: org.name,
              stripe_customer_id: org.stripe_customer_id,
            },
            remediation_hint:
              'Null out the org\'s stripe_customer_id and re-link to a valid customer if one exists.',
          });
        } else {
          logger.warn(
            { err, orgId: org.workos_organization_id, customerId: org.stripe_customer_id },
            'stripe-customer-resolves: transient Stripe lookup error',
          );
          violations.push({
            invariant: 'stripe-customer-resolves',
            severity: 'warning',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Could not retrieve Stripe customer ${org.stripe_customer_id}: ${err instanceof Error ? err.message : String(err)}`,
            details: { org_name: org.name, stripe_customer_id: org.stripe_customer_id },
          });
        }
      }
    }

    return { checked: result.rows.length, violations };
  },
};
