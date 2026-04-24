/**
 * Handle the `customer.subscription.created` branch of the Stripe webhook.
 *
 * This was inline in `server/src/http.ts` until it accumulated enough moving
 * parts — resolver, org agreement update, user-level attestation insert,
 * audit log, activity row, pending-clear, metadata stamp, Slack notify — that
 * regression risk exceeded what unit tests on the resolver alone could catch
 * (see testing-expert feedback on PR #3011). Extracted so the flow is
 * injectable and its observable effects are assertable from integration
 * tests.
 *
 * Returns the admin-facing activation context when a WorkOS user was
 * successfully resolved and the user-level agreement landed; `undefined`
 * otherwise. Callers use it to drive the autopublish + welcome-email
 * dispatch block further down the webhook handler.
 */

import type Stripe from 'stripe';
import type { WorkOS } from '@workos-inc/node';
import type { Logger } from 'pino';
import type { Pool } from 'pg';
import type { OrganizationDatabase, Organization } from '../db/organization-db.js';
import { resolveWorkosUserForSubscription } from './resolve-subscription-user.js';

export interface ActivationAdminContext {
  userEmail: string;
  workosUserId: string;
  firstName?: string;
  productName?: string;
}

export interface HandleSubscriptionCreatedArgs {
  subscription: Stripe.Subscription;
  customerId: string;
  org: Organization;
  stripe: Stripe;
  workos: WorkOS;
  orgDb: OrganizationDatabase;
  pool: Pool;
  logger: Logger;
  notifySystemError: (ctx: { source: string; errorMessage: string }) => void;
  notifyNewSubscription: (data: {
    organizationName: string;
    customerEmail: string;
    productName?: string;
    amount?: number;
    currency?: string;
    interval?: string;
  }) => Promise<boolean>;
}

