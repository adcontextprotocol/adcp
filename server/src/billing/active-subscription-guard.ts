/**
 * Refuse to mint a new Stripe subscription/invoice when one is already active
 * on the org.
 *
 * Three routes can issue billing on an org's behalf
 * (`POST /api/checkout-session`, `POST /api/invoice-request`,
 * `POST /api/invite/:token/accept`). None of them used to check whether the
 * org already had an active subscription before minting a new one — which is
 * how Triton ended up with two simultaneous active subs (a $10K Corporate
 * paid in Dec 2025 plus a duplicate $3K Builder created Apr 2026 with a
 * voided invoice). Tier upgrades belong in the Stripe Customer Portal, not
 * these intake routes.
 */

import { OrganizationDatabase } from '../db/organization-db.js';
import { createCustomerPortalSession } from './stripe-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('active-subscription-guard');

export interface ActiveSubscriptionBlock {
  status: 409;
  body: {
    error: 'Active subscription exists';
    message: string;
    existing_subscription: {
      status: string;
      product_name?: string;
      amount_cents?: number;
    };
    customer_portal_url?: string;
  };
}

/**
 * Set of subscription statuses where minting another subscription would
 * duplicate live state. `past_due` is included because creating a second sub
 * on a customer with a past_due one stacks two unresolved invoices instead of
 * letting the user fix payment on the existing one. `canceled`, `unpaid`, and
 * `incomplete_expired` are *not* included — those are recoverable by
 * re-subscribing.
 */
const BLOCKING_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Returns a 409 payload if the org already has a live subscription,
 * otherwise null. Caller short-circuits with
 * `res.status(409).json(block.body)` when this returns a value.
 *
 * @param orgId    workos_organization_id of the org being billed
 * @param orgDb    OrganizationDatabase instance (DI for testing)
 * @param returnUrl Where to send the user back to from the Stripe Customer Portal
 */
export async function blockIfActiveSubscription(
  orgId: string,
  orgDb: OrganizationDatabase,
  returnUrl: string,
): Promise<ActiveSubscriptionBlock | null> {
  const info = await orgDb.getSubscriptionInfo(orgId);
  if (!info || !BLOCKING_STATUSES.has(info.status)) {
    return null;
  }

  const org = await orgDb.getOrganization(orgId);
  let portalUrl: string | undefined;
  if (org?.stripe_customer_id) {
    try {
      portalUrl = (await createCustomerPortalSession(org.stripe_customer_id, returnUrl)) || undefined;
    } catch (err) {
      logger.warn({ err, orgId }, 'Failed to create customer portal session for active-sub block');
    }
  }

  const productName = info.product_name || `${info.lookup_key ?? 'membership'}`;
  const amountDisplay = info.amount_cents
    ? `$${(info.amount_cents / 100).toLocaleString()}`
    : 'an active tier';

  return {
    status: 409,
    body: {
      error: 'Active subscription exists',
      message: `This organization is already on ${productName} (${amountDisplay}). To change tiers, cancel, or update payment method, use the Stripe Customer Portal.`,
      existing_subscription: {
        status: info.status,
        product_name: info.product_name,
        amount_cents: info.amount_cents,
      },
      ...(portalUrl ? { customer_portal_url: portalUrl } : {}),
    },
  };
}
