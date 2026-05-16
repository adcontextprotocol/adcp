/**
 * Webhook-side defense against duplicate subscriptions on a single Stripe
 * customer. Closes the cross-path race the intake-side guards (#3171
 * blockIfActiveSubscription, #3183 advisory lock) leave open: Stripe Checkout
 * creates a session URL, not a subscription — the sub gets minted only when
 * the user completes the hosted page. So two concurrent intake paths (e.g.,
 * admin invite + member checkout) can both pass their guards before either
 * mints a sub, and the user can complete both within seconds.
 *
 * Policy (#3245 update, replaced earlier "always cancel newer"):
 *   - Look at every live (active/trialing/past_due) sub on the customer.
 *   - Determine paid/unpaid via `latest_invoice.status === 'paid'`.
 *   - If exactly one is unpaid: cancel that one, keep the paid survivor.
 *   - If zero or multiple are unpaid: don't auto-cancel — alert ops for
 *     manual review (covers two-paid edge case and the rare both-open one).
 *
 * Why this beats cancel-newer: the typical AAO duplicate is one paid (the
 * legit member) plus one unpaid open invoice (the wrong-tier intake). The
 * cancel-newer rule worked for the Triton case by luck — it would have
 * canceled a legitimate higher-tier upgrade if the member had paid the
 * upgrade after the duplicate-old-sub appeared.
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

/**
 * Outcome of the dedup decision. Caller (http.ts) uses `kind` to wire the
 * downstream behavior:
 *   - `no_duplicate`        → normal flow (handleSubscriptionCreated + org UPDATE)
 *   - `retry_skip`          → skip UPDATE and activation hooks. Fires on
 *                              webhook retries where the sub arg is already
 *                              non-live (we canceled it on a prior invocation).
 *   - `canceled_new`        → skip UPDATE so the surviving sub's row state stays
 *   - `canceled_existing`   → let UPDATE run (the new sub becomes the tracked
 *                              one), but don't fire fresh-activation hooks —
 *                              the customer was already a member
 *   - `manual_review`       → skip UPDATE; don't fire activation hooks; ops
 *                              alerted to resolve manually
 */
export interface CanceledSubFacts {
  /** Whether the Stripe cancel API call succeeded. False = ops manual cleanup. */
  cancelSucceeded: boolean;
  /** Stripe price.unit_amount on the canceled sub (cents); null if unknown. */
  amountCents: number | null;
  /** Stripe price.lookup_key on the canceled sub; null if unknown. */
  lookupKey: string | null;
}

export type DedupOutcome =
  | { kind: 'no_duplicate' }
  | { kind: 'retry_skip' }
  | {
      kind: 'canceled_new';
      existingLiveSubIds: string[];
      canceledFacts: CanceledSubFacts;
      /** Product.name or lookup_key of the surviving sub, for customer email copy. */
      survivingTierLabel: string | null;
    }
  | {
      kind: 'canceled_existing';
      canceledSubId: string;
      survivingNewSubId: string;
      canceledFacts: CanceledSubFacts;
      survivingTierLabel: string | null;
    }
  | { kind: 'manual_review'; allLiveSubIds: string[]; reason: string };

interface SubPaidStatus {
  sub: Stripe.Subscription;
  /** True iff `latest_invoice.status === 'paid'`. Null/draft/open all count as unpaid. */
  paid: boolean;
}

/**
 * Returns a `DedupOutcome` describing what the helper did.
 *
 * Lookup or cancel failures are logged and treated as "don't know" — we fall
 * through to `no_duplicate`, accepting that a missed duplicate will be
 * caught by the periodic integrity audit (#3193 invariant
 * `one-active-stripe-sub-per-org`). Failing closed (refusing the sub) on a
 * transient Stripe error would be worse: it would block legitimate first-time
 * subscriptions during a Stripe blip.
 */
