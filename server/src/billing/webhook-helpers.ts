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
