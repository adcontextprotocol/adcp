/**
 * Lazy reconciliation: when a paywall gate is about to deny a request from
 * an org that has a `stripe_customer_id` but stale or incomplete subscription
 * state, pull fresh state from Stripe and self-heal the org row before the deny
 * fires.
 *
 * Catches a real drift class observed in production: a Stripe customer can
 * be re-linked between orgs (admin audit, support fix-up) without the
 * subscription state being transferred to the new org's row. The webhook
 * fired correctly against the old org; the new org's row is silently null
 * even though the customer holds an active membership sub. Lazy
 * reconciliation surfaces those cases at the moment of customer impact —
 * the user clicking on a paid feature is the trigger — so the customer
 * never sees the drift.
 *
 * Deliberate scope:
 *  - Only writes billing-derived subscription_* columns and membership_tier.
 *  - Does NOT write `agreement_signed_at`, `user_agreement_acceptances`,
 *    or `org_activities` rows. The webhook handler (handle-subscription-created)
 *    is the canonical place for those side effects, and it's keyed off
 *    `pending_agreement_user_id` set at checkbox-click time. A user clicking
 *    a paywall is action-signal but not a fresh consent event.
 *  - Uses a lossless `updated_at` token to avoid overwriting a webhook update
 *    that lands between the read and repair write.
 *  - Requires the Stripe customer's organization metadata to match exactly,
 *    so a stale customer link cannot transfer entitlement across orgs.
 *  - Safe to call on every paywall hit; only does Stripe work when the org
 *    actually looks drifted.
 */
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import {
  buildSubscriptionUpdate,
  resolveMembershipTierForSubscriptionWrite,
} from '../db/organization-db.js';
import { invalidateMembershipCache } from '../db/org-filters.js';
import { pickMembershipSubWithProductFetch } from './membership-prices.js';

/**
 * Stripe statuses that grant entitlement at AAO. Mirrors the gate logic
 * in `org-filters.ts:resolveEffectiveMembership` and the integrity
 * invariant. `past_due` keeps access during dunning.
 */
const ENTITLED_STATUSES = new Set<string>(['active', 'trialing', 'past_due']);

export type LazyReconcileResult =
  | { healed: true; reason: 'healed_from_stripe'; subscriptionStatus: string }
  | { healed: false; reason: LazyReconcileSkipReason };

export type LazyReconcileSkipReason =
  | 'org_not_found'
  | 'already_entitled'
  | 'no_stripe_customer'
  | 'stripe_error'
  | 'customer_deleted'
  | 'customer_org_mismatch'
  | 'no_membership_sub'
  | 'sub_not_entitled';

interface OrgRow {
  workos_organization_id: string;
  stripe_customer_id: string | null;
  is_personal: boolean;
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
  stripe_subscription_id: string | null;
  membership_tier: string | null;
  subscription_price_lookup_key: string | null;
  subscription_amount: number | null;
  updated_at_token: string;
}

/**
 * "Fully synced" requires status entitled AND product fields populated. A row
 * with `subscription_status='active'` but NULL `stripe_subscription_id` /
 * `subscription_price_lookup_key` is a partial-truth: entitled enough to pass
 * gate checks, but missing the data the tier resolver and dashboard need.
 *
 * Founding-member rows lived in this state for months — admin set status
 * manually but the Stripe sub never wrote its lookup_key into the org row.
 * The `every-entitled-org-has-resolvable-tier` invariant catches them now,
 * but lazy-reconcile is the cheap heal path: treating partial-truth as
 * "already entitled" leaves the row stuck. Only skip when the row is
 * actually complete.
 */
function isFullySynced(org: OrgRow): boolean {
  if (!org.subscription_status || !ENTITLED_STATUSES.has(org.subscription_status)) return false;
  if (!org.stripe_subscription_id) return false;
  if (!org.membership_tier && org.subscription_price_lookup_key === null && (org.subscription_amount ?? 0) <= 0) return false;
  return true;
}

export interface LazyReconcileDeps {
  pool: Pool;
  stripe: Stripe;
  logger: Logger;
}

/**
 * Attempt to heal an org row from Stripe state.
 *
 * Returns `{ healed: true, ... }` only if Stripe entitlement was written to a
 * stale, missing, or partial org row. Returns `{ healed: false, reason }`
 * for every skip path so callers can log the reason without taking action.
 */
