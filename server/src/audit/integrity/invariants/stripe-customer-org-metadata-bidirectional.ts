/**
 * Invariant: every AAO org's `stripe_customer_id` resolves to a Stripe
 * customer whose `metadata.workos_organization_id` points back at the same
 * org. The bidirectional pointer is what guarantees a Stripe write fires
 * the right downstream AAO state — Triton's incident was the literal
 * symptom of this invariant being silently violated.
 */
import type Stripe from 'stripe';
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';
import { getStripeCustomerCached } from '../stripe-helpers.js';

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
}

export const stripeCustomerOrgMetadataBidirectionalInvariant: Invariant = {
  name: 'stripe-customer-org-metadata-bidirectional',
  description:
    "Every org's stripe_customer_id resolves to a Stripe customer whose " +
    'metadata.workos_organization_id matches the AAO org ID. Without this, a ' +
    'Stripe write (subscription, invoice, charge) attributes to the wrong org ' +
    "downstream — exactly Triton's April 2026 mess in literal form.",
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
          // Treat as orphan — its own invariant handles the "deleted customer
          // still referenced" case; here we only check metadata when present.
          continue;
        }
        const c = customer as Stripe.Customer;
        const stamped = c.metadata?.workos_organization_id;

        if (!stamped) {
          violations.push({
            invariant: 'stripe-customer-org-metadata-bidirectional',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message: `Stripe customer ${c.id} has no workos_organization_id metadata stamped`,
            details: {
              org_name: org.name,
              stripe_customer_id: c.id,
              stripe_customer_email: c.email,
            },
            remediation_hint:
              'Update the Stripe customer metadata to include workos_organization_id, or unlink the org from this customer if it was created in error.',
          });
          continue;
        }

        if (stamped !== org.workos_organization_id) {
          violations.push({
            invariant: 'stripe-customer-org-metadata-bidirectional',
            severity: 'critical',
            subject_type: 'organization',
            subject_id: org.workos_organization_id,
            message:
              `Stripe customer ${c.id} is metadata-attributed to ${stamped} ` +
              `but is referenced by org ${org.workos_organization_id}`,
            details: {
              org_name: org.name,
              stripe_customer_id: c.id,
              stripe_customer_email: c.email,
              metadata_workos_organization_id: stamped,
            },
            remediation_hint:
              `Either fix the Stripe customer metadata to point at ${org.workos_organization_id}, ` +
              `or set this org's stripe_customer_id to null and re-link to the correct customer.`,
          });
        }
      } catch (err) {
        logger.warn(
          { err, orgId: org.workos_organization_id, customerId: org.stripe_customer_id },
          'stripe-customer-org-metadata-bidirectional: Stripe lookup failed; recording transient violation',
        );
        violations.push({
          invariant: 'stripe-customer-org-metadata-bidirectional',
          severity: 'warning',
          subject_type: 'organization',
          subject_id: org.workos_organization_id,
          message: `Could not retrieve Stripe customer ${org.stripe_customer_id}: ${err instanceof Error ? err.message : String(err)}`,
          details: { org_name: org.name, stripe_customer_id: org.stripe_customer_id },
        });
      }
    }

    return { checked: result.rows.length, violations };
  },
};
