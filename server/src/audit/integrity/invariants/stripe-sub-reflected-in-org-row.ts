/**
 * Invariant: every paid membership subscription that is live in Stripe is
 * reflected in the AAO `organizations` row for its linked org. Catches the
 * inverse direction from `org-row-matches-live-stripe-sub`: that one starts
 * at orgs we already think are subscribed and verifies Stripe agrees. This
 * one starts at Stripe and verifies our DB caught up.
 *
 * "Reflected" means the row's `subscription_status` is entitled AND its
 * `stripe_subscription_id` and tier-resolving product fields
 * (`subscription_price_lookup_key` or `subscription_amount`) are populated.
 * Status alone is not enough: a row with `status='active'` but NULL
 * stripe_subscription_id / NULL lookup_key passes the gate but leaves the
 * tier resolver returning null, which the dashboard renders as an
 * Explorer/upgrade-to-Professional upsell to a paying member.
 *
 * Motivating incidents:
 *   - Lina (Apr 2026): paid Professional, Stripe `active`, but
 *     `customer.subscription.created` never updated the row. `subscription_status`
 *     stayed NULL for ~40 days while she was blocked from paid content.
 *   - Adzymic (May 2026): founding-member row had `subscription_status='active'`
 *     manually set, but `stripe_subscription_id` / `subscription_price_lookup_key`
 *     stayed NULL. Tier resolver returned null; dashboard rendered "Explorer"
 *     and "Upgrade to Professional" to a paying corporate member.
 *
 * Detect-only by design. The framework's auto-remediation policy lives at
 * Phase 3+; for now violations are surfaced for an admin to act on via
 * `POST /api/admin/accounts/:orgId/sync`. The orphan-customer branch
 * (Stripe customer with paid sub, not linked to any org) is intentionally
 * not auto-linked — that path inherits the email-based dedup vulnerability
 * in `createStripeCustomer` and is a Stripe-customer-hijack-to-membership
 * attack vector if automated.
 */
import type Stripe from 'stripe';
import type { Invariant, InvariantContext, InvariantResult, Violation } from '../types.js';
import { isMembershipSubWithProductFetch } from '../../../billing/membership-prices.js';

/**
 * Stripe statuses that grant entitlement at AAO. Mirrors the gate logic
 * elsewhere in the codebase. `past_due` keeps access during dunning; the
 * customer hasn't lost access just because a payment retry is pending.
 */
const ENTITLED_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due']);

function customerIdOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
}

function priceFieldsOf(sub: Stripe.Subscription): {
  lookup_key: string | null;
  unit_amount: number | null;
} {
  const price = sub.items.data[0]?.price;
  return {
    lookup_key: price?.lookup_key ?? null,
    unit_amount: price?.unit_amount ?? null,
  };
}

interface OrgRow {
  workos_organization_id: string;
  name: string;
  stripe_customer_id: string;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  subscription_price_lookup_key: string | null;
  subscription_amount: number | null;
}

/**
 * "Reflected in the org row" means more than `subscription_status` being set.
 * The tier resolver and the dashboard depend on `stripe_subscription_id` and
 * a tier-resolving product field (`subscription_price_lookup_key` or
 * `subscription_amount`). A row with `status='active'` but those NULL is the
 * partial-truth state founding-era orgs sat in for months: entitled by gate,
 * but the dashboard renders an Explorer/upgrade-to-Professional teaser
 * because tier resolves to null. Treat the row as reflected only when all
 * three conditions hold.
 */
function isReflected(org: OrgRow): boolean {
  if (!org.subscription_status) return false;
  if (!ENTITLED_STATUSES.has(org.subscription_status as Stripe.Subscription.Status)) return false;
  if (!org.stripe_subscription_id) return false;
  if (!org.subscription_price_lookup_key && (org.subscription_amount ?? 0) <= 0) return false;
  return true;
}

