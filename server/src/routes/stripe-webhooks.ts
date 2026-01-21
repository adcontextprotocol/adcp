/**
 * Stripe Webhook Handler
 *
 * Handles all Stripe webhook events:
 * - customer.subscription.created/updated/deleted
 * - invoice.created/updated/finalized/voided
 * - invoice.paid/payment_succeeded
 * - invoice.payment_failed
 * - charge.refunded
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import Stripe from 'stripe';
import { WorkOS } from '@workos-inc/node';
import { stripe, STRIPE_WEBHOOK_SECRET } from '../billing/stripe-client.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';
import {
  notifyNewSubscription,
  notifyPaymentSucceeded,
  notifyPaymentFailed,
  notifySubscriptionCancelled,
} from '../notifications/billing.js';
import { invalidateMemberContextCache } from '../addie/index.js';
import { notifySubscriptionThankYou } from '../slack/org-group-dm.js';

const logger = createLogger('stripe-webhooks');

interface StripeWebhooksConfig {
  workos: WorkOS;
}

/**
 * Create the Stripe webhooks router
 */
export function createStripeWebhooksRouter(config: StripeWebhooksConfig): Router {
  const router = Router();
  const { workos } = config;

  // POST /api/webhooks/stripe - Handle Stripe webhooks
  router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      logger.warn('Stripe not configured for webhooks');
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logger.error({ err }, 'Webhook signature verification failed');
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    logger.info({ eventType: event.type }, 'Stripe webhook event received');

    // Initialize database clients
    const orgDb = new OrganizationDatabase();
    const pool = getPool();

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          await handleSubscriptionEvent(event, orgDb, pool, workos);
          break;
        }

        case 'invoice.created':
        case 'invoice.updated':
        case 'invoice.finalized':
        case 'invoice.voided': {
          await handleInvoiceLifecycleEvent(event, orgDb);
          break;
        }

        case 'invoice.payment_succeeded':
        case 'invoice.paid': {
          await handleInvoicePaidEvent(event, orgDb, pool);
          break;
        }

        case 'invoice.payment_failed': {
          await handleInvoicePaymentFailedEvent(event, orgDb);
          break;
        }

        case 'charge.refunded': {
          await handleChargeRefundedEvent(event, orgDb, pool);
          break;
        }

        default:
          logger.debug({ eventType: event.type }, 'Unhandled webhook event type');
      }

      res.json({ received: true });
    } catch (error) {
      logger.error({ err: error }, 'Error processing webhook');
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}

/**
 * Handle subscription created/updated/deleted events
 */
