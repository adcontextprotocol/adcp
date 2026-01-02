/**
 * Addie Admin Tools
 *
 * Tools available only to admin users for:
 * - Looking up organization status and pending invoices
 * - Managing prospects and enrichment
 *
 * Admin users are determined by:
 * - Slack users: membership in the "aao-admin" working group
 * - Web users: org_membership.role === 'admin'
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { getPool } from '../../db/client.js';
import {
  getPendingInvoices,
  type PendingInvoice,
} from '../../billing/stripe-client.js';
import {
  enrichOrganization,
  enrichDomain,
} from '../../services/enrichment.js';
import {
  getLushaClient,
  isLushaConfigured,
  mapIndustryToCompanyType,
} from '../../services/lusha.js';
import { createProspect } from '../../services/prospect.js';
import {
  getAllFeedsWithStats,
  addFeed,
  getFeedStats,
  type FeedWithStats,
} from '../../db/industry-feeds-db.js';

const logger = createLogger('addie-admin-tools');
const orgDb = new OrganizationDatabase();
const slackDb = new SlackDatabase();
const wgDb = new WorkingGroupDatabase();

// The slug for the AAO admin working group
const AAO_ADMIN_WORKING_GROUP_SLUG = 'aao-admin';

// Cache for admin status checks - admin status rarely changes
const ADMIN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const adminStatusCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

/**
 * Check if a Slack user is an admin
 * Looks up their WorkOS user ID via Slack mapping and checks membership in aao-admin working group
 * Results are cached for 30 minutes to reduce DB load
 */
export async function isSlackUserAdmin(slackUserId: string): Promise<boolean> {
  // Check cache first
  const cached = adminStatusCache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isAdmin;
  }

  try {
    // Look up the Slack user mapping to get their WorkOS user ID
    const mapping = await slackDb.getBySlackUserId(slackUserId);

    if (!mapping?.workos_user_id) {
      logger.debug({ slackUserId }, 'No WorkOS mapping for Slack user');
      adminStatusCache.set(slackUserId, { isAdmin: false, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });
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

    // Cache the result
    adminStatusCache.set(slackUserId, { isAdmin, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });

    logger.debug({ slackUserId, workosUserId: mapping.workos_user_id, isAdmin }, 'Checked admin status');
    return isAdmin;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error checking if Slack user is admin');
    return false;
  }
}

/**
 * Invalidate admin status cache for a user (call when admin membership changes)
 */
export function invalidateAdminStatusCache(slackUserId?: string): void {
  if (slackUserId) {
    adminStatusCache.delete(slackUserId);
  } else {
    adminStatusCache.clear();
  }
}

/**
 * Check if a web user has admin privileges (via member context)
 */
export function isAdmin(memberContext: MemberContext | null): boolean {
  return memberContext?.org_membership?.role === 'admin';
}

/**
 * Admin tool definitions - includes both billing/invoice tools and prospect management tools
 */