export const stripeSubReflectedInOrgRowInvariant: Invariant = {
  name: 'stripe-sub-reflected-in-org-row',
  description:
    'Every membership subscription that is active or trialing in Stripe is fully reflected in the org row for its linked customer — entitled status PLUS populated stripe_subscription_id and tier-resolving product fields. Catches missed webhooks (Lina-class) and partial-truth rows where status was set manually but Stripe data never synced (Adzymic-class).',
  severity: 'critical',
  async check(ctx: InvariantContext): Promise<InvariantResult> {
    const { pool, stripe, logger } = ctx;
    const violations: Violation[] = [];

    // Two list calls, server-side filtered, regardless of customer count.
    // Cheaper than walking customers (2N+ calls) and bounded by the count of
    // live entitling subs, which is small at AAO scale.
    //
    // No expand — the path Stripe needs for product metadata
    // (`data.items.data.price.product`) is 5 levels deep and over the
    // 4-level limit, which made this invariant throw on every run. Walk
    // the list with the lookup_key fast path; founding-era subs that
    // lack the `aao_membership_*` convention fall through to a per-product
    // `products.retrieve` (cached) so legacy prices (Adzymic, Advertible,
    // Bidcliq, Equativ — May 2026) still classify as membership.
    const memberSubs: Stripe.Subscription[] = [];
    const productCache = new Map<string, Stripe.Product | Stripe.DeletedProduct>();
    for (const status of ['active', 'trialing'] as const) {
      for await (const sub of stripe.subscriptions.list({
        status,
        limit: 100,
      })) {
        const isMember = await isMembershipSubWithProductFetch(
          sub,
          (productId) => stripe.products.retrieve(productId),
          productCache,
        );
        if (isMember) memberSubs.push(sub);
      }
    }

    if (memberSubs.length === 0) {
      return { checked: 0, violations: [] };
    }

    const customerIds = Array.from(new Set(memberSubs.map(customerIdOf)));

    const orgsResult = await pool.query<OrgRow>(
      `SELECT workos_organization_id, name, stripe_customer_id,
              subscription_status, stripe_subscription_id,
              subscription_price_lookup_key, subscription_amount
         FROM organizations
        WHERE stripe_customer_id = ANY($1::text[])`,
      [customerIds],
    );
    const customerToOrg = new Map<string, OrgRow>(
      orgsResult.rows.map((r) => [r.stripe_customer_id, r]),
    );

    for (const sub of memberSubs) {
      const customerId = customerIdOf(sub);
      const { lookup_key, unit_amount } = priceFieldsOf(sub);
      const org = customerToOrg.get(customerId);

      if (!org) {
        // Stripe customer holds a paid membership sub but has no AAO org
        // pointing at it. Could be: (a) abandoned-checkout customer that got
        // re-used, (b) customer linked to org that was later merged/deleted,
        // (c) test-mode bleed (shouldn't happen in live env), (d) a real
        // org-link that needs a human admin to make.
        //
        // Severity is `warning`, not `critical`: no AAO user is being denied
        // entitlement (there's no AAO user attached). Auto-linking on email
        // or metadata is unsafe — `createStripeCustomer`'s dedup lookups have
        // a known collision path that an attacker could exploit by getting
        // their Stripe-customer email matched to a victim's org.
        violations.push({
          invariant: 'stripe-sub-reflected-in-org-row',
          severity: 'warning',
          subject_type: 'customer',
          subject_id: customerId,
          message:
            `Stripe customer ${customerId} holds ${sub.status} membership subscription ${sub.id} ` +
            `(${lookup_key ?? 'no lookup_key'}) but is not linked to any AAO organization.`,
          details: {
            stripe_subscription_id: sub.id,
            stripe_status: sub.status,
            lookup_key,
            unit_amount,
            customer_email:
              typeof sub.customer === 'string' || sub.customer.deleted
                ? null
                : sub.customer.email,
          },
          remediation_hint:
            'Use the admin UI to link this customer to its org via POST /api/admin/billing/customers/:customerId/link. Do not auto-link — that path is a Stripe-customer-hijack vector.',
        });
        continue;
      }

      // Healthy: row reflects Stripe entitlement. No-op.
      if (isReflected(org)) {
        continue;
      }

      // Lina-class (status NULL) or Adzymic-class (status active but key fields
      // NULL — tier resolver returns null, dashboard renders bogus upsell).
      // Both surface as critical: a paying customer is either denied access or
      // shown a Professional-upgrade teaser instead of their real tier.
      const isPartialTruth =
        org.subscription_status &&
        ENTITLED_STATUSES.has(org.subscription_status as Stripe.Subscription.Status);

      violations.push({
        invariant: 'stripe-sub-reflected-in-org-row',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: org.workos_organization_id,
        message: isPartialTruth
          ? `Org "${org.name}" has paid membership subscription ${sub.id} live in Stripe ` +
            `(${sub.status}) but DB row is partial-truth: status=${JSON.stringify(org.subscription_status)}, ` +
            `stripe_subscription_id=${JSON.stringify(org.stripe_subscription_id)}, ` +
            `lookup_key=${JSON.stringify(org.subscription_price_lookup_key)}. ` +
            `Tier resolver returns null, dashboard renders the wrong upsell.`
          : `Org "${org.name}" has paid membership subscription ${sub.id} live in Stripe ` +
            `(${sub.status}) but DB row shows subscription_status=${JSON.stringify(org.subscription_status)}. ` +
            `Member is incorrectly being denied entitlement.`,
        details: {
          org_name: org.name,
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id,
          stripe_status: sub.status,
          db_subscription_status: org.subscription_status,
          db_stripe_subscription_id: org.stripe_subscription_id,
          db_subscription_price_lookup_key: org.subscription_price_lookup_key,
          db_subscription_amount: org.subscription_amount,
          partial_truth: !!isPartialTruth,
          lookup_key,
          unit_amount,
        },
        remediation_hint:
          `POST /api/admin/accounts/${org.workos_organization_id}/sync to pull fresh state from Stripe and unblock the member. Investigate why the customer.subscription.created/updated webhook didn't fire (Stripe dashboard webhook delivery log).`,
      });
    }

    if (memberSubs.length > 0 && violations.length > 0) {
      logger.warn(
        { invariant: 'stripe-sub-reflected-in-org-row', total_subs: memberSubs.length, violations: violations.length },
        'Stripe→DB reconciliation found drift',
      );
    }

    return { checked: memberSubs.length, violations };
  },
};