export async function dedupOnSubscriptionCreated(args: DedupArgs): Promise<DedupOutcome> {
  const { subscription, customerId, orgId, stripe, logger, notifySystemError } = args;

  // Stripe retries `customer.subscription.created` on 5xx / slow handlers.
  // On retry the new sub will already be canceled by the prior invocation;
  // skip cleanly so we don't try to cancel-again (returns 400) and re-alert.
  // Caller must ALSO skip the org-row UPDATE — running it would overwrite
  // the surviving sub's state with the canceled retry's `status: 'canceled'`.
  if (!(TIER_PRESERVING_STATUSES as readonly string[]).includes(subscription.status)) {
    return { kind: 'retry_skip' };
  }

  let liveSubs: Stripe.Subscription[];
  try {
    // Expand latest_invoice for paid status. The product expansion that
    // used to ride alongside it (`data.items.data.price.product`) is 5
    // levels deep and exceeds Stripe's 4-level expand limit, which broke
    // every dedup check silently — the catch fell through to no_duplicate
    // and the cross-path race guard never ran. `tierLabelForSub` already
    // falls back to `price.lookup_key` (which comes back inline), so the
    // customer-email tier label still reads correctly on lookup-keyed
    // prices; founding-era prices without a lookup_key degrade to null
    // (rare on the dedup path — those orgs don't double-checkout).
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
      expand: ['data.latest_invoice'],
    });
    if (list.has_more) {
      logger.warn(
        { customerId, newSubId: subscription.id, orgId },
        'dedup-on-subscription-created: subscriptions.list paginated — only first 100 inspected',
      );
    }
    liveSubs = list.data.filter((s) =>
      (TIER_PRESERVING_STATUSES as readonly string[]).includes(s.status),
    );
  } catch (err) {
    logger.warn(
      { err, customerId, newSubId: subscription.id, orgId },
      'dedup-on-subscription-created: subscriptions.list failed — proceeding without dedup check',
    );
    return { kind: 'no_duplicate' };
  }

  if (liveSubs.length <= 1) {
    return { kind: 'no_duplicate' };
  }

  // Compute paid status for each live sub. `latest_invoice` may be:
  //   - an expanded Stripe.Invoice with .status set
  //   - a string id (if expand failed silently for some reason)
  //   - null (no invoice yet — counts as unpaid)
  const statuses: SubPaidStatus[] = liveSubs.map((s) => ({
    sub: s,
    paid: isLatestInvoicePaid(s.latest_invoice),
  }));

  const unpaid = statuses.filter((s) => !s.paid);
  const paid = statuses.filter((s) => s.paid);

  // Exactly one unpaid → cancel it. Only safe auto-action.
  if (unpaid.length === 1) {
    const target = unpaid[0].sub;
    const survivors = liveSubs.filter((s) => s.id !== target.id);

    const canceled = await tryCancel({
      subId: target.id,
      stripe,
      logger,
      customerId,
      orgId,
    });

    notifyDedupAction({
      notifySystemError,
      customerId,
      orgId,
      action: canceled ? 'canceled_unpaid' : 'cancel_failed',
      canceledSub: target,
      survivors,
    });

    const canceledFacts = factsForSub(target, canceled);
    // For the customer email, derive a human-readable tier label from the
    // surviving sub. canceled_new has exactly one survivor (the existing
    // sub); canceled_existing's survivor is the new sub itself.
    const survivor = target.id === subscription.id ? survivors[0] : subscription;
    const survivingTierLabel = tierLabelForSub(survivor);

    if (target.id === subscription.id) {
      return {
        kind: 'canceled_new',
        existingLiveSubIds: survivors.map((s) => s.id),
        canceledFacts,
        survivingTierLabel,
      };
    }
    return {
      kind: 'canceled_existing',
      canceledSubId: target.id,
      survivingNewSubId: subscription.id,
      canceledFacts,
      survivingTierLabel,
    };
  }

  // Multiple paid (rare; legit upgrade race) or multiple unpaid (two
  // concurrent send_invoice flows in flight). Don't auto-cancel — too easy
  // to discard real revenue or the wrong intake. Alert ops with full
  // context so they can resolve manually.
  const reason =
    unpaid.length === 0
      ? `${paid.length} live subs, all paid — possible legit upgrade race or duplicate payment`
      : `${unpaid.length} live subs, all unpaid — concurrent intake flows`;

  logger.error(
    {
      customerId,
      orgId,
      newSubId: subscription.id,
      allLiveSubIds: liveSubs.map((s) => s.id),
      paidSubIds: paid.map((s) => s.sub.id),
      unpaidSubIds: unpaid.map((s) => s.sub.id),
    },
    'Duplicate subscription detected — manual review required',
  );

  notifySystemError({
    source: 'stripe-subscription-dedup',
    errorMessage:
      `Duplicate subscriptions on customer ${customerId} (org ${orgId ?? 'unknown'}) ` +
      `require manual review: ${reason}. ` +
      `New sub: ${subscription.id}. ` +
      `paid=${paid.map((s) => s.sub.id).join(',') || '(none)'}; ` +
      `unpaid=${unpaid.map((s) => s.sub.id).join(',') || '(none)'}. ` +
      `Resolve in Stripe Dashboard, then run /sync.`,
  });

  return {
    kind: 'manual_review',
    allLiveSubIds: liveSubs.map((s) => s.id),
    reason,
  };
}

