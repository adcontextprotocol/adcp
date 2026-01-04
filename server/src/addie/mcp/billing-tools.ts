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
import {
  getProductsForCustomer,
  createCheckoutSession,
  createAndSendInvoice,
  getPriceByLookupKey,
  type BillingProduct,
} from '../../billing/stripe-client.js';

const logger = createLogger('addie-billing-tools');

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
Returns a URL the user can click to complete payment.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        lookup_key: {
          type: 'string',
          description: 'The product lookup key from find_membership_products',
        },
        customer_email: {
          type: 'string',
          description: 'Customer email address (optional, will pre-fill checkout)',
        },
      },
      required: ['lookup_key'],
    },
  },
  {
    name: 'send_invoice',
    description: `Send an invoice for a membership product to a customer.
Use this when the customer needs to pay via invoice/PO instead of credit card.
Requires full billing information including address.`,
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
export function createBillingToolHandlers(): Map<string, (input: Record<string, unknown>) => Promise<string>> {
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

    logger.info({ lookupKey, hasEmail: !!customerEmail }, 'Addie: Creating payment link');

    try {
      // First get the price ID from the lookup key
      const priceId = await getPriceByLookupKey(lookupKey);
      if (!priceId) {
        return JSON.stringify({
          success: false,
          error: `Product not found for lookup key: ${lookupKey}`,
        });
      }

      const session = await createCheckoutSession({
        priceId,
        customerEmail,
        successUrl: 'https://agenticadvertising.org/dashboard?payment=success',
        cancelUrl: 'https://agenticadvertising.org/join?payment=cancelled',
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

  // Send invoice
  handlers.set('send_invoice', async (input) => {
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

    logger.info(
      { lookupKey, contactEmail, companyName },
      'Addie: Sending invoice'
    );

    try {
      const result = await createAndSendInvoice({
        lookupKey,
        companyName,
        contactName,
        contactEmail,
        billingAddress,
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
        message: `Invoice sent to ${contactEmail}. They will receive an email with payment instructions.`,
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
