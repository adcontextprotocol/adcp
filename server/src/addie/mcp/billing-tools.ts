/**
 * Addie Billing Tools
 *
 * Tools for Addie to help users with membership signup:
 * - Find appropriate membership products based on company type and size
 * - Generate payment links
 * - Send invoices
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
    description: `Create a Stripe checkout payment link for a membership product.
Use this after finding the right product to give the user a direct link to pay.
Returns a URL the user can click to complete payment.
The user must have an account (signed up at agenticadvertising.org) before a payment link can be created.
If the user doesn't have an account, tell them to sign up first.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        customer_email: {
          type: 'string',
          description: 'Customer email address (optional fallback — the authenticated user email is preferred and used automatically)',
        },
      },
      required: ['lookup_key'],
    },
  },
  {
    name: 'send_invoice',
    description: `Preview an invoice for a membership product so the customer can confirm before it is sent.
Use this when the customer needs to pay by invoice/PO instead of credit card.
This does NOT send the invoice — it returns the amount and billing email for confirmation.
After calling this, confirm the details with the customer, then call confirm_send_invoice with the same billing info to send it.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        company_name: {
          type: 'string',
          description: 'Company name for the invoice',
        },
        contact_name: {
          type: 'string',
          description: 'Contact person name',
        },
        contact_email: {
          type: 'string',
          description: 'Contact email address',
        },
        billing_address: {
          type: 'object',
          description: 'Billing address',
          properties: {
            line1: { type: 'string', description: 'Street address line 1' },
            line2: { type: 'string', description: 'Street address line 2 (optional)' },
            city: { type: 'string', description: 'City' },
            state: { type: 'string', description: 'State/Province' },
            postal_code: { type: 'string', description: 'Postal/ZIP code' },
            country: { type: 'string', description: 'Country code (e.g., US)' },
          },
          required: ['line1', 'city', 'state', 'postal_code', 'country'],
        },
        coupon_id: {
          type: 'string',
          description: 'Explicit Stripe coupon ID to apply (optional - org discount is used automatically if available)',
        },
      },
      required: ['lookup_key', 'company_name', 'contact_name', 'contact_email', 'billing_address'],
    },
  },
  {
    name: 'confirm_send_invoice',
    description: `Send an invoice after the customer has confirmed the billing details shown by send_invoice.
Use this only after the customer explicitly confirms the email address and amount are correct.
Pass the same billing information as send_invoice.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        company_name: {
          type: 'string',
          description: 'Company name for the invoice',
        },
        contact_name: {
          type: 'string',
          description: 'Contact person name',
        },
        contact_email: {
          type: 'string',
          description: 'Contact email address confirmed by the customer',
        },
        billing_address: {
          type: 'object',
          description: 'Billing address',
          properties: {
            line1: { type: 'string', description: 'Street address line 1' },
            line2: { type: 'string', description: 'Street address line 2 (optional)' },
            city: { type: 'string', description: 'City' },
            state: { type: 'string', description: 'State/Province' },
            postal_code: { type: 'string', description: 'Postal/ZIP code' },
            country: { type: 'string', description: 'Country code (e.g., US)' },
          },
          required: ['line1', 'city', 'state', 'postal_code', 'country'],
        },
        coupon_id: {
          type: 'string',
          description: 'Explicit Stripe coupon ID to apply (optional)',
        },
      },
      required: ['lookup_key', 'company_name', 'contact_name', 'contact_email', 'billing_address'],
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

  // Create payment link
  handlers.set('create_payment_link', async (input) => {
    const lookupKey = input.lookup_key as string;
    const customerEmail = input.customer_email as string | undefined;

    // Require org context to ensure the subscription gets linked
    const orgId = memberContext?.organization?.workos_organization_id;
    if (!orgId) {
      return JSON.stringify({
        success: false,
        error: 'Cannot create a payment link without an account. Please ask the user to sign up at https://agenticadvertising.org first, then try again.',
      });
    }

    // Use actual member email from context, falling back to AI-provided email.
    // This prevents hallucinated emails (e.g., user@example.com) from being used.
    const effectiveEmail = memberContext?.workos_user?.email
      || memberContext?.slack_user?.email
      || customerEmail;

    logger.info({ lookupKey, orgId, hasEmail: !!effectiveEmail }, 'Addie: Creating payment link');

    try {
      // First get the price ID from the lookup key
      const priceId = await getPriceByLookupKey(lookupKey);
      if (!priceId) {
        return JSON.stringify({
          success: false,
          error: `Product not found for lookup key: ${lookupKey}`,
        });
      }

      // Look up org to get Stripe customer ID and discount info
      const org = await orgDb.getOrganization(orgId);

      // Ensure a Stripe customer exists with org metadata before creating the
      // checkout session so that subscription webhooks can link the payment.
      let customerId: string | undefined;
      if (effectiveEmail) {
        customerId = await orgDb.getOrCreateStripeCustomer(orgId, () =>
          createStripeCustomer({
            email: effectiveEmail,
            name: org?.name || 'Unknown',
            metadata: { workos_organization_id: orgId },
          })
        ) || undefined;
      } else {
        customerId = org?.stripe_customer_id || undefined;
      }

      const session = await createCheckoutSession({
        priceId,
        customerId: customerId || undefined,
        customerEmail: customerId ? undefined : effectiveEmail,
        successUrl: 'https://agenticadvertising.org/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        cancelUrl: 'https://agenticadvertising.org/dashboard?checkout=cancelled',
        workosOrganizationId: orgId,
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
        message: 'Payment link created successfully. Share this URL with the customer.',
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

  // Preview invoice details for customer confirmation (no Stripe mutations)
  handlers.set('send_invoice', async (input) => {
    const lookupKey = input.lookup_key as string;
    const contactEmail = input.contact_email as string;
    const explicitCouponId = input.coupon_id as string | undefined;
    const companyName = input.company_name as string;

    // Use authenticated org context directly; fall back to name search for Slack-only users
    let effectiveCouponId = explicitCouponId;
    let orgDiscount: string | undefined;

    try {
      const orgId = memberContext?.organization?.workos_organization_id;
      const org = orgId
        ? await orgDb.getOrganization(orgId)
        : (await orgDb.searchOrganizations({ query: companyName, limit: 1 })
            .then(results => results.length > 0 ? orgDb.getOrganization(results[0].workos_organization_id) : null));

      if (org && !explicitCouponId && org.stripe_coupon_id) {
        effectiveCouponId = org.stripe_coupon_id;
        orgDiscount = org.discount_percent
          ? `${org.discount_percent}% off`
          : org.discount_amount_cents
            ? `$${org.discount_amount_cents / 100} off`
            : undefined;
        logger.info(
          { orgId: org.workos_organization_id, couponId: effectiveCouponId, discount: orgDiscount },
          'Addie: Using org stored discount for invoice preview'
        );
      }
    } catch (orgLookupError) {
      logger.debug({ error: orgLookupError }, 'Could not look up org discount for invoice preview');
    }

    logger.info({ lookupKey, contactEmail, hasCoupon: !!effectiveCouponId }, 'Addie: Previewing invoice');

    try {
      const preview = await validateInvoiceDetails({
        lookupKey,
        contactEmail,
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
        contact_email: contactEmail,
        product_name: preview.productName,
        discount_applied: preview.discountApplied,
        discount_description: orgDiscount,
        discount_warning: preview.discountWarning,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error previewing invoice');
      return JSON.stringify({
        success: false,
        error: 'Failed to preview invoice. Please try again.',
      });
    }
  });

  // Create and send invoice after customer confirms the details
  handlers.set('confirm_send_invoice', async (input) => {
    const lookupKey = input.lookup_key as string;
    const companyName = input.company_name as string;
    const contactName = input.contact_name as string;
    const contactEmail = input.contact_email as string;
    const billingAddress = input.billing_address as {
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postal_code: string;
      country: string;
    };
    const explicitCouponId = input.coupon_id as string | undefined;

    // Same org coupon lookup as send_invoice
    let effectiveCouponId = explicitCouponId;
    let orgDiscount: string | undefined;
    let workosOrgId: string | undefined;

    try {
      const orgId = memberContext?.organization?.workos_organization_id;
      const org = orgId
        ? await orgDb.getOrganization(orgId)
        : (await orgDb.searchOrganizations({ query: companyName, limit: 1 })
            .then(results => results.length > 0 ? orgDb.getOrganization(results[0].workos_organization_id) : null));

      if (org) {
        workosOrgId = org.workos_organization_id;
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
      logger.debug({ error: orgLookupError }, 'Could not look up org discount for invoice send');
    }

    logger.info({ lookupKey, contactEmail, companyName, hasCoupon: !!effectiveCouponId }, 'Addie: Sending confirmed invoice');

    try {
      const result = await createAndSendInvoice({
        lookupKey,
        companyName,
        contactName,
        contactEmail,
        billingAddress,
        couponId: effectiveCouponId,
        workosOrganizationId: workosOrgId,
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
      return JSON.stringify({
        success: false,
        error: 'Failed to send invoice. Please try again.',
      });
    }
  });

  return handlers;
}