export const ADMIN_TOOLS: AddieTool[] = [
  // ============================================
  // BILLING & INVOICE TOOLS
  // ============================================
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
  {
    name: 'get_organization_details',
    description: `Get comprehensive details about an organization including Slack activity, working group participation, engagement signals, enrichment data, and membership status.

USE THIS for questions like:
- "How many Slack users does [company] have?"
- "Which working groups is [company] in?"
- "What do we know about [company]?"
- "Has [company] signed up yet?"
- "How engaged is [company]?"
- "What's the status of [company]?"

Returns: Slack user count and activity, working groups, engagement level and signals, enrichment data (industry, revenue, employees), prospect status, and membership/subscription status.`,
    usage_hints: 'Use this for ANY question about a specific organization beyond just "is it a prospect". This gives you the full picture.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Company name or domain to look up (e.g., "Boltive" or "boltive.com")',
        },
      },
      required: ['query'],
    },
  },

  // ============================================
  // PROSPECT MANAGEMENT TOOLS
  // ============================================
  {
    name: 'add_prospect',
    description:
      'Add a new prospect organization to track. Use this after find_prospect confirms the company does not exist. Capture as much info as possible: name, domain, contact details, and notes about their interest.',
    usage_hints: 'Always use find_prospect first to check if company exists. Include champion info in notes (e.g., "Champion: Jane Doe, VP Sales").',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Company name (e.g., "Boltive")',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Type of company (adtech, agency, brand, publisher, or other)',
        },
        domain: {
          type: 'string',
          description: 'Company domain (e.g., "boltive.com"). Highly recommended for enrichment and deduplication.',
        },
        contact_name: {
          type: 'string',
          description: 'Primary contact/champion name (e.g., "Pamela Slea")',
        },
        contact_email: {
          type: 'string',
          description: 'Primary contact email',
        },
        contact_title: {
          type: 'string',
          description: 'Primary contact job title (e.g., "President", "VP Engineering")',
        },
        notes: {
          type: 'string',
          description: 'Notes about the prospect - include champion info, their interest areas, which working groups they want to join, etc.',
        },
        source: {
          type: 'string',
          description: 'How we found this prospect (e.g., "slack_conversation", "referral", "conference")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_prospect',
    description:
      'Search for existing prospects by name or domain. USE THIS FIRST whenever an admin mentions any company - check if they already exist before offering to add them. Searches both company names and email domains.',
    usage_hints: 'Always use this before add_prospect. When an admin says "check on [company]" or mentions any company name, use this tool first.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - company name or domain (e.g., "Boltive" or "boltive.com")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'update_prospect',
    description:
      'Update information about an existing prospect. Use this to add notes, change status, or update contact info.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Organization ID to update',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Type of company',
        },
        status: {
          type: 'string',
          enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'],
          description: 'Prospect status',
        },
        contact_name: {
          type: 'string',
          description: 'Primary contact name',
        },
        contact_email: {
          type: 'string',
          description: 'Primary contact email',
        },
        notes: {
          type: 'string',
          description: 'Notes to append (will be added with timestamp)',
        },
        domain: {
          type: 'string',
          description: 'Company domain for enrichment',
        },
      },
      required: ['org_id'],
    },
  },
  {
    name: 'enrich_company',
    description:
      'Research a company using Lusha to get firmographic data (revenue, employee count, industry, etc.). Can be used with a domain or company name.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'Company domain to research (e.g., "thetradedesk.com")',
        },
        company_name: {
          type: 'string',
          description: 'Company name to search for (used if domain not provided)',
        },
        org_id: {
          type: 'string',
          description: 'If provided, save enrichment data to this organization',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_prospects',
    description:
      'List prospects with optional filtering. Use this to see recent prospects, find ones that need attention, or get an overview.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'],
          description: 'Filter by status',
        },
        company_type: {
          type: 'string',
          enum: ['adtech', 'agency', 'brand', 'publisher', 'other'],
          description: 'Filter by company type',
        },
        limit: {
          type: 'number',
          description: 'Maximum number to return (default 10, max 50)',
        },
        sort: {
          type: 'string',
          enum: ['recent', 'name', 'activity'],
          description: 'Sort order: recent (newest first), name (alphabetical), activity (most recent activity)',
        },
      },
      required: [],
    },
  },
  {
    name: 'prospect_search_lusha',
    description:
      'Search Lusha\'s database for potential prospects matching criteria. Use this to find new companies to reach out to based on industry, size, or location.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to search for (e.g., ["programmatic", "DSP", "ad tech"])',
        },
        industries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Industry categories (e.g., ["Advertising", "Marketing", "Media"])',
        },
        min_employees: {
          type: 'number',
          description: 'Minimum employee count',
        },
        max_employees: {
          type: 'number',
          description: 'Maximum employee count',
        },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Countries to include (e.g., ["United States", "United Kingdom"])',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 10)',
        },
      },
      required: [],
    },
  },

  // ============================================
  // INDUSTRY FEED MANAGEMENT TOOLS
  // ============================================
  {
    name: 'search_industry_feeds',
    description:
      'Search and list RSS industry feeds. Use this to find feeds by name, URL, or category, or to see feeds with errors that need attention.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - feed name, URL, or category (optional)',
        },
        status: {
          type: 'string',
          enum: ['all', 'active', 'inactive', 'errors'],
          description: 'Filter by status: all, active, inactive, or errors (feeds with fetch errors)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'add_industry_feed',
    description:
      'Add a new RSS feed to monitor for industry news. Provide the feed URL and a name.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the feed (e.g., "AdExchanger", "Digiday")',
        },
        feed_url: {
          type: 'string',
          description: 'RSS feed URL (e.g., "https://www.adexchanger.com/feed/")',
        },
        category: {
          type: 'string',
          enum: ['ad-tech', 'advertising', 'marketing', 'media', 'tech'],
          description: 'Category for the feed',
        },
      },
      required: ['name', 'feed_url'],
    },
  },
  {
    name: 'get_feed_stats',
    description:
      'Get statistics about industry feeds - total feeds, active feeds, articles collected, processing status, etc.',
    input_schema: {
      type: 'object',
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
 * Includes both billing/invoice tools and prospect management tools
 */
export function createAdminToolHandlers(
  memberContext?: MemberContext | null
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  // Helper for prospect tools that need member context for admin check
  const requireAdminFromContext = (): string | null => {
    if (memberContext && !isAdmin(memberContext)) {
      return '⚠️ This tool requires admin access. If you believe you should have admin access, please contact your organization administrator.';
    }
    return null;
  };

  // ============================================
  // BILLING & INVOICE HANDLERS
  // ============================================

  // Lookup organization
  handlers.set('lookup_organization', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

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
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

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

  // Get comprehensive organization details
  handlers.set('get_organization_details', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const query = input.query as string;
    const searchPattern = `%${query}%`;

    try {
      // Find organizations by name or domain - get up to 5 matches
      const result = await pool.query(
        `SELECT o.*,
                p.name as parent_name
         FROM organizations o
         LEFT JOIN organizations p ON o.parent_organization_id = p.workos_organization_id
         WHERE o.is_personal = false
           AND (LOWER(o.name) LIKE LOWER($1) OR LOWER(o.email_domain) LIKE LOWER($1))
         ORDER BY
           CASE WHEN LOWER(o.name) = LOWER($2) THEN 0
                WHEN LOWER(o.name) LIKE LOWER($3) THEN 1
                ELSE 2 END,
           o.updated_at DESC
         LIMIT 5`,
        [searchPattern, query, `${query}%`]
      );

      if (result.rows.length === 0) {
        return `No organization found matching "${query}". Try searching by company name or domain.`;
      }

      // If multiple matches, present options to the user
      if (result.rows.length > 1) {
        let response = `## Found ${result.rows.length} organizations matching "${query}"\n\n`;
        response += `Which one would you like to know more about?\n\n`;

        for (let i = 0; i < result.rows.length; i++) {
          const org = result.rows[i];
          response += `**${i + 1}. ${org.name}**\n`;
          if (org.email_domain) response += `   Domain: ${org.email_domain}\n`;
          if (org.company_type) response += `   Type: ${org.company_type}\n`;
          if (org.subscription_status === 'active') {
            response += `   Status: ✅ Member\n`;
          } else if (org.prospect_status) {
            response += `   Status: 📋 Prospect (${org.prospect_status})\n`;
          }
          response += `\n`;
        }

        response += `_Reply with the company name or number for full details._`;
        return response;
      }

      const org = result.rows[0];
      const orgId = org.workos_organization_id;

      // Gather all the data in parallel
      const [
        slackUsersResult,
        slackActivityResult,
        workingGroupsResult,
        activitiesResult,
        engagementSignals,
      ] = await Promise.all([
        // Slack users count for this org
        pool.query(
          `SELECT COUNT(DISTINCT sm.slack_user_id) as slack_user_count
           FROM slack_user_mappings sm
           JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
           WHERE om.workos_organization_id = $1
             AND sm.mapping_status = 'mapped'`,
          [orgId]
        ),
        // Slack activity (last 30 days)
        pool.query(
          `SELECT
             COUNT(DISTINCT sad.slack_user_id) as active_users,
             SUM(sad.message_count) as messages,
             SUM(sad.reaction_count) as reactions,
             SUM(sad.thread_reply_count) as thread_replies
           FROM slack_activity_daily sad
           WHERE sad.organization_id = $1
             AND sad.activity_date >= CURRENT_DATE - INTERVAL '30 days'`,
          [orgId]
        ),
        // Working groups
        pool.query(
          `SELECT DISTINCT wg.name, wg.slug, wgm.status, wgm.joined_at
           FROM working_group_memberships wgm
           JOIN working_groups wg ON wgm.working_group_id = wg.id
           WHERE wgm.workos_organization_id = $1 AND wgm.status = 'active'`,
          [orgId]
        ),
        // Recent activities
        pool.query(
          `SELECT activity_type, description, activity_date, logged_by_name
           FROM org_activities
           WHERE organization_id = $1
           ORDER BY activity_date DESC
           LIMIT 5`,
          [orgId]
        ),
        // Engagement signals
        orgDb.getEngagementSignals(orgId),
      ]);

      const slackUserCount = parseInt(slackUsersResult.rows[0]?.slack_user_count || '0');
      const slackActivity = slackActivityResult.rows[0] || { active_users: 0, messages: 0, reactions: 0, thread_replies: 0 };
      const workingGroups = workingGroupsResult.rows;
      const recentActivities = activitiesResult.rows;

      // Build comprehensive response
      let response = `## ${org.name}\n\n`;

      // Basic info
      if (org.company_type) response += `**Type:** ${org.company_type}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
      if (org.parent_name) response += `**Parent:** ${org.parent_name}\n`;
      response += '\n';

      // Membership status
      response += `### Membership Status\n`;
      if (org.subscription_status === 'active') {
        response += `✅ **Active Member** - ${org.subscription_product_name || 'Subscription'}\n`;
        if (org.subscription_current_period_end) {
          response += `   Renews: ${formatDate(new Date(org.subscription_current_period_end))}\n`;
        }
      } else if (org.prospect_status) {
        const statusEmojiMap: Record<string, string> = {
          prospect: '🔍',
          contacted: '📧',
          responded: '💬',
          interested: '⭐',
          negotiating: '🤝',
          declined: '❌',
        };
        const statusEmoji = statusEmojiMap[org.prospect_status as string] || '📋';
        response += `${statusEmoji} **Prospect** - Status: ${org.prospect_status}\n`;
        if (org.prospect_contact_name) {
          response += `   Contact: ${org.prospect_contact_name}`;
          if (org.prospect_contact_title) response += ` (${org.prospect_contact_title})`;
          response += '\n';
        }
      } else {
        response += `⚪ Not a member yet\n`;
      }
      response += '\n';

      // Slack presence
      response += `### Slack Presence\n`;
      response += `**Users in Slack:** ${slackUserCount}\n`;
      if (slackActivity.active_users > 0) {
        response += `**Active (30d):** ${slackActivity.active_users} users\n`;
        response += `**Messages (30d):** ${slackActivity.messages || 0}\n`;
        response += `**Reactions (30d):** ${slackActivity.reactions || 0}\n`;
      } else {
        response += `_No Slack activity in the last 30 days_\n`;
      }
      response += '\n';

      // Working groups
      response += `### Working Groups\n`;
      if (workingGroups.length > 0) {
        for (const wg of workingGroups) {
          response += `- ${wg.name} (joined ${formatDate(new Date(wg.joined_at))})\n`;
        }
      } else {
        response += `_Not participating in any working groups_\n`;
      }
      response += '\n';

      // Engagement
      response += `### Engagement\n`;
      const engagementLabels = ['', 'Low', 'Some', 'Moderate', 'High', 'Very High'];
      let engagementLevel = 1;
      if (engagementSignals.interest_level === 'very_high') engagementLevel = 5;
      else if (engagementSignals.interest_level === 'high') engagementLevel = 4;
      else if (engagementSignals.working_group_count > 0) engagementLevel = 4;
      else if (engagementSignals.has_member_profile) engagementLevel = 4;
      else if (engagementSignals.login_count_30d > 3) engagementLevel = 3;
      else if (slackUserCount > 0) engagementLevel = 3;
      else if (engagementSignals.login_count_30d > 0) engagementLevel = 2;

      response += `**Level:** ${engagementLabels[engagementLevel]} (${engagementLevel}/5)\n`;
      if (engagementSignals.interest_level) {
        response += `**Interest:** ${engagementSignals.interest_level}`;
        if (engagementSignals.interest_level_set_by) response += ` (set by ${engagementSignals.interest_level_set_by})`;
        if (engagementSignals.interest_level_note) response += `\n   Note: "${engagementSignals.interest_level_note}"`;
        response += '\n';
      }
      if (engagementSignals.login_count_30d > 0) {
        response += `**Dashboard logins (30d):** ${engagementSignals.login_count_30d}\n`;
      }
      response += '\n';

      // Enrichment data
      if (org.enrichment_at) {
        response += `### Company Info (Enriched)\n`;
        if (org.enrichment_industry) response += `**Industry:** ${org.enrichment_industry}\n`;
        if (org.enrichment_sub_industry) response += `**Sub-industry:** ${org.enrichment_sub_industry}\n`;
        if (org.enrichment_employee_count) response += `**Employees:** ${org.enrichment_employee_count.toLocaleString()}\n`;
        if (org.enrichment_revenue_range) response += `**Revenue:** ${org.enrichment_revenue_range}\n`;
        if (org.enrichment_country) response += `**Location:** ${org.enrichment_city ? org.enrichment_city + ', ' : ''}${org.enrichment_country}\n`;
        if (org.enrichment_description) response += `**About:** ${org.enrichment_description}\n`;
        response += '\n';
      }

      // Recent activities
      if (recentActivities.length > 0) {
        response += `### Recent Activity\n`;
        for (const activity of recentActivities) {
          const date = formatDate(new Date(activity.activity_date));
          response += `- ${date}: ${activity.activity_type}`;
          if (activity.description) response += ` - ${activity.description}`;
          if (activity.logged_by_name) response += ` (${activity.logged_by_name})`;
          response += '\n';
        }
        response += '\n';
      }

      // Prospect notes
      if (org.prospect_notes) {
        response += `### Notes\n${org.prospect_notes}\n`;
      }

      return response;
    } catch (error) {
      logger.error({ error, query }, 'Addie: Error getting organization details');
      return `❌ Failed to get organization details. Please try again or contact support.`;
    }
  });

  // ============================================
  // PROSPECT MANAGEMENT HANDLERS
  // ============================================

  // Add prospect
  handlers.set('add_prospect', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const name = input.name as string;
    const companyType = (input.company_type as string) || undefined;
    const domain = input.domain as string | undefined;
    const contactName = input.contact_name as string | undefined;
    const contactEmail = input.contact_email as string | undefined;
    const contactTitle = input.contact_title as string | undefined;
    const notes = input.notes as string | undefined;
    const source = (input.source as string) || 'addie_conversation';

    // Use the centralized prospect service (creates real WorkOS org)
    const result = await createProspect({
      name,
      domain,
      company_type: companyType,
      prospect_source: source,
      prospect_notes: notes,
      prospect_contact_name: contactName,
      prospect_contact_email: contactEmail,
      prospect_contact_title: contactTitle,
    });

    if (!result.success) {
      if (result.alreadyExists && result.organization) {
        return `⚠️ A company named "${result.organization.name}" already exists (ID: ${result.organization.workos_organization_id}). Use find_prospect to see details or update_prospect to modify.`;
      }
      return `❌ Failed to create prospect: ${result.error}`;
    }

    const org = result.organization!;
    let response = `✅ Added **${org.name}** as a new prospect!\n\n`;
    if (org.company_type) response += `**Type:** ${org.company_type}\n`;
    if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
    if (contactName) {
      response += `**Contact:** ${contactName}`;
      if (contactTitle) response += ` (${contactTitle})`;
      response += `\n`;
    }
    if (contactEmail) response += `**Email:** ${contactEmail}\n`;
    response += `**Status:** ${org.prospect_status}\n`;
    response += `**ID:** ${org.workos_organization_id}\n`;

    if (domain && isLushaConfigured()) {
      response += `\n_Enriching company data in background..._`;
    }

    return response;
  });

  // Find prospect
  handlers.set('find_prospect', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const query = input.query as string;
    const searchPattern = `%${query}%`;

    const result = await pool.query(
      `SELECT workos_organization_id, name, company_type, email_domain,
              prospect_status, prospect_source, prospect_contact_name,
              enrichment_at, enrichment_industry, enrichment_revenue, enrichment_employee_count,
              created_at, updated_at
       FROM organizations
       WHERE is_personal = false
         AND (LOWER(name) LIKE LOWER($1) OR LOWER(email_domain) LIKE LOWER($1))
       ORDER BY
         CASE WHEN LOWER(name) = LOWER($2) THEN 0
              WHEN LOWER(name) LIKE LOWER($3) THEN 1
              ELSE 2 END,
         updated_at DESC
       LIMIT 10`,
      [searchPattern, query, `${query}%`]
    );

    if (result.rows.length === 0) {
      return `No prospects found matching "${query}". Would you like me to add them as a new prospect?`;
    }

    let response = `## Found ${result.rows.length} match${result.rows.length === 1 ? '' : 'es'} for "${query}"\n\n`;

    for (const org of result.rows) {
      response += `### ${org.name}\n`;
      response += `**ID:** ${org.workos_organization_id}\n`;
      response += `**Type:** ${org.company_type || 'Not set'}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
      response += `**Status:** ${org.prospect_status || 'unknown'}\n`;
      if (org.prospect_contact_name) response += `**Contact:** ${org.prospect_contact_name}\n`;
      if (org.enrichment_industry) response += `**Industry:** ${org.enrichment_industry}\n`;
      if (org.enrichment_employee_count) response += `**Employees:** ${org.enrichment_employee_count.toLocaleString()}\n`;
      if (org.enrichment_revenue) response += `**Revenue:** $${(org.enrichment_revenue / 1000000).toFixed(1)}M\n`;
      response += `**Created:** ${new Date(org.created_at).toLocaleDateString()}\n`;
      response += `\n`;
    }

    return response;
  });

  // Update prospect
  handlers.set('update_prospect', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const orgId = input.org_id as string;

    // Verify org exists
    const existing = await pool.query(
      `SELECT name, prospect_notes FROM organizations WHERE workos_organization_id = $1`,
      [orgId]
    );

    if (existing.rows.length === 0) {
      return `❌ Organization not found with ID: ${orgId}`;
    }

    const orgName = existing.rows[0].name;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.company_type) {
      updates.push(`company_type = $${paramIndex++}`);
      values.push(input.company_type);
    }
    if (input.status) {
      updates.push(`prospect_status = $${paramIndex++}`);
      values.push(input.status);
    }
    if (input.contact_name) {
      updates.push(`prospect_contact_name = $${paramIndex++}`);
      values.push(input.contact_name);
    }
    if (input.contact_email) {
      updates.push(`prospect_contact_email = $${paramIndex++}`);
      values.push(input.contact_email);
    }
    if (input.domain) {
      updates.push(`email_domain = $${paramIndex++}`);
      values.push(input.domain);
    }
    if (input.notes) {
      // Append to existing notes with timestamp
      const timestamp = new Date().toISOString().split('T')[0];
      const existingNotes = existing.rows[0].prospect_notes || '';
      const newNotes = existingNotes
        ? `${existingNotes}\n\n[${timestamp}] ${input.notes}`
        : `[${timestamp}] ${input.notes}`;
      updates.push(`prospect_notes = $${paramIndex++}`);
      values.push(newNotes);
    }

    if (updates.length === 0) {
      return `No updates provided. Specify at least one field to update (company_type, status, contact_name, contact_email, domain, notes).`;
    }

    updates.push(`updated_at = NOW()`);
    values.push(orgId);

    await pool.query(
      `UPDATE organizations SET ${updates.join(', ')} WHERE workos_organization_id = $${paramIndex}`,
      values
    );

    let response = `✅ Updated **${orgName}**\n\n`;
    if (input.company_type) response += `• Company type → ${input.company_type}\n`;
    if (input.status) response += `• Status → ${input.status}\n`;
    if (input.contact_name) response += `• Contact → ${input.contact_name}\n`;
    if (input.contact_email) response += `• Email → ${input.contact_email}\n`;
    if (input.domain) response += `• Domain → ${input.domain}\n`;
    if (input.notes) response += `• Added note: "${input.notes}"\n`;

    // Trigger enrichment if domain was added
    if (input.domain && isLushaConfigured()) {
      response += `\n_Enriching with new domain..._`;
      enrichOrganization(orgId, input.domain as string).catch(err => {
        logger.warn({ err, orgId }, 'Background enrichment failed after update');
      });
    }

    return response;
  });

  // Enrich company
  handlers.set('enrich_company', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    if (!isLushaConfigured()) {
      return '❌ Enrichment is not configured (LUSHA_API_KEY not set).';
    }

    const domain = input.domain as string | undefined;
    const companyName = input.company_name as string | undefined;
    const orgId = input.org_id as string | undefined;

    if (!domain && !companyName) {
      return 'Please provide either a domain or company_name to research.';
    }

    let response = '';

    // If we have an org_id, enrich and save
    if (orgId && domain) {
      const result = await enrichOrganization(orgId, domain);
      if (result.success && result.data) {
        response = `## Enrichment Results for ${domain}\n\n`;
        response += `**Company:** ${result.data.companyName || 'Unknown'}\n`;
        if (result.data.industry) response += `**Industry:** ${result.data.industry}\n`;
        if (result.data.employeeCount) response += `**Employees:** ${result.data.employeeCount.toLocaleString()}\n`;
        if (result.data.revenueRange) response += `**Revenue:** ${result.data.revenueRange}\n`;
        if (result.data.suggestedCompanyType) response += `**Suggested Type:** ${result.data.suggestedCompanyType}\n`;
        response += `\n✅ Data saved to organization ${orgId}`;
      } else {
        response = `❌ Could not enrich ${domain}: ${result.error || 'Unknown error'}`;
      }
    } else if (domain) {
      // Just research without saving
      const result = await enrichDomain(domain);
      if (result.success && result.data) {
        response = `## Research Results for ${domain}\n\n`;
        response += `**Company:** ${result.data.companyName || 'Unknown'}\n`;
        if (result.data.industry) response += `**Industry:** ${result.data.industry}\n`;
        if (result.data.employeeCount) response += `**Employees:** ${result.data.employeeCount.toLocaleString()}\n`;
        if (result.data.revenueRange) response += `**Revenue:** ${result.data.revenueRange}\n`;
        if (result.data.suggestedCompanyType) response += `**Suggested Type:** ${result.data.suggestedCompanyType}\n`;
        response += `\n_To save this data, provide an org_id or add as new prospect._`;
      } else {
        response = `❌ Could not find information for ${domain}: ${result.error || 'Unknown error'}`;
      }
    } else if (companyName) {
      // Search by company name using Lusha
      const lusha = getLushaClient();
      if (!lusha) {
        return '❌ Lusha client not available.';
      }

      const searchResult = await lusha.searchCompanies(
        { keywords: [companyName] },
        1,
        5
      );

      if (searchResult.success && searchResult.companies && searchResult.companies.length > 0) {
        response = `## Search Results for "${companyName}"\n\n`;
        for (const company of searchResult.companies) {
          response += `### ${company.companyName}\n`;
          if (company.domain) response += `**Domain:** ${company.domain}\n`;
          if (company.mainIndustry) response += `**Industry:** ${company.mainIndustry}\n`;
          if (company.employeeCount) response += `**Employees:** ${company.employeeCount.toLocaleString()}\n`;
          if (company.country) response += `**Country:** ${company.country}\n`;
          response += `\n`;
        }
        response += `_Use enrich_company with a specific domain to get full details._`;
      } else {
        response = `No results found for "${companyName}" in Lusha's database.`;
      }
    }

    return response;
  });

  // List prospects
  handlers.set('list_prospects', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const status = input.status as string | undefined;
    const companyType = input.company_type as string | undefined;
    const limit = Math.min(Math.max((input.limit as number) || 10, 1), 50);
    const sort = (input.sort as string) || 'recent';

    const conditions: string[] = ['is_personal = false', "prospect_status IS NOT NULL"];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`prospect_status = $${paramIndex++}`);
      values.push(status);
    }
    if (companyType) {
      conditions.push(`company_type = $${paramIndex++}`);
      values.push(companyType);
    }

    let orderBy = 'created_at DESC';
    if (sort === 'name') orderBy = 'name ASC';
    if (sort === 'activity') orderBy = 'COALESCE(last_activity_at, created_at) DESC';

    values.push(limit);

    const result = await pool.query(
      `SELECT workos_organization_id, name, company_type, email_domain,
              prospect_status, prospect_contact_name, enrichment_industry, enrichment_employee_count,
              created_at, updated_at
       FROM organizations
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT $${paramIndex}`,
      values
    );

    if (result.rows.length === 0) {
      return `No prospects found${status ? ` with status "${status}"` : ''}${companyType ? ` of type "${companyType}"` : ''}.`;
    }

    let response = `## Prospects`;
    if (status) response += ` (${status})`;
    if (companyType) response += ` - ${companyType}`;
    response += `\n\n`;

    for (const org of result.rows) {
      const typeEmoji = {
        adtech: '🔧',
        agency: '🏢',
        brand: '🏷️',
        publisher: '📰',
        other: '📋',
      }[org.company_type as string] || '📋';

      response += `${typeEmoji} **${org.name}**`;
      if (org.prospect_status !== 'prospect') {
        response += ` (${org.prospect_status})`;
      }
      response += `\n`;
      if (org.prospect_contact_name) {
        response += `   Contact: ${org.prospect_contact_name}\n`;
      }
      if (org.enrichment_industry) {
        response += `   Industry: ${org.enrichment_industry}\n`;
      }
    }

    response += `\n_Showing ${result.rows.length} of ${limit} max. Use find_prospect for details._`;

    return response;
  });

  // Search Lusha for prospects
  handlers.set('prospect_search_lusha', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    if (!isLushaConfigured()) {
      return '❌ Lusha is not configured (LUSHA_API_KEY not set).';
    }

    const lusha = getLushaClient();
    if (!lusha) {
      return '❌ Lusha client not available.';
    }

    const keywords = input.keywords as string[] | undefined;
    const limit = Math.min((input.limit as number) || 10, 25);

    const filters: Record<string, unknown> = {};
    if (keywords) filters.keywords = keywords;
    if (input.min_employees) filters.minEmployees = input.min_employees;
    if (input.max_employees) filters.maxEmployees = input.max_employees;
    if (input.countries) filters.countries = input.countries;

    const result = await lusha.searchCompanies(filters, 1, limit);

    if (!result.success || !result.companies || result.companies.length === 0) {
      return `No companies found matching your criteria. Try broadening your search.`;
    }

    let response = `## Lusha Search Results\n\n`;
    response += `Found ${result.total || result.companies.length} companies:\n\n`;

    for (const company of result.companies) {
      response += `### ${company.companyName}\n`;
      if (company.domain) response += `**Domain:** ${company.domain}\n`;
      if (company.mainIndustry) response += `**Industry:** ${company.mainIndustry}\n`;
      if (company.employeeCount) response += `**Employees:** ${company.employeeCount.toLocaleString()}\n`;
      if (company.country) response += `**Location:** ${company.country}\n`;

      const suggestedType = mapIndustryToCompanyType(company.mainIndustry || '', company.subIndustry || '');
      if (suggestedType) response += `**Suggested Type:** ${suggestedType}\n`;

      response += `\n`;
    }

    response += `\n_Use add_prospect to add any of these companies to your prospect list._`;

    return response;
  });

  // ============================================
  // INDUSTRY FEED MANAGEMENT HANDLERS
  // ============================================

  // Search industry feeds
  handlers.set('search_industry_feeds', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const query = (input.query as string)?.toLowerCase().trim() || '';
    const status = (input.status as string) || 'all';
    const limit = Math.min(Math.max((input.limit as number) || 10, 1), 50);

    try {
      const allFeeds = await getAllFeedsWithStats();

      // Filter feeds based on criteria
      let filtered = allFeeds;

      // Apply status filter
      if (status === 'active') {
        filtered = filtered.filter(f => f.is_active);
      } else if (status === 'inactive') {
        filtered = filtered.filter(f => !f.is_active);
      } else if (status === 'errors') {
        filtered = filtered.filter(f => f.error_count > 0);
      }

      // Apply search query
      if (query) {
        filtered = filtered.filter(f =>
          f.name.toLowerCase().includes(query) ||
          (f.feed_url || '').toLowerCase().includes(query) ||
          (f.category || '').toLowerCase().includes(query)
        );
      }

      // Limit results
      const results = filtered.slice(0, limit);

      if (results.length === 0) {
        let msg = 'No feeds found';
        if (query) msg += ` matching "${query}"`;
        if (status !== 'all') msg += ` with status "${status}"`;
        return msg + '.';
      }

      let response = `## Industry Feeds`;
      if (status !== 'all') response += ` (${status})`;
      if (query) response += ` matching "${query}"`;
      response += `\n\n`;

      for (const feed of results) {
        const statusIcon = feed.is_active ? '✅' : '⏸️';
        const errorIcon = feed.error_count > 0 ? ' ⚠️' : '';

        response += `${statusIcon}${errorIcon} **${feed.name}**\n`;
        response += `   URL: ${feed.feed_url}\n`;
        if (feed.category) response += `   Category: ${feed.category}\n`;
        response += `   Articles: ${feed.article_count} (${feed.articles_this_week} this week)\n`;
        if (feed.error_count > 0) {
          response += `   Errors: ${feed.error_count}`;
          if (feed.last_error) response += ` - ${feed.last_error}`;
          response += `\n`;
        }
        if (feed.last_fetched_at) {
          response += `   Last fetched: ${formatDate(new Date(feed.last_fetched_at))}\n`;
        }
        response += `\n`;
      }

      if (filtered.length > limit) {
        response += `_Showing ${limit} of ${filtered.length} feeds._\n`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error searching feeds');
      return '❌ Failed to search feeds. Please try again.';
    }
  });

  // Add industry feed
  handlers.set('add_industry_feed', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const name = (input.name as string)?.trim();
    const feedUrl = (input.feed_url as string)?.trim();
    const category = input.category as string | undefined;

    if (!name || name.length < 1) {
      return '❌ Feed name is required.';
    }
    if (name.length > 200) {
      return '❌ Feed name must be 200 characters or less.';
    }
    if (!feedUrl) {
      return '❌ Feed URL is required.';
    }
    if (feedUrl.length > 2000) {
      return '❌ Feed URL must be 2000 characters or less.';
    }

    // Validate URL
    try {
      new URL(feedUrl);
    } catch {
      return `❌ Invalid feed URL: ${feedUrl}`;
    }

    try {
      const feed = await addFeed(name, feedUrl, category);
      logger.info({ feedId: feed.id, name, feedUrl }, 'Feed created via Addie');

      let response = `✅ Added feed **${name}**\n\n`;
      response += `**URL:** ${feedUrl}\n`;
      if (category) response += `**Category:** ${category}\n`;
      response += `**ID:** ${feed.id}\n`;
      response += `\n_The feed will be fetched on the next scheduled run._`;

      return response;
    } catch (error) {
      logger.error({ error, name, feedUrl }, 'Error adding feed');
      if (error instanceof Error && error.message.includes('duplicate')) {
        return `❌ A feed with this URL already exists.`;
      }
      return '❌ Failed to add feed. Please try again.';
    }
  });

  // Get feed stats
  handlers.set('get_feed_stats', async () => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    try {
      const stats = await getFeedStats();

      let response = `## Industry Feed Statistics\n\n`;
      response += `**Total Feeds:** ${stats.total_feeds}\n`;
      response += `**Active Feeds:** ${stats.active_feeds}\n\n`;

      response += `### Articles\n`;
      response += `**Total Collected:** ${stats.total_rss_perspectives.toLocaleString()}\n`;
      response += `**Today:** ${stats.rss_perspectives_today}\n\n`;

      response += `### Processing Status\n`;
      response += `**Pending:** ${stats.pending_processing}\n`;
      response += `**Processed:** ${stats.processed_success}\n`;
      if (stats.processed_failed > 0) {
        response += `**Failed:** ${stats.processed_failed} ⚠️\n`;
      }
      response += `**Alerts Sent Today:** ${stats.alerts_sent_today}\n`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error getting feed stats');
      return '❌ Failed to get feed statistics. Please try again.';
    }
  });

  return handlers;
}