async function handleSubscriptionEvent(
  event: Stripe.Event,
  orgDb: OrganizationDatabase,
  pool: ReturnType<typeof getPool>,
  workos: WorkOS
): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  logger.info({
    customer: subscription.customer,
    status: subscription.status,
    eventType: event.type,
  }, 'Processing subscription event');

  // For subscription created, record agreement acceptance atomically
  if (event.type === 'customer.subscription.created') {
    const customerId = subscription.customer as string;

    // Try to find org by stripe_customer_id first
    let org = await orgDb.getOrganizationByStripeCustomerId(customerId);

    // If not found, look up by workos_organization_id in Stripe customer metadata
    if (!org) {
      logger.info({ customerId }, 'Org not found by customer ID, checking Stripe metadata');
      const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
      const workosOrgId = customer.metadata?.workos_organization_id;

      if (workosOrgId) {
        org = await orgDb.getOrganization(workosOrgId);
        if (org) {
          // Link the Stripe customer ID to the organization
          await orgDb.setStripeCustomerId(workosOrgId, customerId);
          logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization');
        }
      }
    }

    if (org) {
      // Get agreement info from organization's pending fields
      // (set when user checked the agreement checkbox)
      let agreementVersion = org.pending_agreement_version || '1.0';
      let agreementAcceptedAt = org.pending_agreement_accepted_at || new Date();

      // If no pending agreement, use current version
      if (!org.pending_agreement_version) {
        const currentAgreement = await orgDb.getCurrentAgreementByType('membership');
        if (currentAgreement) {
          agreementVersion = currentAgreement.version;
        }
      }

      // Get customer info from Stripe to find user email
      const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
      const userEmail = customer.email || 'unknown@example.com';

      // Warn if using fallback email - indicates missing customer data
      if (!customer.email) {
        logger.warn({
          customerId,
          subscriptionId: subscription.id,
          orgId: org.workos_organization_id,
        }, 'Using fallback email for subscription - customer has no email address');
      }

      // Get WorkOS user ID from email
      try {
        const users = await workos.userManagement.listUsers({ email: userEmail });
        const workosUser = users.data[0];

        if (workosUser) {
          // Record membership agreement acceptance
          try {
            await orgDb.recordUserAgreementAcceptance({
              workos_user_id: workosUser.id,
              email: userEmail,
              agreement_type: 'membership',
              agreement_version: agreementVersion,
              workos_organization_id: org.workos_organization_id,
            });
          } catch (agreementError) {
            logger.error({
              error: agreementError,
              orgId: org.workos_organization_id,
              subscriptionId: subscription.id,
              userEmail,
              agreementVersion,
            }, 'CRITICAL: Failed to record agreement acceptance - subscription exists but agreement not recorded. Manual intervention required.');
            throw agreementError;
          }

          // Update organization record
          await orgDb.updateOrganization(org.workos_organization_id, {
            agreement_signed_at: agreementAcceptedAt,
            agreement_version: agreementVersion,
          });

          // Store agreement metadata in Stripe subscription
          await stripe!.subscriptions.update(subscription.id, {
            metadata: {
              workos_organization_id: org.workos_organization_id,
              membership_agreement_version: agreementVersion,
              membership_agreement_accepted_at: agreementAcceptedAt.toISOString(),
            }
          });

          logger.info({
            orgId: org.workos_organization_id,
            subscriptionId: subscription.id,
            agreementVersion,
            userEmail,
          }, 'Subscription created - membership agreement recorded atomically');

          // Record audit log for subscription creation
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
            },
          });

          // Send Slack notification for new subscription
          const subItems = subscription.items?.data || [];
          const firstItem = subItems[0];
          let productName: string | undefined;
          let amount: number | undefined;
          let interval: string | undefined;

          if (firstItem?.price) {
            amount = firstItem.price.unit_amount || undefined;
            interval = firstItem.price.recurring?.interval;
            if (firstItem.price.product) {
              try {
                const product = await stripe!.products.retrieve(
                  typeof firstItem.price.product === 'string'
                    ? firstItem.price.product
                    : firstItem.price.product.id
                );
                productName = product.name;
              } catch {
                // Ignore product fetch errors
              }
            }
          }

          try {
            await notifyNewSubscription({
              organizationName: org.name,
              customerEmail: userEmail,
              productName,
              amount,
              currency: 'usd',
              interval,
            });
          } catch (notifyError) {
            logger.warn({ err: notifyError }, 'Failed to send new subscription notification');
          }

          // Send org group DM thanking them for subscribing
          try {
            // Look up admin emails for the org
            const memberships = await workos.userManagement.listOrganizationMemberships({
              organizationId: org.workos_organization_id,
            });
            const adminEmails: string[] = [];
            for (const membership of memberships.data) {
              if (membership.role?.slug === 'admin' || membership.role?.slug === 'owner') {
                try {
                  const user = await workos.userManagement.getUser(membership.userId);
                  if (user.email) adminEmails.push(user.email);
                } catch {
                  // Skip users we can't fetch
                }
              }
            }
            // Fall back to the subscribing user's email
            if (adminEmails.length === 0) {
              adminEmails.push(userEmail);
            }
            await notifySubscriptionThankYou({
              orgId: org.workos_organization_id,
              orgName: org.name,
              adminEmails,
            });
          } catch (dmError) {
            logger.warn({ err: dmError, orgId: org.workos_organization_id }, 'Failed to send subscription thank you DM');
          }
        } else {
          logger.warn({ userEmail, customerId }, 'No WorkOS user found for customer email - cannot record agreement');
        }
      } catch (userLookupError) {
        logger.error({ err: userLookupError, userEmail }, 'Failed to look up WorkOS user');
      }
    }
  }

  // Handle subscription updates
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const customerId = subscription.customer as string;

    // Find org to update
    let org = await orgDb.getOrganizationByStripeCustomerId(customerId);
    if (!org) {
      const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
      const workosOrgId = customer.metadata?.workos_organization_id;
      if (workosOrgId) {
        org = await orgDb.getOrganization(workosOrgId);
      }
    }

    if (org) {
      // Update subscription status in local database
      const priceData = subscription.items?.data?.[0]?.price;
      let productName: string | undefined;

      if (priceData?.product) {
        try {
          const product = await stripe!.products.retrieve(
            typeof priceData.product === 'string' ? priceData.product : priceData.product.id
          );
          productName = product.name;
        } catch {
          // Ignore product fetch errors
        }
      }

      await pool.query(
        `UPDATE organizations SET
          subscription_status = $1,
          subscription_product_id = $2,
          subscription_product_name = $3,
          subscription_amount = $4,
          subscription_currency = $5,
          subscription_current_period_end = $6,
          subscription_canceled_at = $7,
          stripe_subscription_id = $8,
          updated_at = NOW()
        WHERE workos_organization_id = $9`,
        [
          subscription.status,
          priceData?.product
            ? typeof priceData.product === 'string'
              ? priceData.product
              : priceData.product.id
            : null,
          productName || null,
          priceData?.unit_amount || null,
          priceData?.currency || 'usd',
          subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
          subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
          subscription.id,
          org.workos_organization_id,
        ]
      );

      logger.info({
        orgId: org.workos_organization_id,
        subscriptionId: subscription.id,
        status: subscription.status,
      }, 'Updated organization subscription status');

      // Invalidate member context cache
      invalidateMemberContextCache();

      // Send notification for subscription cancellation
      if (event.type === 'customer.subscription.deleted') {
        try {
          await notifySubscriptionCancelled({
            organizationName: org.name,
            productName,
          });
        } catch (notifyError) {
          logger.warn({ err: notifyError }, 'Failed to send subscription cancelled notification');
        }
      }
    }
  }
}