export async function handleSubscriptionCreated(
  args: HandleSubscriptionCreatedArgs,
): Promise<ActivationAdminContext | undefined> {
  const {
    subscription,
    customerId,
    org,
    stripe,
    workos,
    orgDb,
    pool,
    logger,
    notifySystemError,
    notifyNewSubscription,
  } = args;

  // Agreement version / timestamp from pending fields set at checkbox time;
  // fall back to the current published version if pending wasn't captured
  // (legacy orgs or non-UI flows).
  let agreementVersion = org.pending_agreement_version || '1.0';
  const agreementAcceptedAt = org.pending_agreement_accepted_at || new Date();

  if (!org.pending_agreement_version) {
    const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
    if (currentAgreement) agreementVersion = currentAgreement.version;
  }

  // `customers.retrieve` returns `Customer | DeletedCustomer`. A deleted
  // customer has no email/metadata; treat as a hard reconciliation case
  // instead of attempting attribution.
  const retrievedCustomer = await stripe.customers.retrieve(customerId);
  if (retrievedCustomer.deleted) {
    logger.error({
      customerId,
      subscriptionId: subscription.id,
      orgId: org.workos_organization_id,
      needs_manual_reconciliation: true,
    }, 'CRITICAL: Stripe customer is deleted — cannot record agreement acceptance. Manual backfill required.');
    notifySystemError({
      source: 'stripe-webhook-agreement',
      errorMessage: `Subscription ${subscription.id} (customer ${customerId}, org ${org.workos_organization_id}): customer is deleted — agreement acceptance cannot be recorded.`,
    });
    return undefined;
  }

  const customer: Stripe.Customer = retrievedCustomer;
  const userEmail = customer.email || 'unknown@example.com';

  if (!customer.email) {
    logger.warn({
      customerId,
      subscriptionId: subscription.id,
      orgId: org.workos_organization_id,
    }, 'Using fallback email for subscription - customer has no email address');
  }

  // Resolve the user BEFORE clearing pending_* on the org row — otherwise
  // the pending_agreement_user_id source would be wiped out in the same pass.
  const resolved = await resolveWorkosUserForSubscription({
    subscription,
    customer,
    organizationId: org.workos_organization_id,
    pendingAgreementUserId: org.pending_agreement_user_id,
    workos,
    logger,
  });

  // Org-level agreement update runs regardless of user resolution: the org
  // clicked the checkbox and paid, so the membership-level attestation is
  // known. pending_* fields are NOT cleared here — if the user-level insert
  // fails, we want Stripe's retry to still have them available.
  await orgDb.updateOrganization(org.workos_organization_id, {
    agreement_signed_at: agreementAcceptedAt,
    agreement_version: agreementVersion,
  });

  // Fetch product details for Slack/activity notifications (user-independent).
  const productInfo = await fetchProductInfo(stripe, subscription, logger);

  let activationAdminContext: ActivationAdminContext | undefined;

  if (resolved) {
    const workosUser = resolved.user;
    let userAgreementRecorded = false;

    try {
      await orgDb.recordUserAgreementAcceptance({
        workos_user_id: workosUser.id,
        email: userEmail,
        agreement_type: 'membership',
        agreement_version: agreementVersion,
        workos_organization_id: org.workos_organization_id,
        // IP and user-agent not available in webhook context
      });
      userAgreementRecorded = true;

      // Clear pending_* now that the user-level record is in. If this fails
      // it's non-blocking — the user row still exists and pending_* just get
      // lazily cleared on a subsequent webhook.
      await orgDb.updateOrganization(org.workos_organization_id, {
        pending_agreement_version: null,
        pending_agreement_accepted_at: null,
        pending_agreement_user_id: null,
      }).catch((err) => logger.warn({
        err,
        orgId: org.workos_organization_id,
      }, 'Failed to clear pending_agreement fields after successful recording (non-critical)'));
    } catch (agreementError) {
      // Alert loudly but do not throw — the rest of the webhook (subscription
      // DB sync, tier change detection, directory activation) must still run.
      // Throwing here would force a Stripe retry that re-fires
      // notifyNewSubscription and re-inserts a non-deduped org_activities row.
      logger.error({
        error: agreementError,
        orgId: org.workos_organization_id,
        subscriptionId: subscription.id,
        workosUserId: workosUser.id,
        userEmail,
        agreementVersion,
        needs_manual_reconciliation: true,
      }, 'CRITICAL: Failed to insert user_agreement_acceptances — org agreement recorded but user attestation missing. Manual backfill required.');
      notifySystemError({
        source: 'stripe-webhook-agreement',
        errorMessage: `Subscription ${subscription.id} (org ${org.workos_organization_id}, user ${workosUser.id}): user_agreement_acceptances insert failed — manual backfill required.`,
      });
    }

    if (userAgreementRecorded) {
      logger.info({
        orgId: org.workos_organization_id,
        subscriptionId: subscription.id,
        workosUserId: workosUser.id,
        resolveSource: resolved.source,
        agreementVersion,
        userEmail,
      }, 'Subscription created — membership agreement recorded');

      await orgDb.recordAuditLog({
        workos_organization_id: org.workos_organization_id,
        workos_user_id: workosUser.id,
        action: 'subscription_created',
        resource_type: 'subscription',
        resource_id: subscription.id,
        details: {
          status: subscription.status,
          agreement_version: agreementVersion,
          stripe_customer_id: customerId,
          user_resolve_source: resolved.source,
        },
      });

      activationAdminContext = {
        userEmail,
        workosUserId: workosUser.id,
        firstName: workosUser.firstName || undefined,
        productName: productInfo.productName,
      };

      const amountStr = productInfo.amount ? `$${(productInfo.amount / 100).toFixed(2)}` : '';
      const intervalStr = productInfo.interval ? `/${productInfo.interval}` : '';
      await pool.query(
        `INSERT INTO org_activities (
          organization_id,
          activity_type,
          description,
          logged_by_user_id,
          logged_by_name,
          activity_date
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          org.workos_organization_id,
          'subscription',
          `Subscribed to ${productInfo.productName || 'membership'} ${amountStr}${intervalStr}`.trim(),
          workosUser.id,
          userEmail,
        ],
      );
    }
  } else {
    logger.error({
      customerId,
      subscriptionId: subscription.id,
      orgId: org.workos_organization_id,
      userEmail,
      subMetadata: subscription.metadata,
      customerMetadata: customer.metadata,
      needs_manual_reconciliation: true,
    }, 'CRITICAL: Could not resolve WorkOS user for subscription — org-level agreement recorded, but user-level attestation missing. Manual backfill required.');
    notifySystemError({
      source: 'stripe-webhook-agreement',
      errorMessage: `Subscription ${subscription.id} (org ${org.workos_organization_id}, customer ${customerId}) created but no WorkOS user resolvable via subscription/customer metadata or email. Backfill user_agreement_acceptances manually.`,
    });
  }

  // Stamp the subscription with agreement metadata after the attestation
  // attempt. Best-effort: a failure here (Stripe rate limit / transient 5xx)
  // should not block the rest of the webhook since the authoritative record
  // is in our DB.
  stripe.subscriptions.update(subscription.id, {
    metadata: {
      workos_organization_id: org.workos_organization_id,
      membership_agreement_version: agreementVersion,
      membership_agreement_accepted_at: agreementAcceptedAt.toISOString(),
    },
  }).catch((err) => logger.warn({
    err,
    subscriptionId: subscription.id,
    orgId: org.workos_organization_id,
  }, 'Failed to stamp subscription metadata with agreement info — DB record remains authoritative'));

  notifyNewSubscription({
    organizationName: org.name || 'Unknown Organization',
    customerEmail: userEmail,
    productName: productInfo.productName,
    amount: productInfo.amount,
    currency: subscription.currency,
    interval: productInfo.interval,
  }).catch((err) => logger.error({ err }, 'Failed to send Slack notification'));

  return activationAdminContext;
}

async function fetchProductInfo(
  stripe: Stripe,
  subscription: Stripe.Subscription,
  logger: Logger,
): Promise<{ productName?: string; amount?: number; interval?: string }> {
  const firstItem = subscription.items?.data?.[0];
  if (!firstItem?.price) return {};

  const amount = firstItem.price.unit_amount || undefined;
  const interval = firstItem.price.recurring?.interval;
  let productName: string | undefined;

  if (firstItem.price.product) {
    try {
      const product = (await stripe.products.retrieve(firstItem.price.product as string)) as Stripe.Product;
      productName = product.name;
    } catch (err) {
      logger.debug({ err }, 'Failed to retrieve Stripe product metadata (non-critical)');
    }
  }

  return { productName, amount, interval };
}
