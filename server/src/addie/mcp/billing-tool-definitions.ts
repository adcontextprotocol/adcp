// BILLING_TOOLS: the tool definitions of billing-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
    description: `Get a link to the Stripe Customer Portal where an organization owner or admin can view invoices, download receipts, update payment methods, and manage the subscription.
Use this when an owner or admin asks about receipts, invoices, billing history, payment methods, or subscription management.
The user must be signed in and have an active owner or admin role in the selected organization.`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