/**
 * Handle invoice lifecycle events (created/updated/finalized/voided)
 */
async function handleInvoiceLifecycleEvent(
  event: Stripe.Event,
  orgDb: OrganizationDatabase
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = invoice.customer as string;
  const pool = getPool();

  logger.info({
    invoiceId: invoice.id,
    customerId,
    status: invoice.status,
    eventType: event.type,
    total: invoice.total,
    amountDue: invoice.amount_due,
  }, 'Processing invoice lifecycle event');

  // Link Stripe customer to org if not already linked
  let org = await orgDb.getOrganizationByStripeCustomerId(customerId);
  if (!org) {
    const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
    const workosOrgId = customer.metadata?.workos_organization_id;
    if (workosOrgId) {
      org = await orgDb.getOrganization(workosOrgId);
      if (org && !org.stripe_customer_id) {
        await orgDb.setStripeCustomerId(workosOrgId, customerId);
        logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization from invoice webhook');
      }
    }
  }

  // For finalized invoices, cache key invoice data
  if (event.type === 'invoice.finalized' && org) {
    try {
      // Only cache non-subscription invoices (one-time invoices)
      if (!invoice.subscription) {
        await pool.query(
          `INSERT INTO invoice_cache (
            stripe_invoice_id, workos_organization_id, stripe_customer_id,
            amount_cents, currency, status, invoice_number, hosted_invoice_url, pdf_url,
            created_at, finalized_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          ON CONFLICT (stripe_invoice_id) DO UPDATE SET
            status = EXCLUDED.status,
            hosted_invoice_url = EXCLUDED.hosted_invoice_url,
            pdf_url = EXCLUDED.pdf_url,
            finalized_at = NOW()`,
          [
            invoice.id,
            org.workos_organization_id,
            customerId,
            invoice.amount_due,
            invoice.currency,
            invoice.status,
            invoice.number,
            invoice.hosted_invoice_url,
            invoice.invoice_pdf,
          ]
        );
        logger.info({
          invoiceId: invoice.id,
          orgId: org.workos_organization_id,
          amount: invoice.amount_due,
        }, 'Cached finalized invoice');
      }
    } catch (cacheError) {
      // Don't fail the webhook if caching fails - invoice_cache table may not exist
      logger.warn({ err: cacheError, invoiceId: invoice.id }, 'Failed to cache invoice (non-critical)');
    }
  }
}