export async function attemptStripeReconciliation(
  orgId: string,
  deps: LazyReconcileDeps,
): Promise<LazyReconcileResult> {
  const { pool, stripe, logger } = deps;

  const orgResult = await pool.query<OrgRow>(
    `SELECT workos_organization_id, stripe_customer_id, is_personal,
            subscription_status, subscription_canceled_at, stripe_subscription_id,
            membership_tier, subscription_price_lookup_key, subscription_amount,
            updated_at::text AS updated_at_token
       FROM organizations
      WHERE workos_organization_id = $1`,
    [orgId],
  );
  const org = orgResult.rows[0];
  if (!org) return { healed: false, reason: 'org_not_found' };

  if (isFullySynced(org)) {
    return { healed: false, reason: 'already_entitled' };
  }

  if (!org.stripe_customer_id) {
    return { healed: false, reason: 'no_stripe_customer' };
  }

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await stripe.customers.retrieve(org.stripe_customer_id, {
      expand: ['subscriptions'],
    });
  } catch (err) {
    logger.warn(
      { err, orgId, customerId: org.stripe_customer_id },
      'lazy-reconcile: stripe.customers.retrieve failed; deferring heal',
    );
    return { healed: false, reason: 'stripe_error' };
  }

  if (customer.deleted) {
    return { healed: false, reason: 'customer_deleted' };
  }

  const stampedOrgId = (customer as Stripe.Customer).metadata?.workos_organization_id;
  if (stampedOrgId !== orgId) {
    logger.warn(
      { orgId, customerId: org.stripe_customer_id, stampedOrgId: stampedOrgId ?? null },
      'lazy-reconcile: Stripe customer org metadata mismatch; refusing heal',
    );
    return { healed: false, reason: 'customer_org_mismatch' };
  }

  const subs = (customer as Stripe.Customer).subscriptions?.data ?? [];
  const picked = await pickMembershipSubWithProductFetch(
    subs,
    (productId) => stripe.products.retrieve(productId),
  );
  if (!picked) return { healed: false, reason: 'no_membership_sub' };
  if (!ENTITLED_STATUSES.has(picked.sub.status)) return { healed: false, reason: 'sub_not_entitled' };

  const payload = buildSubscriptionUpdate(
    picked.sub as Parameters<typeof buildSubscriptionUpdate>[0],
    org.is_personal,
    picked.product?.metadata ?? null,
  );
  const membershipTier = resolveMembershipTierForSubscriptionWrite(
    payload,
    org.membership_tier,
  );

  // Optimistically lock on updated_at. This permits repair of a fully populated
  // but stale non-entitled row (for example DB=canceled while Stripe=active)
  // without overwriting a newer webhook transition that lands after our read.
  const updated = await pool.query(
    `UPDATE organizations
       SET subscription_status = $1,
           stripe_subscription_id = $2,
           subscription_current_period_end = $3,
           subscription_amount = COALESCE($4, subscription_amount),
           subscription_currency = COALESCE($5, subscription_currency),
           subscription_interval = COALESCE($6, subscription_interval),
           subscription_canceled_at = $7,
           subscription_product_id = $8,
           subscription_product_name = COALESCE($9, subscription_product_name),
           subscription_price_id = $10,
           subscription_price_lookup_key = $11,
           membership_tier = $12,
           updated_at = NOW()
     WHERE workos_organization_id = $13
       AND updated_at = $14::timestamptz
       AND (
         subscription_status IS NULL
         OR subscription_status NOT IN ('active', 'trialing', 'past_due')
         OR stripe_subscription_id IS NULL
         OR (membership_tier IS NULL AND subscription_price_lookup_key IS NULL AND COALESCE(subscription_amount, 0) <= 0)
       )
     RETURNING workos_organization_id`,
    [
      payload.subscription_status,
      payload.stripe_subscription_id,
      payload.subscription_current_period_end,
      payload.subscription_amount,
      payload.subscription_currency,
      payload.subscription_interval,
      payload.subscription_canceled_at,
      payload.subscription_product_id,
      payload.subscription_product_name,
      payload.subscription_price_id,
      payload.subscription_price_lookup_key,
      membershipTier,
      orgId,
      org.updated_at_token,
    ],
  );

  if (updated.rowCount === 0) {
    // A webhook arrived between our read and write. The webhook is more
    // authoritative; treat as already-entitled.
    logger.info(
      { orgId, customerId: org.stripe_customer_id, subId: picked.sub.id },
      'lazy-reconcile: row was already updated by a concurrent webhook; deferring',
    );
    return { healed: false, reason: 'already_entitled' };
  }

  logger.info(
    {
      orgId,
      customerId: org.stripe_customer_id,
      subId: picked.sub.id,
      lookupKey: payload.subscription_price_lookup_key,
      stripeStatus: payload.subscription_status,
    },
    'lazy-reconcile: healed stale subscription state from Stripe',
  );

  invalidateMembershipCache(orgId);

  return {
    healed: true,
    reason: 'healed_from_stripe',
    subscriptionStatus: payload.subscription_status,
  };
}
