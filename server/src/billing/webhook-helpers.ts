import Stripe from 'stripe';
import { OrganizationDatabase, StripeCustomerConflictError } from '../db/organization-db.js';
import type { Organization } from '../db/organization-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('webhook-helpers');

export interface ResolveOrgOptions {
  customerId: string;
  stripe: Stripe;
  orgDb: OrganizationDatabase;
  subscription?: Stripe.Subscription;
  invoice?: Stripe.Invoice;
}

/**
 * Resolve the organization for a Stripe customer using multiple fallback strategies.
 *
 * Lookup order:
 * 1. stripe_customer_id in our DB (fast path, no Stripe API call)
 * 2. workos_organization_id in Stripe customer metadata
 * 3. workos_organization_id in subscription metadata (if subscription provided)
 * 3.5. stripe_subscription_id direct DB lookup (if subscription provided — defence-in-depth
 *      for drift-customer cases where metadata was never stamped on the sub)
 * 4. For invoices with a subscription, retrieve the sub and check its metadata
 *
 * On any successful fallback, links the customer to the org for future fast-path lookups.
 */
export async function resolveOrgForStripeCustomer(
  options: ResolveOrgOptions
): Promise<Organization | null> {
  const { customerId, stripe, orgDb, subscription, invoice } = options;

  // 1. Fast path: look up by stripe_customer_id in our DB
  const orgByCustomerId = await orgDb.getOrganizationByStripeCustomerId(customerId);
  if (orgByCustomerId) return orgByCustomerId;

  // 2. Check Stripe customer metadata
  let workosOrgId: string | undefined;
  try {
    const customerRaw = await stripe.customers.retrieve(customerId);
    if (!('deleted' in customerRaw && customerRaw.deleted)) {
      workosOrgId = (customerRaw as Stripe.Customer).metadata?.workos_organization_id;
    }
  } catch (err) {
    logger.warn({ err, customerId }, 'Failed to retrieve Stripe customer for org resolution');
  }

  // 3. Check subscription metadata (Stripe copies checkout session subscription_data.metadata here)
  if (!workosOrgId && subscription) {
    workosOrgId = subscription.metadata?.workos_organization_id;
  }

  // 3.5 — Direct stripe_subscription_id DB lookup. Defence-in-depth when metadata
  // paths miss (e.g. subscriptions created before metadata-stamping was added, or
  // when the event's customer is a drift customer not linked to the org row). If the
  // org's tracked stripe_subscription_id matches the incoming event's sub ID, we can
  // resolve the org without metadata at all.
  if (!workosOrgId && subscription) {
    const orgBySubId = await orgDb.getOrganizationByStripeSubscriptionId(subscription.id);
    if (orgBySubId) {
      logger.info(
        { workosOrgId: orgBySubId.workos_organization_id, customerId, subscriptionId: subscription.id },
        'Resolved org via stripe_subscription_id DB lookup',
      );
      try {
        await orgDb.setStripeCustomerId(orgBySubId.workos_organization_id, customerId);
        logger.info(
          { workosOrgId: orgBySubId.workos_organization_id, customerId },
          'Linked Stripe customer to organization via subscription-ID webhook fallback',
        );
      } catch (err) {
        if (err instanceof StripeCustomerConflictError) {
          logger.warn(
            { err: err.message, workosOrgId: orgBySubId.workos_organization_id, customerId },
            'Stripe customer conflict during subscription-ID webhook org resolution',
          );
        } else {
          logger.error(
            { err, workosOrgId: orgBySubId.workos_organization_id, customerId },
            'Failed to link Stripe customer to organization via subscription-ID fallback',
          );
        }
      }
      return orgBySubId;
    }
  }

  // 4. For invoices with a subscription, retrieve the sub and check its metadata
  if (!workosOrgId && invoice) {
    const subRef = invoice.subscription;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id ?? null;
    if (subId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        workosOrgId = sub.metadata?.workos_organization_id;
      } catch (err) {
        logger.warn({ err, subscriptionId: subId }, 'Failed to retrieve subscription for invoice org resolution');
      }
    }
  }

  if (!workosOrgId) {
    logger.info({ customerId }, 'Could not resolve organization for Stripe customer via any fallback');
    return null;
  }

  const org = await orgDb.getOrganization(workosOrgId);
  if (!org) {
    logger.warn({ customerId, workosOrgId }, 'Found workos_organization_id but org does not exist in database');
    return null;
  }

  // Link the customer to the org for future fast-path lookups
  try {
    await orgDb.setStripeCustomerId(workosOrgId, customerId);
    logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization via webhook fallback');
  } catch (err) {
    if (err instanceof StripeCustomerConflictError) {
      logger.warn({ err: err.message, workosOrgId, customerId }, 'Stripe customer conflict during webhook org resolution');
    } else {
      logger.error({ err, workosOrgId, customerId }, 'Failed to link Stripe customer to organization');
    }
  }

  return org;
}
