/**
 * Addie Admin Tools
 *
 * Tools available only to admin users for looking up organization status,
 * pending invoices, and other administrative information.
 *
 * Admin users are determined by membership in the "aao-admin" working group.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import {
  getPendingInvoices,
  type PendingInvoice,
} from '../../billing/stripe-client.js';

const logger = createLogger('addie-admin-tools');
const orgDb = new OrganizationDatabase();
const slackDb = new SlackDatabase();
const wgDb = new WorkingGroupDatabase();

// The slug for the AAO admin working group
const AAO_ADMIN_WORKING_GROUP_SLUG = 'aao-admin';

/**
 * Check if a Slack user is an admin
 * Looks up their WorkOS user ID via Slack mapping and checks membership in aao-admin working group
 */
export async function isSlackUserAdmin(slackUserId: string): Promise<boolean> {
  try {
    // Look up the Slack user mapping to get their WorkOS user ID
    const mapping = await slackDb.getBySlackUserId(slackUserId);

    if (!mapping?.workos_user_id) {
      logger.debug({ slackUserId }, 'No WorkOS mapping for Slack user');
      return false;
    }

    // Get the aao-admin working group
    const adminGroup = await wgDb.getWorkingGroupBySlug(AAO_ADMIN_WORKING_GROUP_SLUG);

    if (!adminGroup) {
      logger.warn('AAO Admin working group not found');
      return false;
    }

    // Check if the user is a member of the admin working group
    const isAdmin = await wgDb.isMember(adminGroup.id, mapping.workos_user_id);

    logger.debug({ slackUserId, workosUserId: mapping.workos_user_id, isAdmin }, 'Checked admin status');
    return isAdmin;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error checking if Slack user is admin');
    return false;
  }
}

/**
 * Admin tool definitions
 */
export const ADMIN_TOOLS: AddieTool[] = [
  {
    name: 'lookup_organization',
    description: `Look up an organization by name to get their membership status, pending invoices, and other details.
Use this when an admin asks about a specific company's membership status.
Returns organization details including subscription status, pending invoices, and contact information.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        company_name: {
          type: 'string',
          description: 'The company name to search for (partial match supported)',
        },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'list_pending_invoices',
    description: `List all organizations with pending (unpaid) invoices.
Use this when an admin asks about outstanding invoices or payment status across organizations.
Returns a list of organizations with open or draft invoices.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
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
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format pending invoice for response
 */
function formatPendingInvoice(invoice: PendingInvoice): Record<string, unknown> {
  return {
    id: invoice.id,
    status: invoice.status,
    amount: formatCurrency(invoice.amount_due, invoice.currency),
    product: invoice.product_name || 'Unknown product',
    sent_to: invoice.customer_email || 'Unknown',
    created: formatDate(invoice.created),
    due_date: invoice.due_date ? formatDate(invoice.due_date) : 'Not set',
    payment_url: invoice.hosted_invoice_url || null,
  };
}

/**
 * Admin tool handler implementations
 */
export function createAdminToolHandlers(): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Lookup organization
  handlers.set('lookup_organization', async (input) => {
    const companyName = input.company_name as string;

    logger.info({ companyName }, 'Addie: Admin looking up organization');

    try {
      // Search for organizations matching the name
      const orgs = await orgDb.searchOrganizations({
        query: companyName,
        limit: 5,
      });

      if (orgs.length === 0) {
        return JSON.stringify({
          success: false,
          message: `No organizations found matching "${companyName}"`,
        });
      }

      // Get detailed info for each matching org
      const results = await Promise.all(
        orgs.map(async (org) => {
          const fullOrg = await orgDb.getOrganization(org.workos_organization_id);

          if (!fullOrg) {
            return {
              name: org.name,
              company_type: org.company_type,
              error: 'Could not load full details',
            };
          }

          // Get subscription info
          const subscriptionInfo = await orgDb.getSubscriptionInfo(fullOrg.workos_organization_id);

          // Get pending invoices if there's a Stripe customer
          let pendingInvoices: PendingInvoice[] = [];
          if (fullOrg.stripe_customer_id) {
            pendingInvoices = await getPendingInvoices(fullOrg.stripe_customer_id);
          }

          return {
            name: fullOrg.name,
            company_type: fullOrg.company_type,
            revenue_tier: fullOrg.revenue_tier,
            membership_status: subscriptionInfo?.status || 'none',
            subscription: subscriptionInfo?.status === 'active' ? {
              product: subscriptionInfo.product_name,
              renews: subscriptionInfo.current_period_end
                ? new Date(subscriptionInfo.current_period_end * 1000).toLocaleDateString()
                : 'Unknown',
              cancel_at_period_end: subscriptionInfo.cancel_at_period_end,
            } : null,
            pending_invoices: pendingInvoices.map(formatPendingInvoice),
            has_stripe_customer: !!fullOrg.stripe_customer_id,
            agreement_signed: !!fullOrg.agreement_signed_at,
            created: formatDate(fullOrg.created_at),
          };
        })
      );

      return JSON.stringify({
        success: true,
        organizations: results,
        message: `Found ${results.length} organization(s) matching "${companyName}"`,
      });
    } catch (error) {
      logger.error({ error, companyName }, 'Addie: Error looking up organization');
      return JSON.stringify({
        success: false,
        error: 'Failed to look up organization. Please try again.',
      });
    }
  });

  // List pending invoices across all orgs
  handlers.set('list_pending_invoices', async (input) => {
    const limit = (input.limit as number) || 10;

    logger.info({ limit }, 'Addie: Admin listing pending invoices');

    try {
      // Get all organizations with Stripe customers
      const allOrgs = await orgDb.listOrganizations();
      const orgsWithStripe = allOrgs.filter(org => org.stripe_customer_id);

      const orgsWithPendingInvoices: Array<{
        name: string;
        invoices: ReturnType<typeof formatPendingInvoice>[];
      }> = [];

      // Check each org for pending invoices
      for (const org of orgsWithStripe) {
        if (!org.stripe_customer_id) continue;

        const pendingInvoices = await getPendingInvoices(org.stripe_customer_id);

        if (pendingInvoices.length > 0) {
          orgsWithPendingInvoices.push({
            name: org.name,
            invoices: pendingInvoices.map(formatPendingInvoice),
          });
        }

        // Stop if we've found enough
        if (orgsWithPendingInvoices.length >= limit) {
          break;
        }
      }

      if (orgsWithPendingInvoices.length === 0) {
        return JSON.stringify({
          success: true,
          message: 'No pending invoices found across all organizations.',
          organizations: [],
        });
      }

      const totalInvoices = orgsWithPendingInvoices.reduce(
        (sum, org) => sum + org.invoices.length,
        0
      );

      return JSON.stringify({
        success: true,
        message: `Found ${totalInvoices} pending invoice(s) across ${orgsWithPendingInvoices.length} organization(s)`,
        organizations: orgsWithPendingInvoices,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error listing pending invoices');
      return JSON.stringify({
        success: false,
        error: 'Failed to list pending invoices. Please try again.',
      });
    }
  });

  return handlers;
}