function factsForSub(
  sub: Stripe.Subscription,
  cancelSucceeded: boolean,
): CanceledSubFacts {
  const price = sub.items?.data?.[0]?.price;
  return {
    cancelSucceeded,
    amountCents: price?.unit_amount ?? null,
    lookupKey: price?.lookup_key ?? null,
  };
}

/**
 * Human-readable label for a sub's tier. Prefers the expanded product name;
 * falls back to the price's lookup_key, then null.
 */
function tierLabelForSub(sub: Stripe.Subscription | undefined): string | null {
  if (!sub) return null;
  const price = sub.items?.data?.[0]?.price;
  if (!price) return null;
  const product = price.product;
  if (product && typeof product !== 'string') {
    const name = (product as Stripe.Product).name;
    if (name) return name;
  }
  return price.lookup_key ?? null;
}

/**
 * Strict "money actually moved" check. Returns true only for `status: 'paid'`.
 * Stripe's other invoice statuses are intentionally treated as unpaid:
 *   - `null`               → no invoice yet (timing of webhook event)
 *   - `'draft'` / `'open'` → not collected yet
 *   - `'uncollectible'`    → Stripe wrote it off after retries
 *   - `'void'`             → invoice was canceled
 *   - unexpanded string id → can't tell; safer to treat as unpaid
 */
function isLatestInvoicePaid(
  latestInvoice: Stripe.Subscription['latest_invoice'],
): boolean {
  if (!latestInvoice) return false;
  if (typeof latestInvoice === 'string') return false;
  return latestInvoice.status === 'paid';
}

async function tryCancel(args: {
  subId: string;
  stripe: Stripe;
  logger: Logger;
  customerId: string;
  orgId?: string | null;
}): Promise<boolean> {
  try {
    await args.stripe.subscriptions.cancel(args.subId, { prorate: true });
    return true;
  } catch (err) {
    args.logger.error(
      { err, customerId: args.customerId, subId: args.subId, orgId: args.orgId },
      'Failed to cancel duplicate subscription — manual intervention needed',
    );
    return false;
  }
}

function notifyDedupAction(args: {
  notifySystemError: (ctx: { source: string; errorMessage: string }) => void;
  customerId: string;
  orgId?: string | null;
  action: 'canceled_unpaid' | 'cancel_failed';
  canceledSub: Stripe.Subscription;
  survivors: Stripe.Subscription[];
}) {
  const item = args.canceledSub.items?.data?.[0];
  const amount = item?.price?.unit_amount ?? null;
  const lookupKey = item?.price?.lookup_key ?? null;
  const collection = args.canceledSub.collection_method ?? null;

  const cancelStatus =
    args.action === 'canceled_unpaid'
      ? 'was canceled (it was the unpaid duplicate)'
      : 'COULD NOT be canceled (Stripe error) — cancel manually in Stripe';

  args.notifySystemError({
    source: 'stripe-subscription-dedup',
    errorMessage:
      `Duplicate subscription ${args.canceledSub.id} on customer ${args.customerId} ` +
      `(org ${args.orgId ?? 'unknown'}) ${cancelStatus}. ` +
      `Canceled sub: amount=${amount ?? 'unknown'} lookup_key=${lookupKey ?? 'unknown'} ` +
      `collection=${collection ?? 'unknown'}. ` +
      `Survivors: ${args.survivors.map((s) => s.id).join(', ') || '(none)'}.`,
  });
}
