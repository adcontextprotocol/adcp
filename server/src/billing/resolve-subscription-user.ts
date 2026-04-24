import type Stripe from 'stripe';
import type { WorkOS, User as WorkOSUser } from '@workos-inc/node';
import type { Logger } from 'pino';

export type ResolveSource = 'subscription_metadata' | 'customer_metadata' | 'email_lookup';

export interface ResolvedWorkosUser {
  user: WorkOSUser;
  source: ResolveSource;
}

export interface ResolveArgs {
  subscription: Stripe.Subscription;
  customer: Stripe.Customer;
  organizationId: string;
  workos: WorkOS;
  logger: Logger;
}

/**
 * Resolve the WorkOS user who initiated a Stripe subscription so the webhook
 * can attribute agreement acceptance (`user_agreement_acceptances.workos_user_id`)
 * to the correct person.
 *
 * Resolution order:
 *   1. `subscription.metadata.workos_user_id` — set by our checkout-session flow.
 *   2. Stripe customer `metadata.workos_user_id` — for customers we already stamped.
 *   3. Email lookup against WorkOS — for legacy customers created before the
 *      metadata-first path shipped. Only useful when the Stripe-customer email
 *      matches the WorkOS-user email (brittle: this is the mode that caused the
 *      original silent-failure bug).
 *
 * Every resolved user must be a member of `organizationId`. This guards against
 * stale metadata pointing to an offboarded user or a subscription cloned
 * across orgs — without the check, the agreement would be attributed to
 * someone who never clicked the checkbox. If the membership check fails we
 * fall through to the next source.
 *
 * Returns `null` when no source yields a member of the subscribing org.
 * Callers must treat that as a hard failure — record the org-level agreement
 * if known, surface a loud alert, and plan manual reconciliation.
 */
export async function resolveWorkosUserForSubscription(
  args: ResolveArgs,
): Promise<ResolvedWorkosUser | null> {
  const { subscription, customer, organizationId, workos, logger } = args;

  const subUserId = subscription.metadata?.workos_user_id;
  if (subUserId) {
    const user = await tryGetUser(workos, subUserId, logger, 'subscription_metadata');
    if (user && await isOrgMember(workos, user.id, organizationId, logger, 'subscription_metadata')) {
      return { user, source: 'subscription_metadata' };
    }
  }

  const custUserId = customer.metadata?.workos_user_id;
  if (custUserId && custUserId !== subUserId) {
    const user = await tryGetUser(workos, custUserId, logger, 'customer_metadata');
    if (user && await isOrgMember(workos, user.id, organizationId, logger, 'customer_metadata')) {
      return { user, source: 'customer_metadata' };
    }
  }

  const email = customer.email;
  if (email) {
    try {
      const users = await workos.userManagement.listUsers({ email });
      // Prefer the user who belongs to the subscribing org. WorkOS allows the
      // same email across org contexts in some configurations, so taking
      // data[0] blindly is a misattribution risk.
      for (const candidate of users.data) {
        if (await isOrgMember(workos, candidate.id, organizationId, logger, 'email_lookup')) {
          return { user: candidate, source: 'email_lookup' };
        }
      }
    } catch (err) {
      logger.error(
        { err, customerId: customer.id, subscriptionId: subscription.id, email },
        'WorkOS email lookup failed while resolving subscription user',
      );
    }
  }

  return null;
}

async function tryGetUser(
  workos: WorkOS,
  userId: string,
  logger: Logger,
  source: ResolveSource,
): Promise<WorkOSUser | null> {
  try {
    return await workos.userManagement.getUser(userId);
  } catch (err) {
    logger.warn(
      { err, userId, source },
      'Stored WorkOS user ID did not resolve — falling through to next source',
    );
    return null;
  }
}

async function isOrgMember(
  workos: WorkOS,
  userId: string,
  organizationId: string,
  logger: Logger,
  source: ResolveSource,
): Promise<boolean> {
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({
      userId,
      organizationId,
    });
    if (memberships.data.length === 0) {
      logger.warn(
        { userId, organizationId, source },
        'Resolved WorkOS user is not a member of the subscribing org — falling through',
      );
      return false;
    }
    return true;
  } catch (err) {
    // Membership lookup failure is indistinguishable from "not a member" for
    // our purposes — fall through so the next source gets a chance.
    logger.warn(
      { err, userId, organizationId, source },
      'Org-membership check failed — falling through',
    );
    return false;
  }
}
