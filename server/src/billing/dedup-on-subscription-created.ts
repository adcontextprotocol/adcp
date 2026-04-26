/**
 * Webhook-side defense against duplicate subscriptions on a single Stripe
 * customer. Closes the cross-path race the intake-side guards (#3171
 * blockIfActiveSubscription, #3183 advisory lock) leave open: Stripe Checkout
 * creates a session URL, not a subscription — the sub gets minted only when
 * the user completes the hosted page. So two concurrent intake paths (e.g.,
 * admin invite + member checkout) can both pass their guards before either
 * mints a sub, and the user can complete both within seconds.
 *
 * On `customer.subscription.created` we look at the customer's full live-sub
 * inventory. If there's another live sub besides this new one, we cancel the
 * new one with proration refund, alert ops, and tell the caller to suppress
 * the org-row UPDATE so the existing surviving sub's state stays intact.
 */
import type Stripe from 'stripe';
import type { Logger } from 'pino';
import { TIER_PRESERVING_STATUSES } from '../db/organization-db.js';

export interface DedupArgs {
  /** The just-created subscription from the webhook event. */
  subscription: Stripe.Subscription;
  /** Stripe customer id (extracted from `subscription.customer`). */
  customerId: string;
  /** Org id we resolved for this customer; used in alert messaging. */
  orgId?: string | null;
  stripe: Stripe;
  logger: Logger;
  notifySystemError: (ctx: { source: string; errorMessage: string }) => void;
}

export interface DedupResult {
  /**
   * True when the new sub was identified as a duplicate and canceled.
   * Caller must skip the org-row UPDATE so the surviving sub's state stays.
   */
  duplicate: boolean;
  /** When `duplicate`, the IDs of the *other* live subs we kept. */
  existingLiveSubIds: string[];
}

/**
 * Returns `{ duplicate: false }` to let the normal webhook flow proceed.
 * Returns `{ duplicate: true, existingLiveSubIds }` after canceling the new
 * sub when the customer already has another live one.
 *
 * Lookup or cancel failures are logged and treated as "don't know" — we fall
 * through to `duplicate: false`, accepting that a missed duplicate will be
 * caught by the periodic integrity audit (#3193 invariant
 * `one-active-stripe-sub-per-org`). Failing closed (refusing the sub) on a
 * transient Stripe error would be worse: it would block legitimate first-time
 * subscriptions during a Stripe blip.
 */
export async function dedupOnSubscriptionCreated(args: DedupArgs): Promise<DedupResult> {
  const { subscription, customerId, orgId, stripe, logger, notifySystemError } = args;

  let liveSubs: Stripe.Subscription[];
  try {
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });
    liveSubs = list.data;
  } catch (err) {
    logger.warn(
      { err, customerId, newSubId: subscription.id, orgId },
      'dedup-on-subscription-created: subscriptions.list failed — proceeding without dedup check',
    );
    return { duplicate: false, existingLiveSubIds: [] };
  }

  const otherLive = liveSubs.filter(
    (s) =>
      s.id !== subscription.id &&
      (TIER_PRESERVING_STATUSES as readonly string[]).includes(s.status),
  );
  if (otherLive.length === 0) {
    return { duplicate: false, existingLiveSubIds: [] };
  }

  const otherIds = otherLive.map((s) => s.id);
  logger.error(
    {
      newSubId: subscription.id,
      customerId,
      orgId,
      existingLiveSubIds: otherIds,
    },
    'Duplicate subscription detected on customer.subscription.created — canceling new sub',
  );

  try {
    await stripe.subscriptions.cancel(subscription.id, { prorate: true });
  } catch (cancelErr) {
    logger.error(
      { err: cancelErr, customerId, newSubId: subscription.id, orgId },
      'Failed to cancel duplicate subscription — manual intervention needed',
    );
    // Continue with the alert; ops needs to know either way.
  }

  notifySystemError({
    source: 'stripe-subscription-dedup',
    errorMessage:
      `Duplicate subscription ${subscription.id} on customer ${customerId} ` +
      `(org ${orgId ?? 'unknown'}) was canceled with proration. ` +
      `Existing live subs kept: ${otherIds.join(', ')}.`,
  });

  return { duplicate: true, existingLiveSubIds: otherIds };
}
