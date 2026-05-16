/**
 * Lazy reconciliation: when a paywall gate is about to deny a request from
 * an org that has a `stripe_customer_id` but no `subscription_status`, pull
 * fresh state from Stripe and self-heal the org row before the deny fires.
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
 *  - Only writes the subscription_* columns on the org row.
 *  - Does NOT write `agreement_signed_at`, `user_agreement_acceptances`,
 *    or `org_activities` rows. The webhook handler (handle-subscription-created)
 *    is the canonical place for those side effects, and it's keyed off
 *    `pending_agreement_user_id` set at checkbox-click time. A user clicking
 *    a paywall is action-signal but not a fresh consent event.
 *  - Idempotent: `WHERE subscription_status IS NULL` guards against
 *    overwriting a status set by a webhook that landed between read and write.
 *  - Safe to call on every paywall hit; only does Stripe work when the org
 *    actually looks drifted.
 */
import type { Pool } from 'pg';
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import { pickMembershipSub } from './membership-prices.js';

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
  | 'no_membership_sub'
  | 'sub_not_entitled';

interface OrgRow {
  workos_organization_id: string;
  stripe_customer_id: string | null;
  subscription_status: string | null;
  subscription_canceled_at: Date | null;
  stripe_subscription_id: string | null;
  subscription_price_lookup_key: string | null;
  subscription_amount: number | null;
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
  if (org.subscription_price_lookup_key === null && (org.subscription_amount ?? 0) <= 0) return false;
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
 * Returns `{ healed: true, ... }` only if the row went from "no live
 * subscription" to a written entitlement. Returns `{ healed: false, reason }`
 * for every skip path so callers can log the reason without taking action.
 */
export async function attemptStripeReconciliation(
  orgId: string,
  deps: LazyReconcileDeps,
): Promise<LazyReconcileResult> {
  const { pool, stripe, logger } = deps;

  const orgResult = await pool.query<OrgRow>(
    `SELECT workos_organization_id, stripe_customer_id, subscription_status, subscription_canceled_at,
            stripe_subscription_id, subscription_price_lookup_key, subscription_amount
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

  const subs = (customer as Stripe.Customer).subscriptions?.data ?? [];
  const sub = pickMembershipSub(subs);
  if (!sub) return { healed: false, reason: 'no_membership_sub' };
  if (!ENTITLED_STATUSES.has(sub.status)) return { healed: false, reason: 'sub_not_entitled' };

  const price = sub.items.data[0]?.price;

  // The WHERE clause only writes when the row is still in a partial-truth
  // state (no entitled status, or status set but key product fields missing).
  // If a webhook beat us to a fully-synced state between our read and write,
  // the update is a no-op — the webhook is the source of truth for live
  // transitions; lazy reconcile only fills gaps.
  const updated = await pool.query(
    `UPDATE organizations
       SET subscription_status = $1,
           stripe_subscription_id = $2,
           subscription_amount = $3,
           subscription_currency = $4,
           subscription_interval = $5,
           subscription_current_period_end = $6,
           subscription_canceled_at = $7,
           subscription_price_lookup_key = $8,
           updated_at = NOW()
     WHERE workos_organization_id = $9
       AND (
         subscription_status IS NULL
         OR subscription_status = 'none'
         OR stripe_subscription_id IS NULL
         OR (subscription_price_lookup_key IS NULL AND COALESCE(subscription_amount, 0) <= 0)
       )
     RETURNING workos_organization_id`,
    [
      sub.status,
      sub.id,
      price?.unit_amount ?? null,
      price?.currency ?? 'usd',
      price?.recurring?.interval ?? null,
      sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
      sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
      price?.lookup_key ?? null,
      orgId,
    ],
  );

  if (updated.rowCount === 0) {
    // A webhook arrived between our read and write. The webhook is more
    // authoritative; treat as already-entitled.
    logger.info(
      { orgId, customerId: org.stripe_customer_id, subId: sub.id },
      'lazy-reconcile: row was already updated by a concurrent webhook; deferring',
    );
    return { healed: false, reason: 'already_entitled' };
  }

  logger.info(
    {
      orgId,
      customerId: org.stripe_customer_id,
      subId: sub.id,
      lookupKey: price?.lookup_key ?? null,
      stripeStatus: sub.status,
    },
    'lazy-reconcile: healed missing subscription_status from Stripe',
  );

  return {
    healed: true,
    reason: 'healed_from_stripe',
    subscriptionStatus: sub.status,
  };
}
