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

import { OrganizationDatabase, TIER_PRESERVING_STATUSES } from '../db/organization-db.js';
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
 * Statuses where another paid subscription would duplicate live state.
 * Reuses `TIER_PRESERVING_STATUSES` from organization-db.ts — same set
 * (active, past_due, trialing), same intent (a paid relationship exists).
 * `canceled`, `unpaid`, and `incomplete_expired` are recoverable by
 * re-subscribing and intentionally pass through.
 */
const BLOCKING_STATUSES: ReadonlySet<string> = new Set(TIER_PRESERVING_STATUSES);

function formatAmount(cents: number): string {
  // Render as fixed 2-decimal currency; otherwise $250.50 displays as "$250.5".
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface BlockOptions {
  /**
   * Where to redirect the user after they finish in the Stripe Customer
   * Portal. Pass undefined to suppress the portal URL entirely — required on
   * the invite-acceptance path, where the requester has only `member` role
   * on the org and a portal session would grant `admin`-equivalent control
   * over the org's subscription, payment method, and cancellation.
   */
  customerPortalReturnUrl?: string;
}

/**
 * Returns a 409 payload if the org already has a live subscription,
 * otherwise null. Caller short-circuits with
 * `res.status(409).json(block.body)` when this returns a value.
 *
 * @param orgId    workos_organization_id of the org being billed
 * @param orgDb    OrganizationDatabase instance (DI for testing)
 * @param options.customerPortalReturnUrl  When provided, the 409 includes a
 *   single-use Stripe Customer Portal URL the requester can follow to
 *   manage the existing subscription. Omit on routes where the requester
 *   does not have admin authority over the org (e.g., invite acceptance
 *   for a not-yet-member or a `member`-role user).
 */
export async function blockIfActiveSubscription(
  orgId: string,
  orgDb: OrganizationDatabase,
  options: BlockOptions = {},
): Promise<ActiveSubscriptionBlock | null> {
  const info = await orgDb.getSubscriptionInfo(orgId);
  if (!info || !BLOCKING_STATUSES.has(info.status)) {
    return null;
  }

  let portalUrl: string | undefined;
  if (options.customerPortalReturnUrl) {
    const org = await orgDb.getOrganization(orgId);
    if (org?.stripe_customer_id) {
      try {
        portalUrl = (await createCustomerPortalSession(
          org.stripe_customer_id,
          options.customerPortalReturnUrl,
        )) || undefined;
      } catch (err) {
        logger.warn({ err, orgId }, 'Failed to create customer portal session for active-sub block');
      }
    }
  }

  const productName = info.product_name || info.lookup_key || 'membership';
  const amountDisplay = info.amount_cents != null ? formatAmount(info.amount_cents) : 'an active tier';

  const remediation = portalUrl
    ? 'To change tiers, cancel, or update payment method, use the Stripe Customer Portal.'
    : 'To change tiers, cancel, or update payment method, contact finance@agenticadvertising.org or sign in to the dashboard at https://agenticadvertising.org/dashboard/membership.';

  return {
    status: 409,
    body: {
      error: 'Active subscription exists',
      message: `This organization is already on ${productName} (${amountDisplay}). ${remediation}`,
      existing_subscription: {
        status: info.status,
        product_name: info.product_name,
        amount_cents: info.amount_cents,
      },
      ...(portalUrl ? { customer_portal_url: portalUrl } : {}),
    },
  };
}