/**
 * Handle invoice paid/payment_succeeded events
 */
async function handleInvoicePaidEvent(
  event: Stripe.Event,
  orgDb: OrganizationDatabase,
  pool: ReturnType<typeof getPool>
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = invoice.customer as string;

  logger.info({
    invoiceId: invoice.id,
    customerId,
    status: invoice.status,
    eventType: event.type,
    amountPaid: invoice.amount_paid,
    subscription: invoice.subscription ? 'yes' : 'no',
  }, 'Processing invoice paid event');

  // Find org by Stripe customer ID
  let org = await orgDb.getOrganizationByStripeCustomerId(customerId);
  if (!org) {
    const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
    const workosOrgId = customer.metadata?.workos_organization_id;
    if (workosOrgId) {
      org = await orgDb.getOrganization(workosOrgId);
      if (org && !org.stripe_customer_id) {
        await orgDb.setStripeCustomerId(workosOrgId, customerId);
        logger.info({ workosOrgId, customerId }, 'Linked Stripe customer to organization from invoice.paid webhook');
      }
    }
  }

  if (org && invoice.amount_paid > 0) {
    // Determine if this is a membership invoice
    const lineItem = invoice.lines?.data?.[0] as any;
    const priceLookupKey = lineItem?.price?.lookup_key || '';
    const productMetadata = lineItem?.price?.product?.metadata || {};
    const productCategory = productMetadata.category;

    // Membership products have lookup keys starting with aao_membership_ or aao_invoice_
    // or have category='membership' in product metadata
    const isMembershipInvoice =
      productCategory === 'membership' ||
      priceLookupKey.startsWith('aao_membership_') ||
      priceLookupKey.startsWith('aao_invoice_');

    // For membership invoices without a subscription, update subscription_status
    // This handles manual invoices and one-time membership payments
    if (isMembershipInvoice && !(invoice as any).subscription) {
      const periodEnd = invoice.period_end
        ? new Date(invoice.period_end * 1000)
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Default to 1 year

      await pool.query(
        `UPDATE organizations
         SET subscription_status = 'active',
             subscription_current_period_end = $1,
             updated_at = NOW()
         WHERE workos_organization_id = $2
           AND (subscription_status IS NULL OR subscription_status != 'active')`,
        [periodEnd, org.workos_organization_id]
      );

      logger.info({
        orgId: org.workos_organization_id,
        invoiceId: invoice.id,
        periodEnd: periodEnd.toISOString(),
        priceLookupKey,
        productCategory,
      }, 'Activated membership from invoice payment (no subscription)');

      // Invalidate member context cache
      invalidateMemberContextCache();
    }

    // Record revenue event
    try {
      await pool.query(
        `INSERT INTO revenue_events (
          workos_organization_id, stripe_customer_id, stripe_invoice_id,
          event_type, amount_cents, currency, description, event_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (stripe_invoice_id, event_type) DO NOTHING`,
        [
          org.workos_organization_id,
          customerId,
          invoice.id,
          'payment',
          invoice.amount_paid,
          invoice.currency,
          `Payment received - Invoice ${invoice.number || invoice.id}`,
        ]
      );
      logger.info({
        orgId: org.workos_organization_id,
        invoiceId: invoice.id,
        amount: invoice.amount_paid,
      }, 'Revenue event recorded');
    } catch (revenueError) {
      logger.error({
        err: revenueError,
        orgId: org.workos_organization_id,
        invoiceId: invoice.id,
      }, 'Failed to insert revenue event');
      // Continue processing - don't fail the webhook
    }

    // Update invoice cache if we have it
    try {
      await pool.query(
        `UPDATE invoice_cache SET
          status = $1,
          paid_at = NOW()
        WHERE stripe_invoice_id = $2`,
        [invoice.status, invoice.id]
      );
    } catch {
      // Don't fail webhook for cache update errors
    }

    // Send payment success notification
    try {
      await notifyPaymentSucceeded({
        organizationName: org.name,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        isRecurring: !!invoice.subscription,
      });
    } catch (notifyError) {
      logger.warn({ err: notifyError }, 'Failed to send payment success notification');
    }
  }
}

