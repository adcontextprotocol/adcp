/**
 * Addie Billing Tools
 *
 * Tools for the authenticated member to act on their own organization's
 * billing. All identity (email, user id, org id, billing address) is sourced
 * from the signed-in session and the org row — these tools do not accept
 * caller-supplied identity for any field that touches a Stripe write.
 *
 * Admin-initiated billing for prospects (people who are not yet signed in)
 * lives in `send_payment_request` (admin-tools.ts), and is invite-only:
 * the recipient signs in, accepts the agreement, and the invoice/checkout
 * is then issued in their authenticated session.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import {
  getProductsForCustomer,
  createCheckoutSession,
  createAndSendInvoice,
  validateInvoiceDetails,
  createStripeCustomer,
  createCustomerPortalSession,
  getPriceByLookupKey,
  type BillingProduct,
} from '../../billing/stripe-client.js';
import { OrganizationDatabase } from '../../db/organization-db.js';

const logger = createLogger('addie-billing-tools');
const orgDb = new OrganizationDatabase();

/**
 * Tool definitions for billing operations
 */
export const BILLING_TOOLS: AddieTool[] = [
  {
    name: 'find_membership_products',
    description: `Find available membership products for a potential member.
Use this when someone asks about joining, membership pricing, or wants to become a member.
You should ask about their company type and approximate revenue to find the right product.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_type: {
          type: 'string',
          enum: ['company', 'individual'],
          description: 'Whether this is a company or individual membership',
        },
        revenue_tier: {
          type: 'string',
          enum: ['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'],
          description: 'Company annual revenue tier (only for company memberships)',
        },
      },
      required: ['customer_type'],
    },
  },
  {
    name: 'create_payment_link',
    description: `Create a Stripe checkout payment link for the authenticated member's own organization.
The link is issued to the signed-in member only — the customer email and identity are taken from the
authenticated session, never from caller-supplied input. The member must be signed in at
agenticadvertising.org and have a workspace; if not, refuse and direct them to sign up first.
This tool cannot generate payment links on behalf of other people or organizations.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
      },
      required: ['lookup_key'],
    },
  },
  {
    name: 'send_invoice',
    description: `Preview an invoice for the authenticated member's own organization so they can
confirm the amount and billing email before it is sent. The contact email and company are taken from
the signed-in session, never from caller-supplied input. After calling this and the member confirms,
call confirm_send_invoice to send.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        coupon_id: {
          type: 'string',
          description: 'Explicit Stripe coupon ID to apply (optional - org discount is used automatically if available)',
        },
        payment_terms: {
          type: 'number',
          enum: [30, 45, 60, 90],
          description: 'Payment terms in days (net-30, net-45, net-60, net-90). Defaults to 30.',
        },
      },
      required: ['lookup_key'],
    },
  },
  {
    name: 'confirm_send_invoice',
    description: `Send an invoice for the authenticated member's own organization after they have
confirmed the details shown by send_invoice. The contact email, company, and billing address come
from the signed-in session — they cannot be overridden. The org must already have a billing address
on file (set via the dashboard or invite-acceptance flow).`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        coupon_id: {
          type: 'string',
          description: 'Explicit Stripe coupon ID to apply (optional)',
        },
        payment_terms: {
          type: 'number',
          enum: [30, 45, 60, 90],
          description: 'Payment terms in days (net-30, net-45, net-60, net-90). Defaults to 30.',
        },
      },
      required: ['lookup_key'],
    },
  },
  {
    name: 'get_billing_portal',
    description: `Get a link to the Stripe Customer Portal where the member can view invoices, download receipts, update payment methods, and manage their subscription.
Use this when a member asks about receipts, invoices, billing history, payment methods, or subscription management.
The member must be signed in.`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

/**
 * Format currency for display
 */
function formatCurrency(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * Format revenue tier for display
 */
function formatRevenueTier(tier: string): string {
  const labels: Record<string, string> = {
    under_1m: 'Under $1M',
    '1m_5m': '$1M - $5M',
    '5m_50m': '$5M - $50M',
    '50m_250m': '$50M - $250M',
    '250m_1b': '$250M - $1B',
    '1b_plus': 'Over $1B',
  };
  return labels[tier] || tier;
}

/**
 * Tool handler implementations
 */
export function createBillingToolHandlers(memberContext?: MemberContext | null): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Find membership products
  handlers.set('find_membership_products', async (input) => {
    const customerType = input.customer_type as 'company' | 'individual';
    const revenueTier = input.revenue_tier as string | undefined;

    logger.info({ customerType, revenueTier }, 'Addie: Finding membership products');

    try {
      const products = await getProductsForCustomer({
        customerType,
        revenueTier,
        category: 'membership',
      });

      if (products.length === 0) {
        // Try to get all products to see if there are any at all
        const allProducts = await getProductsForCustomer({});
        logger.warn({
          customerType,
          revenueTier,
          allProductsCount: allProducts.length,
          allProductLookupKeys: allProducts.map(p => p.lookup_key),
        }, 'Addie: No membership products found');

        if (allProducts.length === 0) {
          return JSON.stringify({
            success: false,
            message: 'Unable to access billing products. This may be a configuration issue - please contact the team.',
          });
        }

        return JSON.stringify({
          success: false,
          message: `No membership products found matching the criteria (customer_type: ${customerType || 'any'}, revenue_tier: ${revenueTier || 'any'}). Please try without filters or contact the team.`,
        });
      }

      const formatted = products.map((p: BillingProduct) => ({
        name: p.display_name || p.product_name,
        description: p.description,
        price: formatCurrency(p.amount_cents, p.currency),
        billing: p.billing_type === 'subscription'
          ? `${p.billing_interval}ly subscription`
          : 'one-time payment',
        lookup_key: p.lookup_key,
        can_invoice: p.is_invoiceable,
        revenue_tiers: p.revenue_tiers.length > 0
          ? p.revenue_tiers.map(formatRevenueTier).join(', ')
          : 'All sizes',
      }));

      return JSON.stringify({
        success: true,
        products: formatted,
        message: `Found ${products.length} product(s) for ${customerType} membership`,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error finding products');
      return JSON.stringify({
        success: false,
        error: 'Failed to find products. Please try again.',
      });
    }
  });

  // Create payment link — issued to the authenticated member's org only.
  // Email and user identity come from memberContext, never from caller input,
  // so an LLM-supplied email cannot become the Stripe customer.
  handlers.set('create_payment_link', async (input) => {
    const lookupKey = input.lookup_key as string;

    const workosUserId = memberContext?.workos_user?.workos_user_id;
    const memberEmail = memberContext?.workos_user?.email;
    const orgId = memberContext?.organization?.workos_organization_id;

    if (!workosUserId || !memberEmail) {
      return JSON.stringify({
        success: false,
        error: 'Cannot create a payment link without a signed-in account. Ask the user to sign in at https://agenticadvertising.org first, then try again.',
      });
    }
    if (!orgId) {
      return JSON.stringify({
        success: false,
        error: 'This user has an account but no workspace yet. They need to complete onboarding at https://agenticadvertising.org/dashboard to create their workspace before a payment link can be generated.',
      });
    }

    logger.info({ lookupKey, orgId, workosUserId }, 'Addie: Creating payment link for signed-in member');

    try {
      const priceId = await getPriceByLookupKey(lookupKey);
      if (!priceId) {
        return JSON.stringify({
          success: false,
          error: `No product matches lookup_key "${lookupKey}". Call find_membership_products first, then pass the exact lookup_key from the result.`,
        });
      }

      const org = await orgDb.getOrganization(orgId);

      // Ensure a Stripe customer exists with org metadata before creating the
      // checkout session so the subscription webhook can link back to the org.
      const customerId = (await orgDb.getOrCreateStripeCustomer(orgId, () =>
        createStripeCustomer({
          email: memberEmail,
          name: org?.name || 'Unknown',
          metadata: { workos_organization_id: orgId, workos_user_id: workosUserId },
        })
      )) || undefined;

      const session = await createCheckoutSession({
        priceId,
        customerId,
        customerEmail: customerId ? undefined : memberEmail,
        successUrl: 'https://agenticadvertising.org/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://agenticadvertising.org/dashboard?checkout=cancelled',
        workosOrganizationId: orgId,
        workosUserId,
        isPersonalWorkspace: org?.is_personal || false,
        couponId: org?.stripe_coupon_id || undefined,
        promotionCode: !org?.stripe_coupon_id ? (org?.stripe_promotion_code || undefined) : undefined,
      });

      if (!session) {
        return JSON.stringify({
          success: false,
          error: 'Stripe is not configured. Please contact support.',
        });
      }

      return JSON.stringify({
        success: true,
        payment_url: session.url,
        message: 'Payment link created. Share this URL with the signed-in member to complete checkout.',
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error creating payment link');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return JSON.stringify({
        success: false,
        error: `Failed to create payment link: ${errorMessage}`,
      });
    }
  });

  // Preview invoice for the authenticated member's own org (no Stripe mutations).
  // Contact email and company come from memberContext + the org row, never from
  // caller input, so an LLM-supplied email cannot become the invoice recipient.
  handlers.set('send_invoice', async (input) => {
    const lookupKey = input.lookup_key as string;
    const explicitCouponId = input.coupon_id as string | undefined;
    const paymentTerms = input.payment_terms as number | undefined;

    const memberEmail = memberContext?.workos_user?.email;
    const orgId = memberContext?.organization?.workos_organization_id;
    if (!memberEmail || !orgId) {
      return JSON.stringify({
        success: false,
        error: 'Cannot preview an invoice without a signed-in member and a workspace. Ask the user to sign in at https://agenticadvertising.org first.',
      });
    }

    let effectiveCouponId = explicitCouponId;
    let orgDiscount: string | undefined;
    let companyName: string | undefined;

    try {
      const org = await orgDb.getOrganization(orgId);
      if (org) {
        companyName = org.name;
        if (!explicitCouponId && org.stripe_coupon_id) {
          effectiveCouponId = org.stripe_coupon_id;
          orgDiscount = org.discount_percent
            ? `${org.discount_percent}% off`
            : org.discount_amount_cents
              ? `$${org.discount_amount_cents / 100} off`
              : undefined;
        }
      }
    } catch (orgLookupError) {
      logger.debug({ error: orgLookupError }, 'Could not look up org for invoice preview');
    }

    logger.info({ lookupKey, orgId, hasCoupon: !!effectiveCouponId }, 'Addie: Previewing invoice for signed-in member');

    try {
      const preview = await validateInvoiceDetails({
        lookupKey,
        contactEmail: memberEmail,
        couponId: effectiveCouponId,
      });

      if (!preview) {
        return JSON.stringify({
          success: false,
          error: 'Product not found or Stripe is not configured.',
        });
      }

      const amount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: preview.currency.toUpperCase(),
      }).format(preview.amountDue / 100);

      return JSON.stringify({
        success: true,
        amount,
        contact_email: memberEmail,
        company_name: companyName,
        product_name: preview.productName,
        discount_applied: preview.discountApplied,
        discount_description: orgDiscount,
        discount_warning: preview.discountWarning,
        payment_terms: paymentTerms ?? 30,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error previewing invoice');
      return JSON.stringify({
        success: false,
        error: 'Failed to preview invoice. Please try again.',
      });
    }
  });

  // Send invoice after the authenticated member confirms.
  // Contact email, company, and billing address all come from the signed-in
  // session and the org row — caller input cannot redirect the invoice.
  handlers.set('confirm_send_invoice', async (input) => {
    const lookupKey = input.lookup_key as string;
    const explicitCouponId = input.coupon_id as string | undefined;
    const paymentTerms = input.payment_terms as number | undefined;

    const memberEmail = memberContext?.workos_user?.email;
    const orgId = memberContext?.organization?.workos_organization_id;
    if (!memberEmail || !orgId) {
      return JSON.stringify({
        success: false,
        error: 'Cannot send an invoice without a signed-in member and a workspace. Ask the user to sign in at https://agenticadvertising.org first.',
      });
    }

    const memberFirstName = memberContext?.workos_user?.first_name;
    const memberLastName = memberContext?.workos_user?.last_name;
    const contactName =
      [memberFirstName, memberLastName].filter(Boolean).join(' ') || memberEmail;

    let org: Awaited<ReturnType<OrganizationDatabase['getOrganization']>> | null = null;
    try {
      org = await orgDb.getOrganization(orgId);
    } catch (orgLookupError) {
      logger.error({ error: orgLookupError, orgId }, 'Failed to load org for invoice send');
    }

    if (!org) {
      return JSON.stringify({
        success: false,
        error: 'Could not load your organization. Please contact finance@agenticadvertising.org.',
      });
    }

    if (!org.billing_address || !org.billing_address.line1) {
      return JSON.stringify({
        success: false,
        error: 'Your organization does not have a billing address on file. Please add one in the dashboard at https://agenticadvertising.org/dashboard/membership before requesting an invoice.',
      });
    }

    let effectiveCouponId = explicitCouponId;
    let orgDiscount: string | undefined;
    if (!explicitCouponId && org.stripe_coupon_id) {
      effectiveCouponId = org.stripe_coupon_id;
      orgDiscount = org.discount_percent
        ? `${org.discount_percent}% off`
        : org.discount_amount_cents
          ? `$${org.discount_amount_cents / 100} off`
          : undefined;
    }

    logger.info(
      { lookupKey, orgId, contactEmail: memberEmail, hasCoupon: !!effectiveCouponId },
      'Addie: Sending invoice for signed-in member',
    );

    try {
      const result = await createAndSendInvoice({
        lookupKey,
        companyName: org.name,
        contactName,
        contactEmail: memberEmail,
        billingAddress: org.billing_address,
        couponId: effectiveCouponId,
        workosOrganizationId: orgId,
        daysUntilDue: paymentTerms,
      });

      if (!result) {
        return JSON.stringify({
          success: false,
          error: 'Failed to send invoice. Stripe may not be configured or the product was not found.',
        });
      }

      return JSON.stringify({
        success: true,
        invoice_id: result.invoiceId,
        invoice_url: result.invoiceUrl,
        discount_applied: result.discountApplied,
        discount_description: orgDiscount,
        discount_warning: result.discountWarning,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error sending invoice');
      const message = error instanceof Error ? error.message : 'Failed to send invoice. Please try again.';
      return JSON.stringify({
        success: false,
        error: message,
      });
    }
  });

  // Get billing portal link for existing members
  handlers.set('get_billing_portal', async (_input) => {
    const orgId = memberContext?.organization?.workos_organization_id;
    if (!orgId) {
      return JSON.stringify({
        success: false,
        error: 'You need to be signed in with a linked account to access billing. Visit https://agenticadvertising.org/dashboard/membership to manage your billing.',
      });
    }

    try {
      const org = await orgDb.getOrganization(orgId);
      const stripeCustomerId = org?.stripe_customer_id;

      if (!stripeCustomerId) {
        return JSON.stringify({
          success: false,
          error: 'No billing account found for your organization. If you have already paid, please contact finance@agenticadvertising.org for assistance.',
        });
      }

      const returnUrl = 'https://agenticadvertising.org/dashboard/membership';
      const portalUrl = await createCustomerPortalSession(stripeCustomerId, returnUrl);

      if (!portalUrl) {
        return JSON.stringify({
          success: false,
          error: 'Unable to create billing portal session. Please try again or contact finance@agenticadvertising.org.',
        });
      }

      return JSON.stringify({
        success: true,
        portal_url: portalUrl,
        message: 'Here is your billing portal link. You can view invoices, download receipts, update payment methods, and manage your subscription.',
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error creating billing portal session');
      return JSON.stringify({
        success: false,
        error: 'Failed to access billing portal. Please try again or contact finance@agenticadvertising.org.',
      });
    }
  });

  return handlers;
}
