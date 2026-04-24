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
 * Returns `null` when no source resolves. Callers must treat that as a hard
 * failure — record the org-level agreement if known, surface a loud alert,
 * and plan manual reconciliation.
 */
export async function resolveWorkosUserForSubscription(
  args: ResolveArgs,
): Promise<ResolvedWorkosUser | null> {
  const { subscription, customer, workos, logger } = args;

  const subUserId = subscription.metadata?.workos_user_id;
  if (subUserId) {
    const user = await tryGetUser(workos, subUserId, logger, 'subscription_metadata');
    if (user) return { user, source: 'subscription_metadata' };
  }

  const custUserId = customer.metadata?.workos_user_id;
  if (custUserId && custUserId !== subUserId) {
    const user = await tryGetUser(workos, custUserId, logger, 'customer_metadata');
    if (user) return { user, source: 'customer_metadata' };
  }

  const email = customer.email;
  if (email) {
    try {
      const users = await workos.userManagement.listUsers({ email });
      const user = users.data[0];
      if (user) return { user, source: 'email_lookup' };
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