/**
 * Handle invoice payment failed events
 */
async function handleInvoicePaymentFailedEvent(
  event: Stripe.Event,
  orgDb: OrganizationDatabase
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = invoice.customer as string;

  logger.info({
    invoiceId: invoice.id,
    customerId,
    status: invoice.status,
    eventType: event.type,
    attemptCount: invoice.attempt_count,
  }, 'Processing invoice payment failed event');

  // Find org
  let org = await orgDb.getOrganizationByStripeCustomerId(customerId);
  if (!org) {
    const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
    const workosOrgId = customer.metadata?.workos_organization_id;
    if (workosOrgId) {
      org = await orgDb.getOrganization(workosOrgId);
    }
  }

  if (org) {
    // Send payment failed notification
    try {
      await notifyPaymentFailed({
        organizationName: org.name,
        amount: invoice.amount_due,
        currency: invoice.currency,
        attemptCount: invoice.attempt_count,
      });
    } catch (notifyError) {
      logger.warn({ err: notifyError }, 'Failed to send payment failed notification');
    }
  }
}

/**
 * Handle charge refunded events
 */
async function handleChargeRefundedEvent(
  event: Stripe.Event,
  orgDb: OrganizationDatabase,
  pool: ReturnType<typeof getPool>
): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const customerId = charge.customer as string;

  logger.info({
    chargeId: charge.id,
    customerId,
    amountRefunded: charge.amount_refunded,
    eventType: event.type,
  }, 'Processing charge refunded event');

  if (customerId) {
    // Find org
    let org = await orgDb.getOrganizationByStripeCustomerId(customerId);
    if (!org) {
      const customer = await stripe!.customers.retrieve(customerId) as Stripe.Customer;
      const workosOrgId = customer.metadata?.workos_organization_id;
      if (workosOrgId) {
        org = await orgDb.getOrganization(workosOrgId);
      }
    }

    if (org && charge.amount_refunded > 0) {
      // Record refund as negative revenue event
      try {
        await pool.query(
          `INSERT INTO revenue_events (
            workos_organization_id, stripe_customer_id, stripe_charge_id,
            event_type, amount_cents, currency, description, event_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (stripe_charge_id, event_type) DO NOTHING`,
          [
            org.workos_organization_id,
            customerId,
            charge.id,
            'refund',
            -charge.amount_refunded, // Negative for refunds
            charge.currency,
            `Refund processed - Charge ${charge.id}`,
          ]
        );
        logger.info({
          orgId: org.workos_organization_id,
          chargeId: charge.id,
          amount: charge.amount_refunded,
        }, 'Refund event recorded');
      } catch (revenueError) {
        logger.error({
          err: revenueError,
          orgId: org.workos_organization_id,
          chargeId: charge.id,
        }, 'Failed to insert refund event');
        // Continue processing - don't fail the webhook
      }
    }
  }
}
