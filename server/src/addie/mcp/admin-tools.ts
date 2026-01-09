/**
 * Addie Admin Tools
 *
 * Tools available only to AAO platform admin users for:
 * - Looking up organization status and pending invoices
 * - Managing prospects and enrichment
 *
 * AAO platform admins are determined by membership in the "aao-admin" working group:
 * - Slack users: via isSlackUserAdmin() which looks up WorkOS user ID from Slack mapping
 * - Web users: via isWebUserAdmin() which checks working group membership directly
 *
 * Note: This is distinct from WorkOS organization admins, who are admins within their
 * own company's organization but do not have AAO platform-wide admin access.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { getPool } from '../../db/client.js';
import { MemberSearchAnalyticsDatabase } from '../../db/member-search-analytics-db.js';
import { MemberDatabase } from '../../db/member-db.js';
import {
  getPendingInvoices,
  getAllOpenInvoices,
  createOrgDiscount,
  createCoupon,
  createPromotionCode,
  type PendingInvoice,
  type OpenInvoiceWithCustomer,
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
import { COMPANY_TYPE_VALUES } from '../../config/company-types.js';
import { createProspect } from '../../services/prospect.js';
import {
  getAllFeedsWithStats,
  addFeed,
  getFeedStats,
  findSimilarFeeds,
  getPendingProposals,
  approveProposal,
  rejectProposal,
  getProposalStats,
  type FeedWithStats,
  type FeedProposal,
} from '../../db/industry-feeds-db.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import {
  createChannel,
  setChannelPurpose,
} from '../../slack/client.js';
import {
  getProductsForCustomer,
  createCheckoutSession,
  createAndSendInvoice,
  type BillingProduct,
} from '../../billing/stripe-client.js';
import { mergeOrganizations, previewMerge } from '../../db/org-merge-db.js';
import { workos } from '../../auth/workos-client.js';
import { DomainDataState } from '@workos-inc/node';
import { processInteraction, type InteractionContext } from '../services/interaction-analyzer.js';

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
      // Cache the negative result for a shorter time to avoid repeated DB lookups
      adminStatusCache.set(slackUserId, { isAdmin: false, expiresAt: Date.now() + 5 * 60 * 1000 });
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
 * Invalidate admin status cache for a Slack user (call when admin membership changes)
 */
export function invalidateAdminStatusCache(slackUserId?: string): void {
  if (slackUserId) {
    adminStatusCache.delete(slackUserId);
  } else {
    adminStatusCache.clear();
  }
}

// Cache for web user admin status (keyed by WorkOS user ID)
const webAdminStatusCache = new Map<string, { isAdmin: boolean; expiresAt: number }>();

/**
 * Invalidate web admin status cache for a user (call when admin membership changes)
 */
export function invalidateWebAdminStatusCache(workosUserId?: string): void {
  if (workosUserId) {
    webAdminStatusCache.delete(workosUserId);
  } else {
    webAdminStatusCache.clear();
  }
}

/**
 * Invalidate all admin caches (both Slack and web)
 */
export function invalidateAllAdminCaches(): void {
  adminStatusCache.clear();
  webAdminStatusCache.clear();
}

/**
 * Check if a web user is an AAO admin
 * Checks membership in aao-admin working group by WorkOS user ID
 * Results are cached for 30 minutes to reduce DB load
 */
export async function isWebUserAdmin(workosUserId: string): Promise<boolean> {
  // Check cache first
  const cached = webAdminStatusCache.get(workosUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.isAdmin;
  }

  try {
    // Get the aao-admin working group
    const adminGroup = await wgDb.getWorkingGroupBySlug(AAO_ADMIN_WORKING_GROUP_SLUG);

    if (!adminGroup) {
      logger.warn('AAO Admin working group not found');
      // Cache the negative result for a shorter time to avoid repeated DB lookups
      webAdminStatusCache.set(workosUserId, { isAdmin: false, expiresAt: Date.now() + 5 * 60 * 1000 });
      return false;
    }

    // Check if the user is a member of the admin working group
    const isAdmin = await wgDb.isMember(adminGroup.id, workosUserId);

    // Cache the result
    webAdminStatusCache.set(workosUserId, { isAdmin, expiresAt: Date.now() + ADMIN_CACHE_TTL_MS });

    logger.debug({ workosUserId, isAdmin }, 'Checked web user admin status');
    return isAdmin;
  } catch (error) {
    logger.error({ error, workosUserId }, 'Error checking if web user is admin');
    return false;
  }
}

/**
 * Check if a web user has admin privileges (via member context org role)
 * @deprecated Use isWebUserAdmin() for AAO admin checks - this only checks WorkOS org role
 */
export function isAdmin(memberContext: MemberContext | null): boolean {
  return memberContext?.org_membership?.role === 'admin';
}

/**
 * Compute the unified lifecycle stage for an organization.
 * This combines prospect_status and subscription_status into a single view.
 *
 * Lifecycle stages:
 * - prospect: Not contacted yet
 * - contacted: Outreach sent
 * - responded: They replied
 * - interested: Expressed interest
 * - negotiating: In discussions / invoice sent
 * - member: Active subscription
 * - churned: Was a member, subscription ended
 * - declined: Not interested
 */
export type LifecycleStage =
  | 'prospect'
  | 'contacted'
  | 'responded'
  | 'interested'
  | 'negotiating'
  | 'member'
  | 'churned'
  | 'declined';

// Emoji mapping for lifecycle stages - used in multiple places
export const LIFECYCLE_STAGE_EMOJI: Record<LifecycleStage, string> = {
  prospect: '🔍',
  contacted: '📧',
  responded: '💬',
  interested: '⭐',
  negotiating: '🤝',
  member: '✅',
  churned: '⚠️',
  declined: '❌',
};

export function computeLifecycleStage(org: {
  subscription_status?: string | null;
  prospect_status?: string | null;
  invoice_requested_at?: Date | null;
}): LifecycleStage {
  // Active subscription (including trial) = member
  if (org.subscription_status === 'active' || org.subscription_status === 'trialing') {
    return 'member';
  }

  // Subscription ended or payment failed = churned
  if (
    org.subscription_status === 'canceled' ||
    org.subscription_status === 'past_due' ||
    org.subscription_status === 'unpaid' ||
    org.subscription_status === 'incomplete_expired'
  ) {
    return 'churned';
  }

  // Incomplete subscription = started payment but didn't finish
  if (org.subscription_status === 'incomplete') {
    return 'negotiating';
  }

  // If they have an invoice requested, they're at least negotiating
  // (only promote if they're still in early pipeline stages)
  if (org.invoice_requested_at && (!org.prospect_status || org.prospect_status === 'prospect' || org.prospect_status === 'contacted')) {
    return 'negotiating';
  }

  // Map prospect_status to lifecycle stage
  const prospectStatusMap: Record<string, LifecycleStage> = {
    prospect: 'prospect',
    contacted: 'contacted',
    responded: 'responded',
    interested: 'interested',
    negotiating: 'negotiating',
    converted: 'member', // legacy value
    joined: 'member', // legacy value
    declined: 'declined',
    inactive: 'declined',
    disqualified: 'declined',
  };

  if (org.prospect_status && prospectStatusMap[org.prospect_status]) {
    return prospectStatusMap[org.prospect_status];
  }

  // Default: unknown org is a prospect
  return 'prospect';
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
    description: `DEPRECATED: Use get_account instead for complete account view with lifecycle stage.
This tool only searches Stripe data - it will fail for organizations that were created through the prospect flow.
Use get_account for a unified view of all organizations.`,
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
    name: 'get_account',
    description: `Get the complete account view for any organization - whether they're a prospect, member, or churned.

This is the PRIMARY tool for looking up any company. It shows:
- **Lifecycle stage**: prospect → contacted → responded → interested → negotiating → member (or declined/churned)
- **Membership**: Subscription status, tier, renewal date
- **Engagement**: Slack users, activity, working groups, dashboard logins
- **Pipeline**: Contact info, notes, interest level, activities
- **Enrichment**: Industry, revenue, employee count

USE THIS for ANY question about a company:
- "What's the status of [company]?"
- "Is [company] a member?"
- "Tell me about [company]"
- "How engaged is [company]?"
- "Who is our contact at [company]?"

This replaces find_prospect and lookup_organization with a unified view.`,
    usage_hints: 'Use this for ANY question about a specific organization. This gives you the complete account picture including lifecycle stage.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Company name or domain to look up (e.g., "Mediaocean" or "mediaocean.com")',
        },
      },
      required: ['query'],
    },
  },
  // Alias for backwards compatibility
  {
    name: 'get_organization_details',
    description: `Alias for get_account. Use get_account instead for the complete account lifecycle view.`,
    usage_hints: 'Prefer get_account - this is kept for backwards compatibility.',
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
          enum: COMPANY_TYPE_VALUES,
          description: 'Type of company',
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
      'DEPRECATED: Use get_account instead for complete account view with lifecycle stage. This tool only checks if a company exists before adding - use get_account to see full status including whether they are already a member.',
    usage_hints: 'DEPRECATED: Prefer get_account for lookups. Only use this before add_prospect to check existence.',
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
      'Update information about an existing prospect. Use this to add notes, change status, update contact info, or set interest level. IMPORTANT: When adding notes that indicate excitement, resource commitment, or intent to join, also set interest_level accordingly.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Organization ID to update',
        },
        company_type: {
          type: 'string',
          enum: COMPANY_TYPE_VALUES,
          description: 'Type of company',
        },
        status: {
          type: 'string',
          enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'],
          description: 'Prospect status',
        },
        interest_level: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'very_high'],
          description: 'How interested is this prospect? Set based on signals: low=not interested, medium=lukewarm, high=actively engaged/excited, very_high=ready to move forward/committed resources',
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
          enum: COMPANY_TYPE_VALUES,
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
    name: 'send_payment_request',
    description: `Send a payment link or invoice to a prospect. This is the ONE tool to use when you want to get someone to pay.

USE THIS when an admin says things like:
- "Send Joe Root at Permutive a membership link"
- "Get a payment link for Boltive"
- "Invoice The Trade Desk"
- "Help [company] pay for membership"
- "Give Acme a 20% discount and send them a payment link"
- "Send a discounted link to the startup"

This tool will:
1. Find the company (or create it if it doesn't exist)
2. Show you the users/contacts on file
3. Apply a discount if requested (or use their existing discount)
4. Generate a direct Stripe payment link OR send an invoice

For payment links: Returns a direct Stripe checkout URL you can share with the prospect.
For invoices: Sends an email from Stripe with a payment link - good for companies that need NET30/PO.
For discounts: Can create a new discount or auto-apply an existing org discount.`,
    usage_hints: 'This is the primary tool for converting prospects to members. Use it whenever payment is discussed.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: {
          type: 'string',
          description: 'Company name to search for or create',
        },
        domain: {
          type: 'string',
          description: 'Company domain (helps with lookup and creation)',
        },
        contact_name: {
          type: 'string',
          description: 'Contact person name (e.g., "Joe Root")',
        },
        contact_email: {
          type: 'string',
          description: 'Contact email address (required for invoice, optional for payment link)',
        },
        contact_title: {
          type: 'string',
          description: 'Contact job title',
        },
        action: {
          type: 'string',
          enum: ['payment_link', 'invoice', 'lookup_only'],
          description: 'What to do: payment_link (default), invoice (sends email), or lookup_only (just show info)',
        },
        lookup_key: {
          type: 'string',
          description: 'Product lookup_key from find_membership_products (e.g., aao_membership_corporate_under5m). ALWAYS call find_membership_products first to get valid lookup keys. Do NOT use tier names like bronze/silver/gold.',
        },
        billing_address: {
          type: 'object',
          description: 'Required for invoices - company billing address',
          properties: {
            line1: { type: 'string' },
            line2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postal_code: { type: 'string' },
            country: { type: 'string', description: 'Two-letter country code (e.g., "US")' },
          },
        },
        discount_percent: {
          type: 'number',
          description: 'Apply a percentage discount (e.g., 20 = 20% off). Creates a Stripe coupon.',
        },
        discount_amount_dollars: {
          type: 'number',
          description: 'Apply a fixed dollar discount (e.g., 500 = $500 off). Creates a Stripe coupon.',
        },
        discount_reason: {
          type: 'string',
          description: 'Reason for the discount (e.g., "Startup discount", "Early adopter")',
        },
        use_existing_discount: {
          type: 'boolean',
          description: 'If the org already has a discount, use it (default: true)',
        },
      },
      required: ['company_name'],
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
  {
    name: 'list_feed_proposals',
    description:
      'List pending feed proposals submitted by community members. Use this to review what news sources have been proposed.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of proposals to return (default 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'approve_feed_proposal',
    description:
      'Approve a feed proposal and create the feed. You must provide the final feed name and URL (which may differ from the proposed URL if you find the actual RSS feed).',
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: {
          type: 'number',
          description: 'ID of the proposal to approve',
        },
        feed_name: {
          type: 'string',
          description: 'Name for the feed (e.g., "AdExchanger")',
        },
        feed_url: {
          type: 'string',
          description: 'RSS feed URL (may differ from the proposed URL)',
        },
        category: {
          type: 'string',
          enum: ['ad-tech', 'advertising', 'marketing', 'media', 'martech', 'ctv', 'dooh', 'creator', 'ai', 'sports', 'industry', 'research'],
          description: 'Category for the feed',
        },
      },
      required: ['proposal_id', 'feed_name', 'feed_url'],
    },
  },
  {
    name: 'reject_feed_proposal',
    description:
      'Reject a feed proposal. Optionally provide a reason that could be shared with the proposer.',
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: {
          type: 'number',
          description: 'ID of the proposal to reject',
        },
        reason: {
          type: 'string',
          description: 'Reason for rejection (optional)',
        },
      },
      required: ['proposal_id'],
    },
  },

  // ============================================
  // SENSITIVE TOPICS & MEDIA CONTACT TOOLS
  // ============================================
  {
    name: 'add_media_contact',
    description:
      'Flag a Slack user as a known media contact (journalist, reporter, editor). Messages from this user will be handled with extra care and sensitive topics will be deflected.',
    input_schema: {
      type: 'object',
      properties: {
        slack_user_id: {
          type: 'string',
          description: 'Slack user ID of the media contact (e.g., "U0123456789")',
        },
        email: {
          type: 'string',
          description: 'Email address of the media contact',
        },
        name: {
          type: 'string',
          description: 'Full name of the media contact',
        },
        organization: {
          type: 'string',
          description: 'Media organization they work for (e.g., "TechCrunch", "AdExchanger")',
        },
        role: {
          type: 'string',
          description: 'Their role (e.g., "Reporter", "Editor", "Journalist")',
        },
        notes: {
          type: 'string',
          description: 'Additional notes about this contact',
        },
        handling_level: {
          type: 'string',
          enum: ['standard', 'careful', 'executive_only'],
          description: 'How carefully to handle this contact: standard (deflect sensitive topics), careful (deflect more topics), executive_only (always escalate)',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_flagged_conversations',
    description:
      'List conversations that have been flagged for sensitive topic detection. These need human review to ensure appropriate handling.',
    input_schema: {
      type: 'object',
      properties: {
        unreviewed_only: {
          type: 'boolean',
          description: 'Only show conversations that haven\'t been reviewed yet (default: true)',
        },
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Filter by severity level',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'review_flagged_conversation',
    description:
      'Mark a flagged conversation as reviewed. Use this after you\'ve looked at a flagged message and determined if any follow-up action is needed.',
    input_schema: {
      type: 'object',
      properties: {
        flagged_id: {
          type: 'number',
          description: 'ID of the flagged conversation to review',
        },
        notes: {
          type: 'string',
          description: 'Notes about the review (e.g., "False positive - user was asking about child-safe ad practices for their company", "Escalated to Brian")',
        },
      },
      required: ['flagged_id'],
    },
  },

  // ============================================
  // DISCOUNT MANAGEMENT TOOLS
  // ============================================
  {
    name: 'grant_discount',
    description: `Grant a discount to an organization. Use this when an admin wants to give a company a special rate.
You can grant either a percentage discount (e.g., 20% off) or a fixed dollar amount discount (e.g., $500 off).
Optionally creates a Stripe coupon/promotion code they can use at checkout.`,
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Organization ID (workos_organization_id)',
        },
        org_name: {
          type: 'string',
          description: 'Company name (alternative to org_id - will search for the org)',
        },
        discount_percent: {
          type: 'number',
          description: 'Percentage off (e.g., 20 = 20% off). Use this OR discount_amount_dollars, not both.',
        },
        discount_amount_dollars: {
          type: 'number',
          description: 'Fixed dollar amount off (e.g., 500 = $500 off). Use this OR discount_percent, not both.',
        },
        reason: {
          type: 'string',
          description: 'Why this discount is being granted (e.g., "Startup discount", "Early adopter", "Nonprofit")',
        },
        create_promotion_code: {
          type: 'boolean',
          description: 'Create a Stripe promotion code the org can use at checkout (default: true)',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'remove_discount',
    description: 'Remove a discount from an organization. Note: This does not delete any Stripe coupons that were created.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: {
          type: 'string',
          description: 'Organization ID (workos_organization_id)',
        },
        org_name: {
          type: 'string',
          description: 'Company name (alternative to org_id - will search for the org)',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_discounts',
    description: 'List all organizations that currently have active discounts. Shows discount percentage/amount, reason, and who granted it.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_promotion_code',
    description: `Create a standalone Stripe promotion code that anyone can use. Useful for marketing campaigns or special offers.
The code will be usable at checkout for any customer.`,
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code customers will enter at checkout (e.g., "LAUNCH2025", "EARLYBIRD"). Will be converted to uppercase.',
        },
        name: {
          type: 'string',
          description: 'Internal name for the coupon (e.g., "Launch 2025 Campaign")',
        },
        percent_off: {
          type: 'number',
          description: 'Percentage off (e.g., 20 = 20% off). Use this OR amount_off_dollars, not both.',
        },
        amount_off_dollars: {
          type: 'number',
          description: 'Fixed dollar amount off (e.g., 100 = $100 off). Use this OR percent_off, not both.',
        },
        duration: {
          type: 'string',
          enum: ['once', 'repeating', 'forever'],
          description: 'How long the discount applies: once (first payment only), repeating (multiple months), forever (all payments). Default: once.',
        },
        max_redemptions: {
          type: 'number',
          description: 'Maximum number of times the code can be used (optional)',
        },
      },
      required: ['code'],
    },
  },

  // ============================================
  // CHAPTER MANAGEMENT TOOLS
  // ============================================
  {
    name: 'create_chapter',
    description: `Create a new regional chapter with a Slack channel. Use this when a member wants to start a chapter in their city/region.

This tool:
1. Creates a working group with committee_type 'chapter'
2. Creates a public Slack channel for the chapter
3. Sets the founding member as the chapter leader

Example: If someone in Austin says "I want to start a chapter", use this to create an Austin Chapter with a #austin-chapter Slack channel.`,
    usage_hints: 'Use this when a member wants to start a chapter. Ask them what they want to call it first (e.g., "Austin Chapter" vs "Texas Chapter").',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Chapter name (e.g., "Austin Chapter", "Bay Area Chapter")',
        },
        region: {
          type: 'string',
          description: 'Geographic region this chapter covers (e.g., "Austin", "Bay Area", "Southern California")',
        },
        founding_member_id: {
          type: 'string',
          description: 'WorkOS user ID of the founding member who will become chapter leader',
        },
        description: {
          type: 'string',
          description: 'Optional description for the chapter',
        },
      },
      required: ['name', 'region'],
    },
  },
  {
    name: 'list_chapters',
    description: 'List all regional chapters with their member counts and Slack channels.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // INDUSTRY GATHERING TOOLS
  // ============================================
  {
    name: 'create_industry_gathering',
    description: `Create a new industry gathering (temporary committee for conferences/trade shows like CES, Cannes Lions, etc).

This tool:
1. Creates a working group with committee_type 'industry_gathering'
2. Creates a public Slack channel for coordination
3. Sets the event dates and location for automatic archival

Industry gatherings are temporary committees that auto-archive after the event ends.

Example: For CES 2026, create an industry gathering with name "CES 2026", location "Las Vegas, NV", start date 2026-01-07, end date 2026-01-10.`,
    usage_hints: 'Use this when a member or admin wants to coordinate around a major industry event. Ask for the event name, dates, and location.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Event/gathering name (e.g., "CES 2026", "Cannes Lions 2026")',
        },
        start_date: {
          type: 'string',
          description: 'Event start date in YYYY-MM-DD format',
        },
        end_date: {
          type: 'string',
          description: 'Event end date in YYYY-MM-DD format (optional if single-day event)',
        },
        location: {
          type: 'string',
          description: 'Event location (e.g., "Las Vegas, NV", "Cannes, France")',
        },
        website_url: {
          type: 'string',
          description: 'Official event website URL (optional)',
        },
        description: {
          type: 'string',
          description: 'Optional description for the gathering',
        },
        founding_member_id: {
          type: 'string',
          description: 'WorkOS user ID of the founding member who will become gathering leader',
        },
      },
      required: ['name', 'start_date', 'location'],
    },
  },
  {
    name: 'list_industry_gatherings',
    description: 'List all industry gatherings with their dates, locations, and member counts.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // COMMITTEE LEADERSHIP TOOLS
  // ============================================
  {
    name: 'add_committee_leader',
    description: `Add a user as a leader of a committee (working group, council, chapter, or industry gathering).
Leaders have management access to their committee - they can create events, manage posts, and manage members.

To find the user_id:
1. Look up the user via Slack (use their Slack user ID to find their WorkOS user ID in the mapping)
2. Or ask for their email and look up via get_organization_details

To find the committee:
1. Use list_working_groups, list_chapters, or list_industry_gatherings
2. Use the committee's slug (e.g., "ces-2026", "technical-standards-wg")`,
    usage_hints: 'Use when an admin wants to give someone committee management access. Get the user_id from Slack mapping or org details.',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'The slug of the committee (e.g., "ces-2026", "creative-wg", "austin-chapter")',
        },
        user_id: {
          type: 'string',
          description: 'The WorkOS user ID of the person to make a leader',
        },
        user_email: {
          type: 'string',
          description: 'Optional: The user email (for confirmation/logging)',
        },
      },
      required: ['committee_slug', 'user_id'],
    },
  },
  {
    name: 'remove_committee_leader',
    description: `Remove a user from the leadership of a committee.
The user will lose management access but will remain a regular member.`,
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'The slug of the committee',
        },
        user_id: {
          type: 'string',
          description: 'The WorkOS user ID of the leader to remove',
        },
      },
      required: ['committee_slug', 'user_id'],
    },
  },
  {
    name: 'list_committee_leaders',
    description: `List all leaders of a specific committee. Shows their user IDs, names, and organizations.`,
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'The slug of the committee to list leaders for',
        },
      },
      required: ['committee_slug'],
    },
  },

  // ============================================
  // ORGANIZATION MANAGEMENT TOOLS
  // ============================================
  {
    name: 'merge_organizations',
    description: `Merge two duplicate organization records into one.
Use this when you discover duplicate organizations (same company with multiple records).
All data from the secondary organization will be moved to the primary, then the secondary will be deleted.

IMPORTANT: This is a destructive operation that cannot be undone.

Workflow:
1. Use find_prospect or get_organization_details to identify both org IDs
2. Call merge_organizations (defaults to preview=true) to see what will be merged
3. Show the preview to the user and ask if they want to proceed
4. If yes, call merge_organizations again with preview=false to execute

CRITICAL: A preview does NOT execute the merge. You MUST call again with preview=false to actually merge.`,
    usage_hints: 'Preview first, then execute with preview=false. The preview response will remind you to call again.',
    input_schema: {
      type: 'object' as const,
      properties: {
        primary_org_id: {
          type: 'string',
          description: 'WorkOS organization ID of the organization to KEEP (all data will be merged into this one)',
        },
        secondary_org_id: {
          type: 'string',
          description: 'WorkOS organization ID of the organization to REMOVE (data will be moved from here)',
        },
        preview: {
          type: 'boolean',
          description: 'If true, show what would be merged without actually doing it (default: true for safety)',
        },
      },
      required: ['primary_org_id', 'secondary_org_id'],
    },
  },
  {
    name: 'find_duplicate_orgs',
    description: `Search for potential duplicate organizations by name or domain.
Use this to discover organizations that might need to be merged.

Returns organizations that share the same name (case-insensitive) or email domain.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        search_type: {
          type: 'string',
          enum: ['name', 'domain', 'all'],
          description: 'What to search for duplicates: name (same org name), domain (same email domain), or all (both)',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_domain_health',
    description: `Check domain health across the system to find data quality issues.

This tool identifies:
1. **Orphan corporate domains** - Users with corporate email domains (not gmail, etc.) that have no matching organization
2. **Unverified org domains** - Organizations with users but no verified domain mapping
3. **Domain conflicts** - Multiple orgs claiming the same domain
4. **Personal workspace corporate users** - Users with company emails in personal workspaces instead of company orgs

The goal: Every corporate email domain should map to a known organization (member or prospect).`,
    usage_hints: 'Use this for data quality audits. The results can guide follow-up actions like creating prospects or merging orgs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        check_type: {
          type: 'string',
          enum: ['orphan_domains', 'unverified_domains', 'domain_conflicts', 'misaligned_users', 'all'],
          description: 'What to check: orphan_domains (corporate emails without orgs), unverified_domains (orgs missing domain verification), domain_conflicts (multiple orgs per domain), misaligned_users (corporate users in personal workspaces), or all',
        },
        limit: {
          type: 'number',
          description: 'Maximum results per category (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'manage_organization_domains',
    description: `Add, remove, or list verified domains for an organization.

Use this tool to:
- **List** all domains associated with an organization
- **Add** a new domain to an organization (e.g., when a company has multiple email domains)
- **Remove** a domain from an organization
- **Set primary** - designate which domain is the primary one for the organization

Domains are synced to WorkOS, which means:
1. New users signing up with that email domain are auto-associated with the organization
2. The domain is marked as verified for SSO eligibility
3. Organization enrichment uses the primary domain for company lookups

Note: Each domain can only belong to one organization. If a domain is already claimed by another org, the add operation will fail.

The "primary domain" is a local concept used for enrichment and display - WorkOS treats all domains equally for user association.`,
    usage_hints: 'Use "list" action first to see current domains. Add/remove sync to WorkOS; set_primary is local only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'remove', 'set_primary'],
          description: 'The action to perform: list (show all domains), add (add a new domain), remove (delete a domain), set_primary (make a domain the primary one)',
        },
        organization_id: {
          type: 'string',
          description: 'The WorkOS organization ID. You can get this from lookup_organization or get_organization_details.',
        },
        domain: {
          type: 'string',
          description: 'The domain to add, remove, or set as primary (required for add/remove/set_primary actions). Example: "acme.com"',
        },
        set_as_primary: {
          type: 'boolean',
          description: 'When adding a domain, whether to set it as the primary domain (default: false)',
        },
      },
      required: ['action', 'organization_id'],
    },
  },

  // ============================================
  // PROSPECT OWNERSHIP & PIPELINE TOOLS
  // ============================================
  {
    name: 'my_engaged_prospects',
    description: `List your most engaged prospects - organizations you own that have high engagement scores.

USE THIS when an admin asks:
- "Which of my prospects are most engaged?"
- "Show me my hot prospects"
- "What are my best prospects doing?"

Returns prospects you own sorted by engagement score (highest first), with engagement reasons.
Hot prospects have engagement_score >= 30.`,
    usage_hints: 'Quick way to see which of your owned prospects are showing interest.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
        hot_only: {
          type: 'boolean',
          description: 'Only show hot prospects (engagement_score >= 30)',
        },
      },
      required: [],
    },
  },
  {
    name: 'my_followups_needed',
    description: `List your prospects that need follow-up attention.

USE THIS when an admin asks:
- "Which prospects do I need to reach out to?"
- "What follow-ups do I have?"
- "Which of my prospects are stale?"

Returns owned prospects that:
- Have no activity logged in the past 14 days, OR
- Have an overdue next_step_due_date

Sorted by urgency (overdue first, then by days since last activity).`,
    usage_hints: 'Great for daily check-ins to see what needs attention.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_stale: {
          type: 'number',
          description: 'Days without activity to consider stale (default: 14)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'unassigned_prospects',
    description: `List high-engagement prospects that have no owner assigned.

USE THIS when an admin asks:
- "What are the most interesting unassigned prospects?"
- "Which prospects need an owner?"
- "Show me unclaimed hot prospects"

Returns non-member organizations with engagement but no owner in org_stakeholders.
Great for finding opportunities to claim ownership.`,
    usage_hints: 'Use this to find prospects worth claiming.',
    input_schema: {
      type: 'object' as const,
      properties: {
        min_engagement: {
          type: 'number',
          description: 'Minimum engagement score to include (default: 10)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'claim_prospect',
    description: `Claim ownership of a prospect organization.

USE THIS when an admin says:
- "I'll take ownership of [company]"
- "Assign me to [company]"
- "Make me the owner of [company]"

Adds you as the owner in org_stakeholders. If another owner exists, you can optionally replace them.`,
    usage_hints: 'Use after finding unassigned prospects or when reassigning ownership.',
    input_schema: {
      type: 'object' as const,
      properties: {
        org_id: {
          type: 'string',
          description: 'WorkOS organization ID to claim ownership of',
        },
        company_name: {
          type: 'string',
          description: 'Company name (used to look up org_id if not provided)',
        },
        replace_existing: {
          type: 'boolean',
          description: 'If true, replace existing owner. Otherwise fails if owner exists (default: false)',
        },
        notes: {
          type: 'string',
          description: 'Optional notes about why you are claiming this prospect',
        },
      },
      required: [],
    },
  },
  {
    name: 'suggest_prospects',
    description: `Suggest companies to add to the prospect list.

USE THIS when an admin asks:
- "What companies should I add to the prospect list?"
- "Find new prospects for me"
- "Who should we be targeting?"

This tool uses two approaches:
1. **Unmapped domains**: Finds Slack/email domains that are actively engaged but not yet mapped to an organization (high-value - they're already in our ecosystem!)
2. **Lusha search**: Searches Lusha's database for companies matching ad tech criteria

Returns a combined list prioritizing unmapped domains (already engaged) over external prospects.`,
    usage_hints: 'Great for expanding the prospect pipeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_lusha: {
          type: 'boolean',
          description: 'Include Lusha search results for external companies (default: true)',
        },
        lusha_keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords for Lusha search (default: ["programmatic", "DSP", "ad tech"])',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results per source (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_reminder',
    description: `Set a reminder/next step for a prospect.

USE THIS when an admin says:
- "Remind me to follow up with [company] next week"
- "Set a reminder for [company] on Tuesday"
- "I need to call [company] in 3 days"
- "Schedule a follow-up with [company]"

Creates an activity with a due date that will show up in my_upcoming_tasks and my_followups_needed.`,
    usage_hints: 'Use when the admin wants to schedule a future follow-up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        company_name: {
          type: 'string',
          description: 'Company name to set reminder for',
        },
        org_id: {
          type: 'string',
          description: 'Organization ID (alternative to company_name)',
        },
        reminder: {
          type: 'string',
          description: 'What needs to be done (e.g., "Follow up on membership interest", "Send pricing info")',
        },
        due_date: {
          type: 'string',
          description: 'When the reminder is due (e.g., "2024-01-15", "next Monday", "in 3 days")',
        },
      },
      required: ['reminder', 'due_date'],
    },
  },
  {
    name: 'my_upcoming_tasks',
    description: `List your upcoming tasks and reminders for the next period.

USE THIS when an admin asks:
- "What's on my plate this week?"
- "Show me my upcoming tasks"
- "What do I have coming up?"
- "What reminders do I have?"

Unlike my_followups_needed (which shows overdue/stale), this shows FUTURE tasks you've scheduled.`,
    usage_hints: 'Use for planning and seeing what you have scheduled.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: {
          type: 'number',
          description: 'How many days ahead to look (default: 7)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: [],
    },
  },
  {
    name: 'log_conversation',
    description: `Log a conversation or interaction with a prospect/member.

USE THIS when an admin says:
- "I just talked to [person/company]"
- "Had a call with [company] - they said..."
- "Spoke with [person] about membership"
- "DMd [person] and they're interested"
- "Just got off a call with [company]"

This logs the interaction, analyzes it for learnings, and automatically:
- Updates any pending tasks (completes them if the interaction addressed them)
- Creates new follow-up tasks if mentioned
- Extracts and stores learnings about the contact/company`,
    usage_hints: 'Use when admin reports having an interaction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        company_name: {
          type: 'string',
          description: 'Company name',
        },
        org_id: {
          type: 'string',
          description: 'Organization ID (alternative to company_name)',
        },
        contact_name: {
          type: 'string',
          description: 'Name of the person they spoke with (optional)',
        },
        channel: {
          type: 'string',
          enum: ['call', 'video', 'slack_dm', 'email', 'in_person', 'other'],
          description: 'How the interaction happened',
        },
        summary: {
          type: 'string',
          description: 'Summary of what was discussed (from the admin)',
        },
      },
      required: ['summary'],
    },
  },

  // ============================================
  // INSIGHT GOALS MANAGEMENT TOOLS
  // ============================================
  {
    name: 'list_insight_goals',
    description: `List all insight goals - the questions/topics we're trying to learn about from members.

USE THIS when admin asks:
- "What are we trying to learn about members?"
- "What questions should Addie be asking?"
- "Show me the insight goals"
- "What member insights are we collecting?"

Returns all configured insight goals with their priority and status.`,
    usage_hints: 'Use to review what information we want to gather from members.',
    input_schema: {
      type: 'object' as const,
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Only show active/enabled goals (default: false - show all)',
        },
      },
    },
  },
  {
    name: 'add_insight_goal',
    description: `Add a new insight goal - a question or topic we want to naturally learn about from members.

USE THIS when admin says:
- "We should ask members about [topic]"
- "I want to know what members think about [topic]"
- "Add a question about [topic] to what Addie asks"
- "Can we track [topic] for members?"

The goal will be added to Addie's awareness, and she'll naturally try to learn this in conversations.`,
    usage_hints: 'The question should be conversational, not survey-like.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Short name for the goal (e.g., "Learn 2026 Plans")',
        },
        question: {
          type: 'string',
          description: 'The question to explore (e.g., "What are you planning for agentic advertising in 2026?")',
        },
        priority: {
          type: 'number',
          description: 'Priority 1-100, higher = more important (default: 50)',
        },
        target_mapped_only: {
          type: 'boolean',
          description: 'Only ask users who have linked their accounts (default: false)',
        },
      },
      required: ['name', 'question'],
    },
  },
  {
    name: 'update_insight_goal',
    description: `Update an existing insight goal - change its priority, enable/disable it, or update the question.

USE THIS when admin says:
- "Disable the [goal] question"
- "Make [goal] higher priority"
- "Change the question for [goal]"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_id: {
          type: 'number',
          description: 'ID of the goal to update',
        },
        is_enabled: {
          type: 'boolean',
          description: 'Enable or disable the goal',
        },
        priority: {
          type: 'number',
          description: 'New priority (1-100)',
        },
        question: {
          type: 'string',
          description: 'Updated question text',
        },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'get_insight_summary',
    description: `Get a summary of what we've learned from members - collected insights and statistics.

USE THIS when admin asks:
- "What have we learned from members?"
- "Show me the insights we've collected"
- "How much do we know about our members?"
- "Summarize member insights"

Returns counts and examples of collected insights by type.`,
    usage_hints: 'Use to see the value of insight collection efforts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        insight_type: {
          type: 'string',
          description: 'Filter to a specific insight type (e.g., "plans_2026", "challenges")',
        },
        limit: {
          type: 'number',
          description: 'Maximum examples to show per type (default: 5)',
        },
      },
    },
  },

  // ============================================
  // MEMBER SEARCH & INTRODUCTION ANALYTICS TOOLS
  // ============================================
  {
    name: 'get_member_search_analytics',
    description: `Get analytics about member profile searches and introductions made through Addie.

USE THIS when admin asks:
- "How are member searches performing?"
- "Show me introduction stats"
- "What are people searching for?"
- "Which members are getting the most visibility?"
- "How many introductions have we made?"

Returns: Search counts, impressions, clicks, introduction requests/sent, top search queries, top members by visibility, and recent introductions with full context.`,
    usage_hints: 'Use this to monitor the member directory and introduction feature performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look back (default: 30, max: 365)',
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
 * Format open invoice with customer info for response
 */
function formatOpenInvoice(invoice: OpenInvoiceWithCustomer): Record<string, unknown> {
  return {
    id: invoice.id,
    status: invoice.status,
    amount: formatCurrency(invoice.amount_due, invoice.currency),
    product: invoice.product_name || 'Unknown product',
    customer_name: invoice.customer_name || 'Unknown',
    customer_email: invoice.customer_email || 'Unknown',
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

  // List pending invoices across all customers (queries Stripe directly)
  handlers.set('list_pending_invoices', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const limit = (input.limit as number) || 20;

    logger.info({ limit }, 'Addie: Admin listing pending invoices');

    try {
      // Query Stripe directly for all open invoices
      // This finds invoices even for customers not linked to organizations in our database
      const openInvoices = await getAllOpenInvoices(limit);

      if (openInvoices.length === 0) {
        return JSON.stringify({
          success: true,
          message: 'No pending invoices found.',
          invoices: [],
        });
      }

      // Try to match invoices to organizations by workos_organization_id or stripe_customer_id
      const allOrgs = await orgDb.listOrganizations();
      const orgByWorkosId = new Map(allOrgs.map(org => [org.workos_organization_id, org]));
      const orgByStripeId = new Map(
        allOrgs.filter(org => org.stripe_customer_id).map(org => [org.stripe_customer_id, org])
      );

      const invoicesWithOrgs = openInvoices.map(invoice => {
        // Try to find matching org
        let orgName: string | null = null;
        if (invoice.workos_organization_id) {
          const org = orgByWorkosId.get(invoice.workos_organization_id);
          if (org) orgName = org.name;
        }
        if (!orgName) {
          const org = orgByStripeId.get(invoice.customer_id);
          if (org) orgName = org.name;
        }

        return {
          ...formatOpenInvoice(invoice),
          organization: orgName || invoice.customer_name || 'Unknown organization',
        };
      });

      const totalAmount = openInvoices.reduce((sum, inv) => sum + inv.amount_due, 0);
      const formattedTotal = formatCurrency(totalAmount, openInvoices[0]?.currency || 'usd');

      return JSON.stringify({
        success: true,
        message: `Found ${openInvoices.length} pending invoice(s) totaling ${formattedTotal}`,
        invoices: invoicesWithOrgs,
      });
    } catch (error) {
      logger.error({ error }, 'Addie: Error listing pending invoices');
      return JSON.stringify({
        success: false,
        error: 'Failed to list pending invoices. Please try again.',
      });
    }
  });

  // Shared handler for get_account and get_organization_details
  const getAccountHandler = async (input: Record<string, unknown>) => {
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

      // If multiple matches, present options to the user with lifecycle stage
      if (result.rows.length > 1) {
        let response = `## Found ${result.rows.length} organizations matching "${query}"\n\n`;
        response += `Which one would you like to know more about?\n\n`;

        for (let i = 0; i < result.rows.length; i++) {
          const org = result.rows[i];
          const lifecycleStage = computeLifecycleStage(org);
          response += `**${i + 1}. ${org.name}**\n`;
          if (org.email_domain) response += `   Domain: ${org.email_domain}\n`;
          if (org.company_type) response += `   Type: ${org.company_type}\n`;
          response += `   Lifecycle: ${LIFECYCLE_STAGE_EMOJI[lifecycleStage]} ${lifecycleStage}\n`;
          response += `\n`;
        }

        response += `_Reply with the company name or number for full details._`;
        return response;
      }

      const org = result.rows[0];
      const orgId = org.workos_organization_id;

      // Compute the unified lifecycle stage
      const lifecycleStage = computeLifecycleStage(org);

      // Gather all the data in parallel
      const [
        slackUsersResult,
        slackActivityResult,
        workingGroupsResult,
        activitiesResult,
        engagementSignals,
        pendingInvoicesResult,
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
        // Get pending invoices if they have a Stripe customer
        org.stripe_customer_id ? getPendingInvoices(org.stripe_customer_id) : Promise.resolve([]),
      ]);

      const slackUserCount = parseInt(slackUsersResult.rows[0]?.slack_user_count || '0');
      const slackActivity = slackActivityResult.rows[0] || { active_users: 0, messages: 0, reactions: 0, thread_replies: 0 };
      const workingGroups = workingGroupsResult.rows;
      const recentActivities = activitiesResult.rows;
      const pendingInvoices = pendingInvoicesResult;

      // Build comprehensive response
      let response = `## ${org.name}\n\n`;

      // Lifecycle stage - the unified view (prominently displayed at top)
      response += `**Lifecycle Stage:** ${LIFECYCLE_STAGE_EMOJI[lifecycleStage]} **${lifecycleStage.charAt(0).toUpperCase() + lifecycleStage.slice(1)}**\n`;

      // Basic info
      if (org.company_type) response += `**Type:** ${org.company_type}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
      if (org.parent_name) response += `**Parent:** ${org.parent_name}\n`;
      response += `**ID:** ${orgId}\n`;
      response += '\n';

      // Membership details (if member or has subscription history)
      if (lifecycleStage === 'member' || lifecycleStage === 'churned' || org.subscription_status) {
        response += `### Membership\n`;
        if (org.subscription_status === 'active') {
          response += `**Status:** Active - ${org.subscription_product_name || 'Subscription'}\n`;
          if (org.subscription_current_period_end) {
            response += `**Renews:** ${formatDate(new Date(org.subscription_current_period_end))}\n`;
          }
        } else if (org.subscription_status === 'canceled') {
          response += `**Status:** Canceled\n`;
        } else if (org.subscription_status === 'past_due') {
          response += `**Status:** Past due - payment needed\n`;
        }
        if (pendingInvoices.length > 0) {
          response += `**Pending invoices:** ${pendingInvoices.length}\n`;
          for (const inv of pendingInvoices.slice(0, 3)) {
            response += `  - ${formatPendingInvoice(inv).amount} (${formatPendingInvoice(inv).status})\n`;
          }
        }
        response += '\n';
      }

      // Pipeline info (for prospects/negotiating)
      if (lifecycleStage !== 'member' && lifecycleStage !== 'churned') {
        response += `### Pipeline\n`;
        if (org.prospect_contact_name) {
          response += `**Contact:** ${org.prospect_contact_name}`;
          if (org.prospect_contact_title) response += ` (${org.prospect_contact_title})`;
          response += '\n';
        }
        if (org.prospect_contact_email) response += `**Email:** ${org.prospect_contact_email}\n`;
        if (org.invoice_requested_at) {
          response += `**Invoice requested:** ${formatDate(new Date(org.invoice_requested_at))}\n`;
        }
        if (engagementSignals.interest_level) {
          response += `**Interest:** ${engagementSignals.interest_level}`;
          if (engagementSignals.interest_level_set_by) response += ` (set by ${engagementSignals.interest_level_set_by})`;
          response += '\n';
        }
        // Show pending invoices for prospects in negotiating stage too
        if (pendingInvoices.length > 0) {
          response += `**Pending invoices:** ${pendingInvoices.length}\n`;
          for (const inv of pendingInvoices.slice(0, 3)) {
            response += `  - ${formatPendingInvoice(inv).amount} (${formatPendingInvoice(inv).status})\n`;
          }
        }
        response += '\n';
      }

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
      logger.error({ error, query }, 'Addie: Error getting account details');
      return `❌ Failed to get account details. Please try again or contact support.`;
    }
  };

  // Register get_account as the primary tool
  handlers.set('get_account', getAccountHandler);

  // Register get_organization_details as an alias for backwards compatibility
  handlers.set('get_organization_details', getAccountHandler);

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

    // Auto-claim ownership for the user who added the prospect
    const userId = memberContext?.workos_user?.workos_user_id;
    const userName = memberContext?.workos_user?.first_name || 'Unknown';
    const userEmail = memberContext?.workos_user?.email;

    if (userId && userEmail) {
      try {
        const pool = getPool();
        await pool.query(`
          INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
          VALUES ($1, $2, $3, $4, 'owner', $5)
          ON CONFLICT (organization_id, user_id)
          DO UPDATE SET role = 'owner', updated_at = NOW()
        `, [org.workos_organization_id, userId, userName, userEmail, `Auto-assigned when created via Addie on ${new Date().toLocaleDateString()}`]);
        response += `**Owner:** ${userName} (you)\n`;
      } catch (error) {
        logger.warn({ error, orgId: org.workos_organization_id, userId }, 'Failed to auto-claim prospect ownership');
      }
    }

    if (domain && isLushaConfigured()) {
      response += `\n_Enriching company data in background..._`;
    }

    return response;
  });

  // Find prospect (DEPRECATED - use get_account instead)
  handlers.set('find_prospect', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const query = input.query as string;
    const searchPattern = `%${query}%`;

    // Include subscription_status and invoice_requested_at for lifecycle stage computation
    const result = await pool.query(
      `SELECT workos_organization_id, name, company_type, email_domain,
              prospect_status, prospect_source, prospect_contact_name,
              subscription_status, invoice_requested_at,
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
      return `No organizations found matching "${query}". Would you like me to add them as a new prospect?`;
    }

    let response = `## Found ${result.rows.length} match${result.rows.length === 1 ? '' : 'es'} for "${query}"\n\n`;
    response += `_Note: Use get_account for full details_\n\n`;

    for (const org of result.rows) {
      const lifecycleStage = computeLifecycleStage(org);
      response += `### ${org.name}\n`;
      response += `**ID:** ${org.workos_organization_id}\n`;
      response += `**Lifecycle:** ${LIFECYCLE_STAGE_EMOJI[lifecycleStage]} ${lifecycleStage}\n`;
      response += `**Type:** ${org.company_type || 'Not set'}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
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
    if (input.interest_level) {
      updates.push(`interest_level = $${paramIndex++}`);
      values.push(input.interest_level);
      updates.push(`interest_level_set_by = $${paramIndex++}`);
      values.push('Addie');
      updates.push(`interest_level_set_at = NOW()`);
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
      return `No updates provided. Specify at least one field to update (company_type, status, interest_level, contact_name, contact_email, domain, notes).`;
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
    if (input.interest_level) response += `• Interest level → ${input.interest_level}\n`;
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

  // Send payment request - the unified tool for getting prospects to pay
  handlers.set('send_payment_request', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const companyName = input.company_name as string;
    const domain = input.domain as string | undefined;
    const contactName = input.contact_name as string | undefined;
    const contactEmail = input.contact_email as string | undefined;
    const contactTitle = input.contact_title as string | undefined;
    const action = (input.action as string) || 'payment_link';
    const lookupKey = input.lookup_key as string | undefined;
    const billingAddress = input.billing_address as {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    } | undefined;
    // Discount parameters
    const discountPercent = input.discount_percent as number | undefined;
    const discountAmountDollars = input.discount_amount_dollars as number | undefined;
    const discountReason = input.discount_reason as string | undefined;
    const useExistingDiscount = input.use_existing_discount !== false; // default true

    const pool = getPool();
    let org: {
      workos_organization_id: string;
      name: string;
      is_personal: boolean;
      company_type?: string;
      revenue_tier?: string;
      prospect_contact_email?: string;
      prospect_contact_name?: string;
      enrichment_employee_count?: number;
      enrichment_revenue?: number;
      // Discount fields
      discount_percent?: number;
      discount_amount_cents?: number;
      stripe_coupon_id?: string;
      stripe_promotion_code?: string;
    } | null = null;
    let created = false;

    // Step 1: Find the organization
    const searchPattern = `%${companyName}%`;
    const searchResult = await pool.query(
      `SELECT workos_organization_id, name, is_personal, company_type, revenue_tier,
              prospect_contact_email, prospect_contact_name,
              enrichment_employee_count, enrichment_revenue,
              discount_percent, discount_amount_cents, stripe_coupon_id, stripe_promotion_code
       FROM organizations
       WHERE is_personal = false
         AND (LOWER(name) LIKE LOWER($1) ${domain ? 'OR LOWER(email_domain) LIKE LOWER($2)' : ''})
       ORDER BY
         CASE WHEN LOWER(name) = LOWER($3) THEN 0
              WHEN LOWER(name) LIKE LOWER($4) THEN 1
              ELSE 2 END
       LIMIT 5`,
      domain
        ? [searchPattern, `%${domain}%`, companyName, `${companyName}%`]
        : [searchPattern, companyName, `${companyName}%`]
    );

    if (searchResult.rows.length === 0) {
      // Create the prospect
      const createResult = await createProspect({
        name: companyName,
        domain,
        prospect_source: 'addie_payment_request',
        prospect_contact_name: contactName,
        prospect_contact_email: contactEmail,
        prospect_contact_title: contactTitle,
      });

      if (!createResult.success || !createResult.organization) {
        return `❌ Failed to create prospect: ${createResult.error}`;
      }

      // Re-fetch with full fields
      const newOrgResult = await pool.query(
        `SELECT workos_organization_id, name, is_personal, company_type, revenue_tier,
                prospect_contact_email, prospect_contact_name,
                enrichment_employee_count, enrichment_revenue,
                discount_percent, discount_amount_cents, stripe_coupon_id, stripe_promotion_code
         FROM organizations WHERE workos_organization_id = $1`,
        [createResult.organization.workos_organization_id]
      );
      org = newOrgResult.rows[0];
      created = true;
    } else if (searchResult.rows.length === 1) {
      org = searchResult.rows[0];
    } else {
      // Multiple matches - ask user to clarify
      let response = `## Found ${searchResult.rows.length} companies matching "${companyName}"\n\n`;
      response += `Which one do you mean?\n\n`;

      for (let i = 0; i < searchResult.rows.length; i++) {
        const o = searchResult.rows[i];
        response += `**${i + 1}. ${o.name}**\n`;
        if (o.prospect_contact_name) response += `   Contact: ${o.prospect_contact_name}\n`;
        if (o.company_type) response += `   Type: ${o.company_type}\n`;
        response += `\n`;
      }

      response += `_Reply with the company name to proceed._`;
      return response;
    }

    if (!org) {
      return `❌ Could not find or create organization "${companyName}"`;
    }

    // Update contact info if provided
    if (contactName || contactEmail || contactTitle) {
      const updates: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (contactName) {
        updates.push(`prospect_contact_name = $${paramIndex++}`);
        values.push(contactName);
      }
      if (contactEmail) {
        updates.push(`prospect_contact_email = $${paramIndex++}`);
        values.push(contactEmail);
      }
      if (contactTitle) {
        updates.push(`prospect_contact_title = $${paramIndex++}`);
        values.push(contactTitle);
      }

      if (updates.length > 0) {
        updates.push(`updated_at = NOW()`);
        values.push(org.workos_organization_id);
        await pool.query(
          `UPDATE organizations SET ${updates.join(', ')} WHERE workos_organization_id = $${paramIndex}`,
          values
        );
        // Update local object
        if (contactName) org.prospect_contact_name = contactName;
        if (contactEmail) org.prospect_contact_email = contactEmail;
      }
    }

    // Get users in this org (WorkOS memberships)
    const membersResult = await pool.query(
      `SELECT om.workos_user_id, u.email, u.first_name, u.last_name
       FROM organization_memberships om
       LEFT JOIN users u ON u.workos_user_id = om.workos_user_id
       WHERE om.workos_organization_id = $1
       LIMIT 10`,
      [org.workos_organization_id]
    );
    const members = membersResult.rows;

    // Determine the email to use
    const emailToUse = contactEmail || org.prospect_contact_email || members[0]?.email;

    // Get available products
    const customerType = org.is_personal ? 'individual' : 'company';
    let products: BillingProduct[] = [];
    try {
      products = await getProductsForCustomer({
        customerType,
        category: 'membership',
      });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch products');
    }

    // Select product by lookup_key if provided, otherwise suggest based on company size
    let suggestedProduct: BillingProduct | undefined;
    let selectedProduct: BillingProduct | undefined;

    if (lookupKey) {
      // Exact match on lookup_key
      selectedProduct = products.find(p => p.lookup_key === lookupKey);
      if (!selectedProduct) {
        // Try partial match as fallback
        selectedProduct = products.find(p =>
          p.lookup_key?.toLowerCase().includes(lookupKey.toLowerCase())
        );
      }
      if (!selectedProduct) {
        return `❌ Product not found for lookup_key: "${lookupKey}". Use find_membership_products to get valid lookup keys.`;
      }
    }

    if (!selectedProduct && products.length > 0) {
      // Suggest based on enrichment data (revenue tier based)
      const employeeCount = org.enrichment_employee_count || 0;
      const revenue = org.enrichment_revenue || 0;

      // Match to actual product lookup_keys
      if (revenue > 250000000 || employeeCount > 500) {
        suggestedProduct = products.find(p => p.lookup_key?.includes('industry_council'));
      } else if (revenue > 5000000 || employeeCount > 20) {
        suggestedProduct = products.find(p => p.lookup_key?.includes('corporate_5m'));
      } else {
        suggestedProduct = products.find(p => p.lookup_key?.includes('under5m'));
      }
      suggestedProduct = suggestedProduct || products[0];
    }

    const finalProduct = selectedProduct || suggestedProduct;

    // Build response
    let response = `## ${created ? '✅ Created' : '📋'} ${org.name}\n\n`;

    // Show contacts/users
    response += `### Contacts\n`;
    if (org.prospect_contact_name || org.prospect_contact_email) {
      response += `**Primary Contact:** ${org.prospect_contact_name || 'Unknown'}`;
      if (org.prospect_contact_email) response += ` (${org.prospect_contact_email})`;
      response += `\n`;
    }
    if (members.length > 0) {
      response += `**Registered Users:** ${members.length}\n`;
      for (const m of members.slice(0, 3)) {
        const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || 'Unknown';
        response += `  • ${name} (${m.email})\n`;
      }
      if (members.length > 3) {
        response += `  _...and ${members.length - 3} more_\n`;
      }
    } else if (!org.prospect_contact_email) {
      response += `_No contacts on file - add a contact_email to proceed._\n`;
    }
    response += `\n`;

    // If lookup only, stop here
    if (action === 'lookup_only') {
      response += `### Available Products\n`;
      for (const p of products.slice(0, 5)) {
        const amount = p.amount_cents ? `$${(p.amount_cents / 100).toLocaleString()}/yr` : 'Custom';
        const suggested = p === suggestedProduct ? ' ⭐ Suggested' : '';
        response += `• **${p.display_name}** - ${amount}${suggested}\n`;
        response += `  lookup_key: \`${p.lookup_key}\`\n`;
      }
      response += `\n_Use this tool again with action="payment_link" or action="invoice" and the lookup_key to proceed._`;
      return response;
    }

    // Generate payment link
    if (action === 'payment_link') {
      if (!finalProduct) {
        return response + `\n❌ No membership products available. Please check Stripe configuration.`;
      }

      const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';

      try {
        // Handle discounts
        let couponId: string | undefined;
        let appliedDiscount: string | undefined;

        // Check if a new discount was requested
        if (discountPercent !== undefined || discountAmountDollars !== undefined) {
          if (!discountReason) {
            return response + `\n❌ Please provide a discount_reason when applying a discount.`;
          }

          // Create a new discount/coupon for this org
          const grantedBy = memberContext?.workos_user?.email || 'Addie';
          const stripeDiscount = await createOrgDiscount(org.workos_organization_id, org.name, {
            percent_off: discountPercent,
            amount_off_cents: discountAmountDollars ? discountAmountDollars * 100 : undefined,
            duration: 'forever',
            reason: discountReason,
          });

          if (stripeDiscount) {
            couponId = stripeDiscount.coupon_id;
            // Also save to the org record
            await orgDb.setDiscount(org.workos_organization_id, {
              discount_percent: discountPercent ?? null,
              discount_amount_cents: discountAmountDollars ? discountAmountDollars * 100 : null,
              reason: discountReason,
              granted_by: grantedBy,
              stripe_coupon_id: stripeDiscount.coupon_id,
              stripe_promotion_code: stripeDiscount.promotion_code,
            });
            appliedDiscount = discountPercent ? `${discountPercent}% off` : `$${discountAmountDollars} off`;
            logger.info({
              orgId: org.workos_organization_id,
              discount: appliedDiscount,
              reason: discountReason,
            }, 'Created discount for payment link');
          }
        } else if (useExistingDiscount && org.stripe_coupon_id) {
          // Use the org's existing discount
          couponId = org.stripe_coupon_id;
          appliedDiscount = org.discount_percent
            ? `${org.discount_percent}% off`
            : `$${(org.discount_amount_cents || 0) / 100} off`;
        }

        const session = await createCheckoutSession({
          priceId: finalProduct.price_id,
          customerEmail: emailToUse || undefined,
          successUrl: `${baseUrl}/dashboard?payment=success`,
          cancelUrl: `${baseUrl}/membership?payment=cancelled`,
          workosOrganizationId: org.workos_organization_id,
          isPersonalWorkspace: org.is_personal,
          couponId, // Pre-apply the discount if available
        });

        if (!session?.url) {
          return response + `\n❌ Failed to generate payment link. Stripe may not be configured.`;
        }

        response += `### 💳 Payment Link Generated\n\n`;
        response += `**Product:** ${finalProduct.display_name}\n`;
        if (finalProduct.amount_cents) {
          const originalAmount = finalProduct.amount_cents / 100;
          response += `**Amount:** $${originalAmount.toLocaleString()}/year\n`;
        }
        if (appliedDiscount) {
          response += `**Discount:** ${appliedDiscount} (pre-applied)\n`;
        }
        response += `\n**Payment Link:**\n${session.url}\n`;
        response += `\n_Share this link with ${org.prospect_contact_name || emailToUse || 'the prospect'}. It expires in 24 hours._`;

        logger.info(
          { orgId: org.workos_organization_id, orgName: org.name, product: finalProduct.lookup_key, discount: appliedDiscount },
          'Addie generated payment link'
        );

        return response;
      } catch (err) {
        logger.error({ err, orgId: org.workos_organization_id }, 'Failed to create checkout session');
        return response + `\n❌ Failed to create payment link: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }

    // Send invoice
    if (action === 'invoice') {
      if (!emailToUse) {
        return response + `\n❌ Cannot send invoice without an email address. Please provide contact_email.`;
      }

      if (!billingAddress?.line1 || !billingAddress?.city || !billingAddress?.postal_code || !billingAddress?.country) {
        response += `### 📄 Invoice - Need Billing Address\n\n`;
        response += `To send an invoice, I need the full billing address:\n`;
        response += `• line1 (street address)\n`;
        response += `• city\n`;
        response += `• state (if applicable)\n`;
        response += `• postal_code\n`;
        response += `• country (two-letter code, e.g., "US")\n`;
        response += `\n_Call this tool again with the billing_address to send the invoice._`;
        return response;
      }

      if (!finalProduct) {
        return response + `\n❌ No membership products available. Please check Stripe configuration.`;
      }

      try {
        // Handle discounts for invoices (similar to payment links)
        let couponId: string | undefined;
        let appliedDiscount: string | undefined;

        // Check if a new discount was requested
        if (discountPercent !== undefined || discountAmountDollars !== undefined) {
          if (!discountReason) {
            return response + `\n❌ Please provide a discount_reason when applying a discount.`;
          }

          // Create a new discount/coupon for this org
          const grantedBy = memberContext?.workos_user?.email || 'Addie';
          const stripeDiscount = await createOrgDiscount(org.workos_organization_id, org.name, {
            percent_off: discountPercent,
            amount_off_cents: discountAmountDollars ? discountAmountDollars * 100 : undefined,
            duration: 'forever',
            reason: discountReason,
          });

          if (stripeDiscount) {
            couponId = stripeDiscount.coupon_id;
            // Also save to the org record
            await orgDb.setDiscount(org.workos_organization_id, {
              discount_percent: discountPercent ?? null,
              discount_amount_cents: discountAmountDollars ? discountAmountDollars * 100 : null,
              reason: discountReason,
              granted_by: grantedBy,
              stripe_coupon_id: stripeDiscount.coupon_id,
              stripe_promotion_code: stripeDiscount.promotion_code,
            });
            appliedDiscount = discountPercent ? `${discountPercent}% off` : `$${discountAmountDollars} off`;
            logger.info({
              orgId: org.workos_organization_id,
              discount: appliedDiscount,
              reason: discountReason,
            }, 'Created discount for invoice');
          }
        } else if (useExistingDiscount && org.stripe_coupon_id) {
          // Use the org's existing discount
          couponId = org.stripe_coupon_id;
          appliedDiscount = org.discount_percent
            ? `${org.discount_percent}% off`
            : `$${(org.discount_amount_cents || 0) / 100} off`;
        }

        const invoiceResult = await createAndSendInvoice({
          companyName: org.name,
          contactName: org.prospect_contact_name || contactName || 'Billing',
          contactEmail: emailToUse,
          billingAddress: {
            line1: billingAddress.line1,
            line2: billingAddress.line2,
            city: billingAddress.city || '',
            state: billingAddress.state || '',
            postal_code: billingAddress.postal_code || '',
            country: billingAddress.country || 'US',
          },
          lookupKey: finalProduct.lookup_key || '',
          workosOrganizationId: org.workos_organization_id,
          couponId, // Apply discount if available
        });

        if (!invoiceResult) {
          return response + `\n❌ Failed to create invoice. Stripe may not be configured.`;
        }

        response += `### 📧 Invoice Sent!\n\n`;
        response += `**Product:** ${finalProduct.display_name}\n`;
        if (finalProduct.amount_cents) {
          const originalAmount = finalProduct.amount_cents / 100;
          response += `**Amount:** $${originalAmount.toLocaleString()}`;
          if (appliedDiscount) {
            // Calculate discounted amount for display
            let discountedAmount = originalAmount;
            if (discountPercent) {
              discountedAmount = originalAmount * (1 - discountPercent / 100);
            } else if (discountAmountDollars) {
              discountedAmount = originalAmount - discountAmountDollars;
            }
            response += ` → **$${discountedAmount.toLocaleString()}** (${appliedDiscount} applied)`;
          }
          response += `\n`;
        }
        response += `**Sent to:** ${emailToUse}\n`;
        response += `**Invoice ID:** ${invoiceResult.invoiceId}\n`;
        if (invoiceResult.invoiceUrl) {
          response += `\n**Invoice URL:**\n${invoiceResult.invoiceUrl}\n`;
        }
        response += `\n_Stripe will email the invoice with a payment link. They have 30 days to pay._`;

        logger.info(
          { orgId: org.workos_organization_id, orgName: org.name, invoiceId: invoiceResult.invoiceId, discount: appliedDiscount },
          'Addie sent invoice'
        );

        return response;
      } catch (err) {
        logger.error({ err, orgId: org.workos_organization_id }, 'Failed to send invoice');
        return response + `\n❌ Failed to send invoice: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }

    return response + `\n❌ Unknown action: ${action}. Use "payment_link", "invoice", or "lookup_only".`;
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

    // Check for similar/duplicate feeds before adding
    try {
      const similarFeeds = await findSimilarFeeds(feedUrl);
      if (similarFeeds.length > 0) {
        let response = `⚠️ Found similar feed(s) that may be duplicates:\n\n`;
        for (const existing of similarFeeds) {
          const status = existing.is_active ? '✅' : '⏸️';
          response += `${status} **${existing.name}** (ID: ${existing.id})\n`;
          response += `   URL: ${existing.feed_url}\n`;
          if (existing.category) response += `   Category: ${existing.category}\n`;
          response += `\n`;
        }
        response += `If you still want to add "${name}", the feed URL needs to be different from existing feeds. `;
        response += `If this is a duplicate, you can reactivate an existing feed instead.`;
        return response;
      }
    } catch (error) {
      logger.warn({ error, feedUrl }, 'Error checking for similar feeds, proceeding with add');
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

  // ============================================
  // FEED PROPOSAL REVIEW HANDLERS
  // ============================================

  // List pending proposals
  handlers.set('list_feed_proposals', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const limit = Math.min(Math.max((input.limit as number) || 20, 1), 50);

    try {
      const proposals = await getPendingProposals(limit);
      const stats = await getProposalStats();

      if (proposals.length === 0) {
        return `No pending feed proposals.\n\n**Stats:** ${stats.approved} approved, ${stats.rejected} rejected, ${stats.duplicate} duplicates`;
      }

      let response = `## Pending Feed Proposals\n\n`;
      response += `**Pending:** ${stats.pending} | **Approved:** ${stats.approved} | **Rejected:** ${stats.rejected}\n\n`;

      for (const proposal of proposals) {
        response += `### Proposal #${proposal.id}\n`;
        response += `**URL:** ${proposal.url}\n`;
        if (proposal.name) response += `**Suggested name:** ${proposal.name}\n`;
        if (proposal.category) response += `**Category:** ${proposal.category}\n`;
        if (proposal.reason) response += `**Reason:** ${proposal.reason}\n`;
        response += `**Proposed:** ${proposal.proposed_at.toLocaleDateString()}`;
        if (proposal.proposed_by_slack_user_id) {
          response += ` by <@${proposal.proposed_by_slack_user_id}>`;
        }
        response += `\n\n`;
      }

      response += `_Use \`approve_feed_proposal\` or \`reject_feed_proposal\` to review._`;
      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing feed proposals');
      return '❌ Failed to list proposals. Please try again.';
    }
  });

  // Approve a proposal
  handlers.set('approve_feed_proposal', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const proposalId = Number(input.proposal_id);
    const feedName = (input.feed_name as string)?.trim();
    const feedUrl = (input.feed_url as string)?.trim();
    const category = input.category as string | undefined;

    if (!Number.isInteger(proposalId) || proposalId <= 0) {
      return '❌ Proposal ID must be a positive integer.';
    }
    if (!feedName) {
      return '❌ Feed name is required.';
    }
    if (!feedUrl) {
      return '❌ Feed URL is required.';
    }

    // Validate URL
    try {
      new URL(feedUrl);
    } catch {
      return `❌ Invalid feed URL: ${feedUrl}`;
    }

    // Check for duplicates
    try {
      const similarFeeds = await findSimilarFeeds(feedUrl);
      if (similarFeeds.length > 0) {
        let response = `⚠️ Cannot approve - similar feed already exists:\n\n`;
        for (const existing of similarFeeds) {
          response += `**${existing.name}** (ID: ${existing.id})\n`;
          response += `URL: ${existing.feed_url}\n\n`;
        }
        response += `Consider rejecting this proposal as a duplicate.`;
        return response;
      }
    } catch (error) {
      logger.warn({ error }, 'Error checking for duplicates during proposal approval');
    }

    try {
      const workosUserId = memberContext?.workos_user?.workos_user_id || 'unknown';
      const { proposal, feed } = await approveProposal(
        proposalId,
        workosUserId,
        feedName,
        feedUrl,
        category
      );

      let response = `✅ **Proposal #${proposalId} approved!**\n\n`;
      response += `**Feed created:** ${feedName} (ID: ${feed.id})\n`;
      response += `**URL:** ${feedUrl}\n`;
      if (category) response += `**Category:** ${category}\n`;
      response += `\n_The feed will be fetched on the next scheduled run._`;

      logger.info({ proposalId, feedId: feed.id, feedName }, 'Feed proposal approved');
      return response;
    } catch (error) {
      logger.error({ error, proposalId }, 'Error approving proposal');
      if (error instanceof Error && error.message.includes('duplicate')) {
        return `❌ A feed with this URL already exists.`;
      }
      return '❌ Failed to approve proposal. Please try again.';
    }
  });

  // Reject a proposal
  handlers.set('reject_feed_proposal', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const proposalId = Number(input.proposal_id);
    const reason = input.reason as string | undefined;

    if (!Number.isInteger(proposalId) || proposalId <= 0) {
      return '❌ Proposal ID must be a positive integer.';
    }

    try {
      const workosUserId = memberContext?.workos_user?.workos_user_id || 'unknown';
      const proposal = await rejectProposal(proposalId, workosUserId, reason);

      let response = `✅ **Proposal #${proposalId} rejected.**\n`;
      if (reason) response += `**Reason:** ${reason}\n`;

      logger.info({ proposalId, reason }, 'Feed proposal rejected');
      return response;
    } catch (error) {
      logger.error({ error, proposalId }, 'Error rejecting proposal');
      return '❌ Failed to reject proposal. Please try again.';
    }
  });

  // ============================================
  // SENSITIVE TOPICS & MEDIA CONTACT HANDLERS
  // ============================================

  const insightsDb = new InsightsDatabase();

  // Add media contact
  handlers.set('add_media_contact', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const slackUserId = input.slack_user_id as string | undefined;
    const email = input.email as string | undefined;
    const name = input.name as string | undefined;
    const organization = input.organization as string | undefined;
    const role = input.role as string | undefined;
    const notes = input.notes as string | undefined;
    const handlingLevel = (input.handling_level as 'standard' | 'careful' | 'executive_only') || 'standard';

    if (!slackUserId && !email) {
      return '❌ Please provide either a slack_user_id or email to identify the media contact.';
    }

    try {
      const contact = await insightsDb.addMediaContact({
        slackUserId,
        email,
        name,
        organization,
        role,
        notes,
        handlingLevel,
      });

      let response = `✅ Added media contact\n\n`;
      if (contact.name) response += `**Name:** ${contact.name}\n`;
      if (contact.organization) response += `**Organization:** ${contact.organization}\n`;
      if (contact.role) response += `**Role:** ${contact.role}\n`;
      if (contact.slackUserId) response += `**Slack ID:** ${contact.slackUserId}\n`;
      if (contact.email) response += `**Email:** ${contact.email}\n`;
      response += `**Handling Level:** ${contact.handlingLevel}\n`;

      const levelExplanation = {
        standard: 'Sensitive topics will be deflected to human contacts.',
        careful: 'More topics will be deflected, extra caution applied.',
        executive_only: 'All questions will be escalated for executive review.',
      };
      response += `\n_${levelExplanation[contact.handlingLevel]}_`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error adding media contact');
      return '❌ Failed to add media contact. Please try again.';
    }
  });

  // List flagged conversations
  handlers.set('list_flagged_conversations', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const unreviewedOnly = input.unreviewed_only !== false; // Default to true
    const severity = input.severity as 'high' | 'medium' | 'low' | undefined;
    const limit = Math.min(Math.max((input.limit as number) || 20, 1), 100);

    try {
      const flagged = await insightsDb.getFlaggedConversations({
        unreviewedOnly,
        severity,
        limit,
      });

      if (flagged.length === 0) {
        let msg = 'No flagged conversations found';
        if (unreviewedOnly) msg += ' pending review';
        if (severity) msg += ` with severity "${severity}"`;
        return msg + '. 🎉';
      }

      let response = `## Flagged Conversations`;
      if (unreviewedOnly) response += ` (Pending Review)`;
      response += `\n\n`;

      const severityIcon = {
        high: '🔴',
        medium: '🟡',
        low: '🟢',
      };

      for (const conv of flagged) {
        const icon = severityIcon[conv.severity || 'low'];
        response += `### ${icon} ID: ${conv.id}\n`;
        if (conv.userName) response += `**From:** ${conv.userName}`;
        if (conv.userEmail) response += ` (${conv.userEmail})`;
        response += `\n`;
        response += `**Category:** ${conv.matchedCategory || 'unknown'}\n`;
        response += `**Message:** "${conv.messageText.substring(0, 150)}${conv.messageText.length > 150 ? '...' : ''}"\n`;
        if (conv.wasDeflected) {
          response += `**Deflected:** Yes\n`;
          if (conv.responseGiven) {
            response += `**Response:** "${conv.responseGiven.substring(0, 100)}..."\n`;
          }
        }
        response += `**When:** ${formatDate(conv.createdAt)}\n`;
        response += `\n`;
      }

      response += `\n_Use review_flagged_conversation to mark items as reviewed._`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing flagged conversations');
      return '❌ Failed to list flagged conversations. Please try again.';
    }
  });

  // Review flagged conversation
  handlers.set('review_flagged_conversation', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const flaggedId = input.flagged_id as number;
    const notes = input.notes as string | undefined;

    if (!flaggedId) {
      return '❌ Please provide the flagged_id to review.';
    }

    try {
      // Get reviewer user ID from member context if available
      const reviewerId = memberContext?.workos_user?.workos_user_id
        ? parseInt(memberContext.workos_user.workos_user_id, 10) || 0
        : 0;

      await insightsDb.reviewFlaggedConversation(flaggedId, reviewerId, notes);

      let response = `✅ Marked conversation #${flaggedId} as reviewed.\n`;
      if (notes) {
        response += `\n**Notes:** ${notes}`;
      }

      return response;
    } catch (error) {
      logger.error({ error, flaggedId }, 'Error reviewing flagged conversation');
      return '❌ Failed to mark conversation as reviewed. Please check the ID and try again.';
    }
  });

  // ============================================
  // DISCOUNT MANAGEMENT HANDLERS
  // ============================================

  // Grant discount to an organization
  handlers.set('grant_discount', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const orgId = input.org_id as string | undefined;
    const orgName = input.org_name as string | undefined;
    const discountPercent = input.discount_percent as number | undefined;
    const discountAmountDollars = input.discount_amount_dollars as number | undefined;
    const reason = input.reason as string;
    const createPromoCode = input.create_promotion_code !== false; // default true

    // Validate inputs
    if (!reason) {
      return '❌ Please provide a reason for the discount.';
    }

    if (discountPercent === undefined && discountAmountDollars === undefined) {
      return '❌ Please provide either discount_percent or discount_amount_dollars.';
    }

    if (discountPercent !== undefined && discountAmountDollars !== undefined) {
      return '❌ Please provide either discount_percent OR discount_amount_dollars, not both.';
    }

    if (discountPercent !== undefined && (discountPercent < 1 || discountPercent > 100)) {
      return '❌ Discount percent must be between 1 and 100.';
    }

    if (discountAmountDollars !== undefined && discountAmountDollars < 1) {
      return '❌ Discount amount must be a positive number.';
    }

    try {
      // Find the organization
      let org;
      if (orgId) {
        org = await orgDb.getOrganization(orgId);
      } else if (orgName) {
        const orgs = await orgDb.searchOrganizations({ query: orgName, limit: 1 });
        if (orgs.length > 0) {
          org = await orgDb.getOrganization(orgs[0].workos_organization_id);
        }
      } else {
        return '❌ Please provide either org_id or org_name to identify the organization.';
      }

      if (!org) {
        return `❌ Organization not found${orgName ? ` matching "${orgName}"` : ''}.`;
      }

      // Get the admin's name for attribution
      const grantedBy = memberContext?.workos_user?.email || 'Unknown admin';

      let stripeCouponId: string | null = null;
      let stripePromoCode: string | null = null;

      // Create Stripe coupon if requested
      if (createPromoCode) {
        const stripeDiscount = await createOrgDiscount(org.workos_organization_id, org.name, {
          percent_off: discountPercent,
          amount_off_cents: discountAmountDollars ? discountAmountDollars * 100 : undefined,
          duration: 'forever',
          reason,
        });

        if (stripeDiscount) {
          stripeCouponId = stripeDiscount.coupon_id;
          stripePromoCode = stripeDiscount.promotion_code;
        }
      }

      // Update the organization
      await orgDb.setDiscount(org.workos_organization_id, {
        discount_percent: discountPercent ?? null,
        discount_amount_cents: discountAmountDollars ? discountAmountDollars * 100 : null,
        reason,
        granted_by: grantedBy,
        stripe_coupon_id: stripeCouponId,
        stripe_promotion_code: stripePromoCode,
      });

      logger.info({
        orgId: org.workos_organization_id,
        orgName: org.name,
        discountPercent,
        discountAmountDollars,
        grantedBy,
        stripePromoCode,
      }, 'Addie: Granted discount to organization');

      // Build response
      const discountDescription = discountPercent
        ? `${discountPercent}% off`
        : `$${discountAmountDollars} off`;

      let response = `✅ Granted **${discountDescription}** discount to **${org.name}**\n\n`;
      response += `**Reason:** ${reason}\n`;
      response += `**Granted by:** ${grantedBy}\n`;

      if (stripePromoCode) {
        response += `\n**Promotion Code:** \`${stripePromoCode}\`\n`;
        response += `_The customer can enter this code at checkout to receive their discount._`;
      } else {
        response += `\n_No Stripe promotion code was created. The discount is recorded but the customer will need a manual adjustment._`;
      }

      return response;
    } catch (error) {
      logger.error({ error, orgId, orgName }, 'Error granting discount');
      return '❌ Failed to grant discount. Please try again.';
    }
  });

  // Remove discount from an organization
  handlers.set('remove_discount', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const orgId = input.org_id as string | undefined;
    const orgName = input.org_name as string | undefined;

    try {
      // Find the organization
      let org;
      if (orgId) {
        org = await orgDb.getOrganization(orgId);
      } else if (orgName) {
        const orgs = await orgDb.searchOrganizations({ query: orgName, limit: 1 });
        if (orgs.length > 0) {
          org = await orgDb.getOrganization(orgs[0].workos_organization_id);
        }
      } else {
        return '❌ Please provide either org_id or org_name to identify the organization.';
      }

      if (!org) {
        return `❌ Organization not found${orgName ? ` matching "${orgName}"` : ''}.`;
      }

      if (!org.discount_percent && !org.discount_amount_cents) {
        return `ℹ️ **${org.name}** doesn't have an active discount.`;
      }

      const previousDiscount = org.discount_percent
        ? `${org.discount_percent}% off`
        : `$${(org.discount_amount_cents || 0) / 100} off`;

      await orgDb.removeDiscount(org.workos_organization_id);

      logger.info({
        orgId: org.workos_organization_id,
        orgName: org.name,
        previousDiscount,
        removedBy: memberContext?.workos_user?.email,
      }, 'Addie: Removed discount from organization');

      let response = `✅ Removed discount from **${org.name}**\n\n`;
      response += `**Previous discount:** ${previousDiscount}\n`;

      if (org.stripe_coupon_id) {
        response += `\n_Note: The Stripe coupon (${org.stripe_coupon_id}) still exists. If needed, delete it from the Stripe dashboard._`;
      }

      return response;
    } catch (error) {
      logger.error({ error, orgId, orgName }, 'Error removing discount');
      return '❌ Failed to remove discount. Please try again.';
    }
  });

  // List organizations with active discounts
  handlers.set('list_discounts', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const limit = (input.limit as number) || 20;

    try {
      const orgsWithDiscounts = await orgDb.listOrganizationsWithDiscounts();

      if (orgsWithDiscounts.length === 0) {
        return 'ℹ️ No organizations currently have active discounts.';
      }

      const limited = orgsWithDiscounts.slice(0, limit);

      let response = `## Organizations with Active Discounts\n\n`;
      response += `Found **${orgsWithDiscounts.length}** organization(s) with discounts:\n\n`;

      for (const org of limited) {
        const discountDescription = org.discount_percent
          ? `${org.discount_percent}% off`
          : `$${(org.discount_amount_cents || 0) / 100} off`;

        response += `### ${org.name}\n`;
        response += `**Discount:** ${discountDescription}\n`;
        response += `**Reason:** ${org.discount_reason || 'Not specified'}\n`;
        response += `**Granted by:** ${org.discount_granted_by || 'Unknown'}\n`;

        if (org.discount_granted_at) {
          response += `**When:** ${formatDate(new Date(org.discount_granted_at))}\n`;
        }

        if (org.stripe_promotion_code) {
          response += `**Promo Code:** \`${org.stripe_promotion_code}\`\n`;
        }

        response += '\n';
      }

      if (orgsWithDiscounts.length > limit) {
        response += `_Showing ${limit} of ${orgsWithDiscounts.length} organizations._`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing discounts');
      return '❌ Failed to list discounts. Please try again.';
    }
  });

  // Create standalone promotion code
  handlers.set('create_promotion_code', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const code = input.code as string;
    const name = input.name as string | undefined;
    const percentOff = input.percent_off as number | undefined;
    const amountOffDollars = input.amount_off_dollars as number | undefined;
    const duration = (input.duration as 'once' | 'repeating' | 'forever') || 'once';
    const maxRedemptions = input.max_redemptions as number | undefined;

    // Validate inputs
    if (!code) {
      return '❌ Please provide a promotion code.';
    }

    if (percentOff === undefined && amountOffDollars === undefined) {
      return '❌ Please provide either percent_off or amount_off_dollars.';
    }

    if (percentOff !== undefined && amountOffDollars !== undefined) {
      return '❌ Please provide either percent_off OR amount_off_dollars, not both.';
    }

    if (percentOff !== undefined && (percentOff < 1 || percentOff > 100)) {
      return '❌ Percent off must be between 1 and 100.';
    }

    if (amountOffDollars !== undefined && amountOffDollars < 1) {
      return '❌ Amount off must be a positive number.';
    }

    try {
      const createdBy = memberContext?.workos_user?.email || 'Unknown admin';

      // Create the coupon
      const coupon = await createCoupon({
        name: name || `Promotion: ${code}`,
        percent_off: percentOff,
        amount_off_cents: amountOffDollars ? amountOffDollars * 100 : undefined,
        duration,
        max_redemptions: maxRedemptions,
        metadata: {
          created_by: createdBy,
        },
      });

      if (!coupon) {
        return '❌ Failed to create coupon in Stripe. Please try again.';
      }

      // Create the promotion code
      const promoCode = await createPromotionCode({
        coupon_id: coupon.coupon_id,
        code,
        max_redemptions: maxRedemptions,
        metadata: {
          created_by: createdBy,
        },
      });

      if (!promoCode) {
        return `⚠️ Coupon created but failed to create promotion code. Coupon ID: ${coupon.coupon_id}`;
      }

      logger.info({
        couponId: coupon.coupon_id,
        code: promoCode.code,
        createdBy,
      }, 'Addie: Created standalone promotion code');

      const discountDescription = percentOff
        ? `${percentOff}% off`
        : `$${amountOffDollars} off`;

      let response = `✅ Created promotion code **${promoCode.code}**\n\n`;
      response += `**Discount:** ${discountDescription}\n`;
      response += `**Duration:** ${duration}\n`;

      if (maxRedemptions) {
        response += `**Max uses:** ${maxRedemptions}\n`;
      }

      response += `**Created by:** ${createdBy}\n`;
      response += `\n_Customers can enter this code at checkout to receive their discount._`;

      return response;
    } catch (error) {
      logger.error({ error, code }, 'Error creating promotion code');
      return '❌ Failed to create promotion code. Please try again.';
    }
  });

  // ============================================
  // CHAPTER MANAGEMENT HANDLERS
  // ============================================

  // Create chapter
  handlers.set('create_chapter', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const name = (input.name as string)?.trim();
    const region = (input.region as string)?.trim();
    const foundingMemberId = input.founding_member_id as string | undefined;
    const description = input.description as string | undefined;

    if (!name) {
      return '❌ Please provide a chapter name (e.g., "Austin Chapter").';
    }

    if (!region) {
      return '❌ Please provide a region (e.g., "Austin", "Bay Area").';
    }

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 50);

    try {
      // Check if chapter with this slug already exists
      const existingChapter = await wgDb.getWorkingGroupBySlug(slug);
      if (existingChapter) {
        return `⚠️ A chapter with slug "${slug}" already exists: **${existingChapter.name}**\n\nJoin their Slack channel: ${existingChapter.slack_channel_url || 'Not set'}`;
      }

      // Create Slack channel first
      const channelResult = await createChannel(slug);
      if (!channelResult) {
        return `❌ Failed to create Slack channel #${slug}. The channel name might already be taken. Try a different chapter name.`;
      }

      // Set channel purpose
      const purpose = description || `Connect with AgenticAdvertising.org members in the ${region} area.`;
      await setChannelPurpose(channelResult.channel.id, purpose);

      // Create the chapter working group
      const chapter = await wgDb.createChapter({
        name,
        slug,
        region,
        description: purpose,
        slack_channel_url: channelResult.url,
        slack_channel_id: channelResult.channel.id,
        founding_member_id: foundingMemberId,
      });

      logger.info({
        chapterId: chapter.id,
        name: chapter.name,
        region,
        slackChannelId: channelResult.channel.id,
        foundingMemberId,
      }, 'Addie: Created new regional chapter');

      let response = `✅ Created **${name}**!\n\n`;
      response += `**Region:** ${region}\n`;
      response += `**Slack Channel:** <#${channelResult.channel.id}>\n`;
      response += `**Channel URL:** ${channelResult.url}\n`;

      if (foundingMemberId) {
        response += `\n🎉 The founding member has been set as chapter leader.\n`;
      }

      response += `\n_Anyone who joins the Slack channel will automatically be added to the chapter._`;

      return response;
    } catch (error) {
      logger.error({ error, name, region }, 'Error creating chapter');
      return '❌ Failed to create chapter. Please try again.';
    }
  });

  // List chapters
  handlers.set('list_chapters', async () => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    try {
      const chapters = await wgDb.getChapters();

      if (chapters.length === 0) {
        return 'ℹ️ No regional chapters exist yet. Use create_chapter to start one!';
      }

      let response = `## Regional Chapters\n\n`;
      response += `Found **${chapters.length}** chapter(s):\n\n`;

      for (const chapter of chapters) {
        response += `### ${chapter.name}\n`;
        response += `**Region:** ${chapter.region || 'Not set'}\n`;
        response += `**Members:** ${chapter.member_count}\n`;

        if (chapter.slack_channel_id) {
          response += `**Slack:** <#${chapter.slack_channel_id}>\n`;
        } else {
          response += `**Slack:** _No channel linked_\n`;
        }

        if (chapter.leaders && chapter.leaders.length > 0) {
          const leaderNames = chapter.leaders.map(l => l.name || 'Unknown').join(', ');
          response += `**Leaders:** ${leaderNames}\n`;
        }

        response += '\n';
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing chapters');
      return '❌ Failed to list chapters. Please try again.';
    }
  });

  // ============================================
  // INDUSTRY GATHERING HANDLERS
  // ============================================

  // Create industry gathering
  handlers.set('create_industry_gathering', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const name = (input.name as string)?.trim();
    const startDateStr = input.start_date as string;
    const endDateStr = input.end_date as string | undefined;
    const location = (input.location as string)?.trim();
    const websiteUrl = input.website_url as string | undefined;
    const description = input.description as string | undefined;
    const foundingMemberId = input.founding_member_id as string | undefined;

    if (!name) {
      return '❌ Please provide a gathering name (e.g., "CES 2026").';
    }

    if (!startDateStr) {
      return '❌ Please provide a start date in YYYY-MM-DD format.';
    }

    if (!location) {
      return '❌ Please provide an event location (e.g., "Las Vegas, NV").';
    }

    // Parse dates
    const startDate = new Date(startDateStr);
    if (isNaN(startDate.getTime())) {
      return '❌ Invalid start date format. Please use YYYY-MM-DD.';
    }

    let endDate: Date | undefined;
    if (endDateStr) {
      endDate = new Date(endDateStr);
      if (isNaN(endDate.getTime())) {
        return '❌ Invalid end date format. Please use YYYY-MM-DD.';
      }
    }

    // Generate slug from name
    const nameSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    try {
      // Check if gathering with this slug already exists
      const year = startDate.getFullYear();
      const fullSlug = `industry-gatherings/${year}/${nameSlug}`;
      const existingGathering = await wgDb.getWorkingGroupBySlug(fullSlug);
      if (existingGathering) {
        return `⚠️ An industry gathering with slug "${fullSlug}" already exists: **${existingGathering.name}**\n\nJoin their Slack channel: ${existingGathering.slack_channel_url || 'Not set'}`;
      }

      // Create Slack channel (use shortened slug for channel name)
      const channelSlug = `${nameSlug.slice(0, 30)}`;
      const channelResult = await createChannel(channelSlug);
      if (!channelResult) {
        return `❌ Failed to create Slack channel #${channelSlug}. The channel name might already be taken. Try a different gathering name.`;
      }

      // Set channel purpose
      const purpose = description || `Coordinate AgenticAdvertising.org attendance at ${name} (${location}).`;
      await setChannelPurpose(channelResult.channel.id, purpose);

      // Create the industry gathering
      const gathering = await wgDb.createIndustryGathering({
        name,
        slug: nameSlug,
        description: purpose,
        slack_channel_url: channelResult.url,
        slack_channel_id: channelResult.channel.id,
        start_date: startDate,
        end_date: endDate,
        location,
        website_url: websiteUrl,
        founding_member_id: foundingMemberId,
      });

      logger.info({
        gatheringId: gathering.id,
        name: gathering.name,
        location,
        startDate: startDateStr,
        endDate: endDateStr,
        slackChannelId: channelResult.channel.id,
        foundingMemberId,
      }, 'Addie: Created new industry gathering');

      let response = `✅ Created **${name}** industry gathering!\n\n`;
      response += `**Location:** ${location}\n`;
      response += `**Dates:** ${startDateStr}${endDateStr ? ` to ${endDateStr}` : ''}\n`;
      response += `**Slack Channel:** <#${channelResult.channel.id}>\n`;
      response += `**Channel URL:** ${channelResult.url}\n`;
      if (websiteUrl) {
        response += `**Event Website:** ${websiteUrl}\n`;
      }

      if (foundingMemberId) {
        response += `\n🎉 The founding member has been set as gathering leader.\n`;
      }

      response += `\n_Members can join the Slack channel to coordinate attendance. The gathering will auto-archive after the event ends._`;

      return response;
    } catch (error) {
      logger.error({ error, name, location }, 'Error creating industry gathering');
      return '❌ Failed to create industry gathering. Please try again.';
    }
  });

  // List industry gatherings
  handlers.set('list_industry_gatherings', async () => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    try {
      const gatherings = await wgDb.getIndustryGatherings();

      if (gatherings.length === 0) {
        return 'ℹ️ No industry gatherings exist yet. Use create_industry_gathering to start one!';
      }

      let response = `## Industry Gatherings\n\n`;
      response += `Found **${gatherings.length}** gathering(s):\n\n`;

      for (const gathering of gatherings) {
        response += `### ${gathering.name}\n`;
        response += `**Location:** ${gathering.event_location || 'Not set'}\n`;

        if (gathering.event_start_date) {
          const startStr = new Date(gathering.event_start_date).toISOString().split('T')[0];
          const endStr = gathering.event_end_date
            ? new Date(gathering.event_end_date).toISOString().split('T')[0]
            : null;
          response += `**Dates:** ${startStr}${endStr ? ` to ${endStr}` : ''}\n`;
        }

        response += `**Members:** ${gathering.member_count}\n`;

        if (gathering.slack_channel_id) {
          response += `**Slack:** <#${gathering.slack_channel_id}>\n`;
        } else {
          response += `**Slack:** _No channel linked_\n`;
        }

        if (gathering.website_url) {
          response += `**Website:** ${gathering.website_url}\n`;
        }

        response += '\n';
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing industry gatherings');
      return '❌ Failed to list industry gatherings. Please try again.';
    }
  });

  // ============================================
  // COMMITTEE LEADERSHIP HANDLERS
  // ============================================

  // Add committee leader
  handlers.set('add_committee_leader', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const committeeSlug = (input.committee_slug as string)?.trim();
    let userId = (input.user_id as string)?.trim();
    const userEmail = input.user_email as string | undefined;

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "ces-2026", "creative-wg").';
    }

    if (!userId) {
      return '❌ Please provide a user_id (WorkOS user ID).';
    }

    try {
      // If a Slack user ID was passed (U followed by 8+ alphanumeric chars), resolve to WorkOS user ID
      const slackUserIdPattern = /^U[A-Z0-9]{8,}$/;
      if (slackUserIdPattern.test(userId)) {
        const slackMapping = await slackDb.getBySlackUserId(userId);
        if (slackMapping?.workos_user_id) {
          logger.info({ slackUserId: userId, workosUserId: slackMapping.workos_user_id }, 'Resolved Slack user ID to WorkOS user ID');
          userId = slackMapping.workos_user_id;
        } else {
          // Keep the Slack ID - the display query will look up the name from slack_user_mappings
          logger.warn({ slackUserId: userId }, 'Slack user ID not mapped to WorkOS user - using Slack ID directly');
        }
      }

      // Find the committee
      const committee = await wgDb.getWorkingGroupBySlug(committeeSlug);
      if (!committee) {
        return `❌ Committee "${committeeSlug}" not found. Use list_working_groups, list_chapters, or list_industry_gatherings to find the correct slug.`;
      }

      // Check if already a leader
      const leaders = await wgDb.getLeaders(committee.id);
      if (leaders.some((l: { user_id: string }) => l.user_id === userId)) {
        return `ℹ️ User is already a leader of "${committee.name}".`;
      }

      // Add as leader
      await wgDb.addLeader(committee.id, userId);

      // Also ensure they're a member
      const memberships = await wgDb.getMembershipsByWorkingGroup(committee.id);
      if (!memberships.some(m => m.workos_user_id === userId)) {
        await wgDb.addMembership({
          working_group_id: committee.id,
          workos_user_id: userId,
          user_email: userEmail,
        });
      }

      logger.info({ committeeSlug, committeeName: committee.name, userId, userEmail }, 'Added committee leader via Addie');

      const emailInfo = userEmail ? ` (${userEmail})` : '';
      return `✅ Successfully added user ${userId}${emailInfo} as a leader of **${committee.name}**.

They now have management access to:
- Create and manage events
- Create and manage posts
- Manage committee members

Committee management page: https://agenticadvertising.org/working-groups/${committeeSlug}/manage`;
    } catch (error) {
      logger.error({ error, committeeSlug, userId }, 'Error adding committee leader');
      return '❌ Failed to add committee leader. Please try again.';
    }
  });

  // Remove committee leader
  handlers.set('remove_committee_leader', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const committeeSlug = (input.committee_slug as string)?.trim();
    let userId = (input.user_id as string)?.trim();

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug.';
    }

    if (!userId) {
      return '❌ Please provide a user_id.';
    }

    try {
      // If a Slack user ID was passed (U followed by 8+ alphanumeric chars), resolve to WorkOS user ID
      const slackUserIdPattern = /^U[A-Z0-9]{8,}$/;
      if (slackUserIdPattern.test(userId)) {
        const slackMapping = await slackDb.getBySlackUserId(userId);
        if (slackMapping?.workos_user_id) {
          logger.info({ slackUserId: userId, workosUserId: slackMapping.workos_user_id }, 'Resolved Slack user ID to WorkOS user ID');
          userId = slackMapping.workos_user_id;
        }
      }

      const committee = await wgDb.getWorkingGroupBySlug(committeeSlug);
      if (!committee) {
        return `❌ Committee "${committeeSlug}" not found.`;
      }

      // Check if they are a leader
      const leaders = await wgDb.getLeaders(committee.id);
      if (!leaders.some((l: { user_id: string }) => l.user_id === userId)) {
        return `ℹ️ User ${userId} is not a leader of "${committee.name}".`;
      }

      await wgDb.removeLeader(committee.id, userId);

      logger.info({ committeeSlug, committeeName: committee.name, userId }, 'Removed committee leader via Addie');

      return `✅ Successfully removed user ${userId} as a leader of **${committee.name}**.

They are still a member but no longer have management access.`;
    } catch (error) {
      logger.error({ error, committeeSlug, userId }, 'Error removing committee leader');
      return '❌ Failed to remove committee leader. Please try again.';
    }
  });

  // List committee leaders
  handlers.set('list_committee_leaders', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const committeeSlug = (input.committee_slug as string)?.trim();

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug.';
    }

    try {
      const committee = await wgDb.getWorkingGroupBySlug(committeeSlug);
      if (!committee) {
        return `❌ Committee "${committeeSlug}" not found.`;
      }

      const leaders = await wgDb.getLeaders(committee.id);

      if (leaders.length === 0) {
        return `ℹ️ **${committee.name}** has no assigned leaders.

Use add_committee_leader to assign a leader.`;
      }

      let response = `## Leaders of ${committee.name}\n\n`;
      response += `**Committee type:** ${committee.committee_type}\n`;
      response += `**Slug:** ${committeeSlug}\n\n`;

      for (const leader of leaders) {
        response += `- **User ID:** ${leader.user_id}\n`;
        if (leader.name) {
          response += `  **Name:** ${leader.name}\n`;
        }
        if (leader.org_name) {
          response += `  **Org:** ${leader.org_name}\n`;
        }
        if (leader.created_at) {
          response += `  Added: ${new Date(leader.created_at).toLocaleDateString()}\n`;
        }
      }

      return response;
    } catch (error) {
      logger.error({ error, committeeSlug }, 'Error listing committee leaders');
      return '❌ Failed to list committee leaders. Please try again.';
    }
  });

  // ============================================
  // ORGANIZATION MANAGEMENT HANDLERS
  // ============================================

  // Merge organizations
  handlers.set('merge_organizations', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const primaryOrgId = input.primary_org_id as string;
    const secondaryOrgId = input.secondary_org_id as string;
    const preview = input.preview !== false; // Default to preview mode for safety

    if (!primaryOrgId || !secondaryOrgId) {
      return '❌ Both primary_org_id and secondary_org_id are required.';
    }

    if (primaryOrgId === secondaryOrgId) {
      return '❌ Primary and secondary organization IDs must be different.';
    }

    try {
      if (preview) {
        // Preview mode - show what would be merged
        const previewResult = await previewMerge(primaryOrgId, secondaryOrgId);

        // Also check WorkOS memberships
        let workosUserCount = 0;
        let workosCheckFailed = false;
        try {
          const secondaryMemberships = await workos.userManagement.listOrganizationMemberships({
            organizationId: secondaryOrgId,
            limit: 100,
          });
          const primaryMemberships = await workos.userManagement.listOrganizationMemberships({
            organizationId: primaryOrgId,
            limit: 100,
          });
          const primaryUserIds = new Set(primaryMemberships.data.map(m => m.userId));

          workosUserCount = secondaryMemberships.data
            .filter(m => m.status === 'active' && !primaryUserIds.has(m.userId))
            .length;
        } catch {
          workosCheckFailed = true;
        }

        let response = `## Merge Preview\n\n`;
        response += `**Keep:** ${previewResult.primary_org.name} (${previewResult.primary_org.id})\n`;
        response += `**Remove:** ${previewResult.secondary_org.name} (${previewResult.secondary_org.id})\n\n`;

        if (previewResult.estimated_changes.length === 0) {
          response += `_No data to merge from the secondary organization._\n`;
        } else {
          response += `### Data to Move\n`;
          for (const change of previewResult.estimated_changes) {
            response += `- **${change.table_name}**: ${change.rows_to_move} row(s)\n`;
          }
        }

        // WorkOS section
        response += `\n### WorkOS Sync\n`;
        if (workosCheckFailed) {
          response += `⚠️ Could not check WorkOS memberships\n`;
        } else if (workosUserCount > 0) {
          response += `- ${workosUserCount} user(s) will be added to the primary org in WorkOS\n`;
          response += `- Secondary org will be deleted from WorkOS\n`;
        } else {
          response += `- No new users to migrate in WorkOS\n`;
          response += `- Secondary org will be deleted from WorkOS\n`;
        }

        if (previewResult.warnings.length > 0) {
          response += `\n### Warnings\n`;
          for (const warning of previewResult.warnings) {
            response += `⚠️ ${warning}\n`;
          }
        }

        response += `\n---\n`;
        response += `_This is a preview. To execute the merge, call merge_organizations again with preview=false._`;

        return response;
      } else {
        // Execute the merge
        logger.info({ primaryOrgId, secondaryOrgId, mergedBy: memberContext?.workos_user?.workos_user_id }, 'Admin executing org merge via Addie');

        // Step 1: Get users from secondary org in WorkOS before merge
        let workosUsersToMigrate: string[] = [];
        let workosErrors: string[] = [];

        try {
          // Get all memberships from the secondary org in WorkOS
          const memberships = await workos.userManagement.listOrganizationMemberships({
            organizationId: secondaryOrgId,
            limit: 100,
          });

          // Warn if there are more than 100 members (pagination not implemented)
          if (memberships.listMetadata?.after) {
            workosErrors.push('Secondary org has more than 100 members - only first 100 will be migrated. Manual WorkOS cleanup may be needed.');
          }

          // Check which users are NOT already in the primary org
          const primaryMemberships = await workos.userManagement.listOrganizationMemberships({
            organizationId: primaryOrgId,
            limit: 100,
          });
          const primaryUserIds = new Set(primaryMemberships.data.map(m => m.userId));

          workosUsersToMigrate = memberships.data
            .filter(m => m.status === 'active' && !primaryUserIds.has(m.userId))
            .map(m => m.userId);

          logger.info({ count: workosUsersToMigrate.length, secondaryOrgId }, 'Found WorkOS users to migrate');
        } catch (err) {
          logger.warn({ error: err, secondaryOrgId }, 'Failed to fetch WorkOS memberships (will continue with DB merge)');
          workosErrors.push('Could not fetch WorkOS memberships - manual WorkOS cleanup may be needed');
        }

        // Step 2: Execute the database merge
        const mergedBy = memberContext?.workos_user?.workos_user_id || 'addie-admin';
        const result = await mergeOrganizations(primaryOrgId, secondaryOrgId, mergedBy);

        // Step 3: Add users to primary org in WorkOS
        let workosAdded = 0;
        let workosSkipped = 0;

        for (const userId of workosUsersToMigrate) {
          try {
            await workos.userManagement.createOrganizationMembership({
              userId,
              organizationId: primaryOrgId,
              roleSlug: 'member', // Default to member role
            });
            workosAdded++;
            logger.debug({ userId, primaryOrgId }, 'Added user to primary org in WorkOS');
          } catch (err: any) {
            // User might already be in org (race condition) or other error
            if (err?.code === 'organization_membership_already_exists') {
              workosSkipped++;
            } else {
              logger.warn({ error: err, userId }, 'Failed to add user to primary org in WorkOS');
              workosErrors.push(`Failed to add user ${userId} to WorkOS org`);
            }
          }
        }

        // Step 4: Delete the secondary org from WorkOS
        let workosOrgDeleted = false;
        try {
          await workos.organizations.deleteOrganization(secondaryOrgId);
          workosOrgDeleted = true;
          logger.info({ secondaryOrgId }, 'Deleted secondary org from WorkOS');
        } catch (err) {
          logger.warn({ error: err, secondaryOrgId }, 'Failed to delete secondary org from WorkOS');
          workosErrors.push(`Failed to delete secondary org from WorkOS (ID: ${secondaryOrgId}) - manual cleanup required`);
        }

        let response = `## Merge Complete ✅\n\n`;
        response += `Successfully merged **${result.secondary_org_id}** into **${result.primary_org_id}**.\n\n`;

        response += `### Data Moved\n`;
        const totalMoved = result.tables_merged.reduce((sum, t) => sum + t.rows_moved, 0);
        const totalSkipped = result.tables_merged.reduce((sum, t) => sum + t.rows_skipped_duplicate, 0);

        for (const table of result.tables_merged) {
          if (table.rows_moved > 0 || table.rows_skipped_duplicate > 0) {
            response += `- **${table.table_name}**: ${table.rows_moved} moved`;
            if (table.rows_skipped_duplicate > 0) {
              response += ` (${table.rows_skipped_duplicate} skipped as duplicates)`;
            }
            response += `\n`;
          }
        }

        response += `\n**Total:** ${totalMoved} rows moved, ${totalSkipped} duplicates skipped\n`;

        // WorkOS sync results
        if (workosUsersToMigrate.length > 0 || workosOrgDeleted || workosErrors.length > 0) {
          response += `\n### WorkOS Sync\n`;
          if (workosAdded > 0) {
            response += `- ✅ Added ${workosAdded} user(s) to primary org in WorkOS\n`;
          }
          if (workosSkipped > 0) {
            response += `- ⏭️ Skipped ${workosSkipped} user(s) (already in primary org)\n`;
          }
          if (workosOrgDeleted) {
            response += `- 🗑️ Deleted secondary org from WorkOS\n`;
          }
        }

        if (result.prospect_notes_merged) {
          response += `\n📝 Prospect notes were merged.\n`;
        }

        if (result.enrichment_data_preserved) {
          response += `📊 Enrichment data was preserved from the secondary organization.\n`;
        }

        // Combine all warnings
        const allWarnings = [...result.warnings, ...workosErrors];
        if (allWarnings.length > 0) {
          response += `\n### Warnings\n`;
          for (const warning of allWarnings) {
            response += `⚠️ ${warning}\n`;
          }
        }

        response += `\nThe secondary organization has been deleted.`;

        return response;
      }
    } catch (error) {
      logger.error({ error, primaryOrgId, secondaryOrgId }, 'Error merging organizations');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to merge organizations: ${errorMessage}`;
    }
  });

  // Find duplicate organizations
  handlers.set('find_duplicate_orgs', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const searchType = (input.search_type as string) || 'all';
    const pool = getPool();

    let response = `## Duplicate Organization Search\n\n`;

    try {
      // Find duplicates by name
      if (searchType === 'name' || searchType === 'all') {
        const nameResult = await pool.query(`
          SELECT
            LOWER(name) as normalized_name,
            COUNT(*) as count,
            STRING_AGG(name, ', ' ORDER BY name) as actual_names,
            STRING_AGG(workos_organization_id, ', ' ORDER BY name) as org_ids
          FROM organizations
          WHERE is_personal = false
          GROUP BY LOWER(name)
          HAVING COUNT(*) > 1
          ORDER BY count DESC, normalized_name
        `);

        response += `### Duplicate Names\n`;
        if (nameResult.rows.length === 0) {
          response += `✅ No organizations share the same name.\n`;
        } else {
          response += `⚠️ Found ${nameResult.rows.length} duplicate name(s):\n\n`;
          for (const row of nameResult.rows) {
            response += `**${row.normalized_name}** (${row.count} orgs)\n`;
            response += `  Names: ${row.actual_names}\n`;
            response += `  IDs: ${row.org_ids}\n\n`;
          }
        }
      }

      // Find duplicates by domain
      if (searchType === 'domain' || searchType === 'all') {
        const domainResult = await pool.query(`
          SELECT
            email_domain,
            COUNT(*) as count,
            STRING_AGG(name, ', ' ORDER BY name) as org_names,
            STRING_AGG(workos_organization_id, ', ' ORDER BY name) as org_ids
          FROM organizations
          WHERE is_personal = false AND email_domain IS NOT NULL
          GROUP BY email_domain
          HAVING COUNT(*) > 1
          ORDER BY count DESC, email_domain
        `);

        response += `### Duplicate Email Domains\n`;
        if (domainResult.rows.length === 0) {
          response += `✅ No organizations share the same email domain.\n`;
        } else {
          response += `⚠️ Found ${domainResult.rows.length} shared domain(s):\n\n`;
          for (const row of domainResult.rows) {
            response += `**${row.email_domain}** (${row.count} orgs)\n`;
            response += `  Orgs: ${row.org_names}\n`;
            response += `  IDs: ${row.org_ids}\n\n`;
          }
        }
      }

      response += `\n_Use merge_organizations to consolidate duplicates._`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error finding duplicate organizations');
      return '❌ Failed to search for duplicates. Please try again.';
    }
  });

  // Manage organization domains
  handlers.set('manage_organization_domains', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const action = input.action as string;
    const organizationId = input.organization_id as string;
    const domain = input.domain as string | undefined;
    const setAsPrimary = input.set_as_primary as boolean | undefined;

    if (!organizationId) {
      return '❌ organization_id is required. Use lookup_organization to find the org ID first.';
    }

    if (!workos) {
      return '❌ WorkOS is not configured. Domain management requires WorkOS to be set up.';
    }

    const pool = getPool();

    try {
      // Verify org exists
      const orgResult = await pool.query(
        `SELECT name, email_domain FROM organizations WHERE workos_organization_id = $1`,
        [organizationId]
      );

      if (orgResult.rows.length === 0) {
        return `❌ Organization not found with ID: ${organizationId}`;
      }

      const orgName = orgResult.rows[0].name;

      switch (action) {
        case 'list': {
          const domainsResult = await pool.query(
            `SELECT domain, is_primary, verified, source, created_at
             FROM organization_domains
             WHERE workos_organization_id = $1
             ORDER BY is_primary DESC, created_at ASC`,
            [organizationId]
          );

          if (domainsResult.rows.length === 0) {
            return `## Domains for ${orgName}\n\nNo domains configured for this organization.\n\nUse this tool with action "add" to add a domain.`;
          }

          let response = `## Domains for ${orgName}\n\n`;
          for (const row of domainsResult.rows) {
            const badges: string[] = [];
            if (row.is_primary) badges.push('⭐ Primary');
            if (row.verified) badges.push('✅ Verified');
            badges.push(`Source: ${row.source}`);

            response += `**${row.domain}** ${badges.join(' | ')}\n`;
          }
          response += `\n_Use action "add" to add a new domain, "remove" to delete one, or "set_primary" to change the primary domain._`;
          return response;
        }

        case 'add': {
          if (!domain) {
            return '❌ domain is required for the "add" action. Example: "acme.com"';
          }

          const normalizedDomain = domain.toLowerCase().trim();

          // Validate domain format
          const domainRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/;
          if (!domainRegex.test(normalizedDomain)) {
            return `❌ Invalid domain format: "${normalizedDomain}". Expected format: "example.com" or "sub.example.com"`;
          }

          // Check if domain is already claimed locally
          const existingResult = await pool.query(
            `SELECT od.workos_organization_id, o.name as org_name
             FROM organization_domains od
             JOIN organizations o ON o.workos_organization_id = od.workos_organization_id
             WHERE od.domain = $1`,
            [normalizedDomain]
          );

          if (existingResult.rows.length > 0) {
            const existingOrg = existingResult.rows[0];
            if (existingOrg.workos_organization_id === organizationId) {
              return `ℹ️ Domain **${normalizedDomain}** is already associated with ${orgName}.`;
            }
            return `❌ Domain **${normalizedDomain}** is already claimed by **${existingOrg.org_name}**.\n\nIf these organizations should be merged, use the merge_organizations tool.`;
          }

          // First, sync to WorkOS - this is required for user auto-association
          try {
            // Get existing domains from WorkOS to append the new one
            const workosOrg = await workos.organizations.getOrganization(organizationId);
            const existingDomains = workosOrg.domains.map(d => ({
              domain: d.domain,
              state: d.state === 'verified' ? DomainDataState.Verified : DomainDataState.Pending
            }));

            // Add the new domain
            await workos.organizations.updateOrganization({
              organization: organizationId,
              domainData: [...existingDomains, { domain: normalizedDomain, state: DomainDataState.Verified }],
            });
          } catch (workosErr) {
            logger.error({ err: workosErr, domain: normalizedDomain, organizationId }, 'Failed to add domain to WorkOS');
            return `❌ Failed to add domain **${normalizedDomain}** to WorkOS. Error: ${workosErr instanceof Error ? workosErr.message : 'Unknown error'}`;
          }

          // If setting as primary, clear existing primary first
          if (setAsPrimary) {
            await pool.query(
              `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
               WHERE workos_organization_id = $1 AND is_primary = true`,
              [organizationId]
            );
          }

          // Insert/update the domain in local DB (WorkOS webhook will also do this, but let's be explicit)
          await pool.query(
            `INSERT INTO organization_domains (workos_organization_id, domain, is_primary, verified, source)
             VALUES ($1, $2, $3, true, 'workos')
             ON CONFLICT (domain) DO UPDATE SET
               workos_organization_id = EXCLUDED.workos_organization_id,
               is_primary = EXCLUDED.is_primary,
               verified = true,
               source = 'workos',
               updated_at = NOW()`,
            [organizationId, normalizedDomain, setAsPrimary || false]
          );

          // If primary, also update the email_domain column
          if (setAsPrimary) {
            await pool.query(
              `UPDATE organizations SET email_domain = $1, updated_at = NOW()
               WHERE workos_organization_id = $2`,
              [normalizedDomain, organizationId]
            );
          }

          logger.info({ organizationId, domain: normalizedDomain, setAsPrimary }, 'Addie: Added domain to organization via WorkOS');

          let response = `✅ Added domain **${normalizedDomain}** to ${orgName} and synced to WorkOS`;
          if (setAsPrimary) response += ' (set as primary)';
          response += '.\n\nUsers signing up with @' + normalizedDomain + ' emails will now be auto-associated with this organization.';
          return response;
        }

        case 'remove': {
          if (!domain) {
            return '❌ domain is required for the "remove" action.';
          }

          const normalizedDomain = domain.toLowerCase().trim();

          // Get domain info before deletion
          const domainResult = await pool.query(
            `SELECT is_primary, source FROM organization_domains
             WHERE workos_organization_id = $1 AND domain = $2`,
            [organizationId, normalizedDomain]
          );

          if (domainResult.rows.length === 0) {
            return `❌ Domain **${normalizedDomain}** not found for ${orgName}.`;
          }

          const wasPrimary = domainResult.rows[0].is_primary;

          // First, remove from WorkOS
          try {
            const workosOrg = await workos.organizations.getOrganization(organizationId);
            const remainingDomains = workosOrg.domains
              .filter(d => d.domain.toLowerCase() !== normalizedDomain)
              .map(d => ({
                domain: d.domain,
                state: d.state === 'verified' ? DomainDataState.Verified : DomainDataState.Pending
              }));

            await workos.organizations.updateOrganization({
              organization: organizationId,
              domainData: remainingDomains,
            });
          } catch (workosErr) {
            logger.error({ err: workosErr, domain: normalizedDomain, organizationId }, 'Failed to remove domain from WorkOS');
            return `❌ Failed to remove domain **${normalizedDomain}** from WorkOS. Error: ${workosErr instanceof Error ? workosErr.message : 'Unknown error'}`;
          }

          // Delete the domain from local DB
          await pool.query(
            `DELETE FROM organization_domains WHERE workos_organization_id = $1 AND domain = $2`,
            [organizationId, normalizedDomain]
          );

          // If we deleted the primary domain, pick a new one
          let newPrimary: string | null = null;
          if (wasPrimary) {
            const remaining = await pool.query(
              `SELECT domain FROM organization_domains
               WHERE workos_organization_id = $1
               ORDER BY verified DESC, created_at ASC
               LIMIT 1`,
              [organizationId]
            );

            newPrimary = remaining.rows.length > 0 ? remaining.rows[0].domain : null;

            if (newPrimary) {
              await pool.query(
                `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
                 WHERE workos_organization_id = $1 AND domain = $2`,
                [organizationId, newPrimary]
              );
            }

            await pool.query(
              `UPDATE organizations SET email_domain = $1, updated_at = NOW()
               WHERE workos_organization_id = $2`,
              [newPrimary, organizationId]
            );
          }

          logger.info({ organizationId, domain: normalizedDomain, wasPrimary, newPrimary }, 'Addie: Removed domain from organization via WorkOS');

          let response = `✅ Removed domain **${normalizedDomain}** from ${orgName} and WorkOS`;
          if (wasPrimary && newPrimary) {
            response += `. New primary domain: **${newPrimary}**`;
          } else if (wasPrimary) {
            response += '. No domains remaining.';
          }
          response += '\n\nUsers signing up with @' + normalizedDomain + ' emails will no longer be auto-associated with this organization.';
          return response;
        }

        case 'set_primary': {
          if (!domain) {
            return '❌ domain is required for the "set_primary" action.';
          }

          const normalizedDomain = domain.toLowerCase().trim();

          // Verify domain belongs to this org
          const domainResult = await pool.query(
            `SELECT domain FROM organization_domains
             WHERE workos_organization_id = $1 AND domain = $2`,
            [organizationId, normalizedDomain]
          );

          if (domainResult.rows.length === 0) {
            return `❌ Domain **${normalizedDomain}** not found for ${orgName}. Use action "add" first.`;
          }

          // Clear existing primary
          await pool.query(
            `UPDATE organization_domains SET is_primary = false, updated_at = NOW()
             WHERE workos_organization_id = $1 AND is_primary = true`,
            [organizationId]
          );

          // Set new primary
          await pool.query(
            `UPDATE organization_domains SET is_primary = true, updated_at = NOW()
             WHERE workos_organization_id = $1 AND domain = $2`,
            [organizationId, normalizedDomain]
          );

          // Update organizations.email_domain
          await pool.query(
            `UPDATE organizations SET email_domain = $1, updated_at = NOW()
             WHERE workos_organization_id = $2`,
            [normalizedDomain, organizationId]
          );

          logger.info({ organizationId, domain: normalizedDomain }, 'Addie: Set primary domain for organization');

          return `✅ Set **${normalizedDomain}** as the primary domain for ${orgName}.`;
        }

        default:
          return `❌ Unknown action: ${action}. Valid actions are: list, add, remove, set_primary`;
      }
    } catch (error) {
      logger.error({ error, organizationId, action }, 'Error managing organization domains');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to ${action} domain: ${errorMessage}`;
    }
  });

  // Check domain health
  handlers.set('check_domain_health', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const checkType = (input.check_type as string) || 'all';
    const limit = Math.min(Math.max((input.limit as number) || 20, 1), 100);
    const pool = getPool();

    // Common free email providers to exclude
    const freeEmailDomains = [
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com',
      'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
      'mac.com', 'protonmail.com', 'proton.me', 'mail.com', 'zoho.com',
    ];

    let response = `## Domain Health Check\n\n`;
    let issueCount = 0;

    try {
      // 1. Orphan corporate domains - users with corporate emails but no org with that domain
      if (checkType === 'orphan_domains' || checkType === 'all') {
        const orphanResult = await pool.query(`
          WITH user_domains AS (
            SELECT
              LOWER(SPLIT_PART(om.email, '@', 2)) as domain,
              COUNT(DISTINCT om.workos_user_id) as user_count,
              STRING_AGG(DISTINCT om.email, ', ' ORDER BY om.email) as sample_emails
            FROM organization_memberships om
            WHERE om.email IS NOT NULL
              AND LOWER(SPLIT_PART(om.email, '@', 2)) NOT IN (${freeEmailDomains.map((_, i) => `$${i + 1}`).join(', ')})
            GROUP BY LOWER(SPLIT_PART(om.email, '@', 2))
          ),
          claimed_domains AS (
            SELECT LOWER(domain) as domain FROM organization_domains
            UNION
            SELECT LOWER(email_domain) FROM organizations WHERE email_domain IS NOT NULL
          )
          SELECT ud.domain, ud.user_count, ud.sample_emails
          FROM user_domains ud
          LEFT JOIN claimed_domains cd ON cd.domain = ud.domain
          WHERE cd.domain IS NULL
          ORDER BY ud.user_count DESC
          LIMIT $${freeEmailDomains.length + 1}
        `, [...freeEmailDomains, limit]);

        response += `### Orphan Corporate Domains\n`;
        response += `_Corporate email domains with users but no matching organization_\n\n`;

        if (orphanResult.rows.length === 0) {
          response += `✅ No orphan domains found.\n\n`;
        } else {
          issueCount += orphanResult.rows.length;
          for (const row of orphanResult.rows) {
            response += `**${row.domain}** - ${row.user_count} user(s)\n`;
            const emails = row.sample_emails.split(', ').slice(0, 3).join(', ');
            response += `  Users: ${emails}${row.user_count > 3 ? '...' : ''}\n`;
          }
          response += `\n_Action: Create prospects for these domains or map users to existing orgs._\n\n`;
        }
      }

      // 2. Users in personal workspaces with corporate emails
      if (checkType === 'misaligned_users' || checkType === 'all') {
        const misalignedResult = await pool.query(`
          SELECT
            om.email,
            om.first_name,
            om.last_name,
            LOWER(SPLIT_PART(om.email, '@', 2)) as email_domain,
            o.name as workspace_name,
            om.workos_organization_id
          FROM organization_memberships om
          JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
          WHERE o.is_personal = true
            AND om.email IS NOT NULL
            AND LOWER(SPLIT_PART(om.email, '@', 2)) NOT IN (${freeEmailDomains.map((_, i) => `$${i + 1}`).join(', ')})
          ORDER BY LOWER(SPLIT_PART(om.email, '@', 2)), om.email
          LIMIT $${freeEmailDomains.length + 1}
        `, [...freeEmailDomains, limit]);

        response += `### Corporate Users in Personal Workspaces\n`;
        response += `_Users with company emails who are in personal workspaces instead of company orgs_\n\n`;

        if (misalignedResult.rows.length === 0) {
          response += `✅ No misaligned users found.\n\n`;
        } else {
          issueCount += misalignedResult.rows.length;
          // Group by domain
          const byDomain = new Map<string, typeof misalignedResult.rows>();
          for (const row of misalignedResult.rows) {
            const existing = byDomain.get(row.email_domain) || [];
            existing.push(row);
            byDomain.set(row.email_domain, existing);
          }

          for (const [domain, users] of byDomain) {
            response += `**${domain}** (${users.length} user(s))\n`;
            for (const user of users.slice(0, 3)) {
              response += `  - ${user.email} (${user.first_name || ''} ${user.last_name || ''})\n`;
            }
            if (users.length > 3) {
              response += `  - ... and ${users.length - 3} more\n`;
            }
          }
          response += `\n_Action: Create company org and move these users, or verify they should be individuals._\n\n`;
        }
      }

      // 3. Orgs with users but no verified domain
      if (checkType === 'unverified_domains' || checkType === 'all') {
        const unverifiedResult = await pool.query(`
          SELECT
            o.workos_organization_id,
            o.name,
            o.email_domain,
            COUNT(DISTINCT om.workos_user_id) as user_count,
            STRING_AGG(DISTINCT LOWER(SPLIT_PART(om.email, '@', 2)), ', ') as user_domains
          FROM organizations o
          JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
          LEFT JOIN organization_domains od ON od.workos_organization_id = o.workos_organization_id AND od.verified = true
          WHERE o.is_personal = false
            AND od.id IS NULL
          GROUP BY o.workos_organization_id, o.name, o.email_domain
          HAVING COUNT(DISTINCT om.workos_user_id) > 0
          ORDER BY COUNT(DISTINCT om.workos_user_id) DESC
          LIMIT $1
        `, [limit]);

        response += `### Organizations Without Verified Domains\n`;
        response += `_Organizations with members but no verified domain mapping_\n\n`;

        if (unverifiedResult.rows.length === 0) {
          response += `✅ All organizations with users have verified domains.\n\n`;
        } else {
          issueCount += unverifiedResult.rows.length;
          for (const row of unverifiedResult.rows) {
            response += `**${row.name}** - ${row.user_count} user(s)\n`;
            response += `  User domains: ${row.user_domains}\n`;
            if (row.email_domain) {
              response += `  Claimed domain: ${row.email_domain} (not verified)\n`;
            }
          }
          response += `\n_Action: Verify domain ownership for these organizations._\n\n`;
        }
      }

      // 4. Domain conflicts (multiple orgs claiming same domain)
      if (checkType === 'domain_conflicts' || checkType === 'all') {
        const conflictResult = await pool.query(`
          SELECT
            email_domain,
            COUNT(*) as org_count,
            STRING_AGG(name, ', ' ORDER BY name) as org_names,
            STRING_AGG(workos_organization_id, ', ' ORDER BY name) as org_ids
          FROM organizations
          WHERE is_personal = false AND email_domain IS NOT NULL
          GROUP BY email_domain
          HAVING COUNT(*) > 1
          ORDER BY COUNT(*) DESC
          LIMIT $1
        `, [limit]);

        response += `### Domain Conflicts\n`;
        response += `_Multiple organizations claiming the same email domain_\n\n`;

        if (conflictResult.rows.length === 0) {
          response += `✅ No domain conflicts found.\n\n`;
        } else {
          issueCount += conflictResult.rows.length;
          for (const row of conflictResult.rows) {
            response += `**${row.email_domain}** - ${row.org_count} orgs\n`;
            response += `  Orgs: ${row.org_names}\n`;
          }
          response += `\n_Action: Merge duplicate organizations._\n\n`;
        }
      }

      // Summary
      response += `---\n`;
      if (issueCount === 0) {
        response += `✅ **Domain health is good!** No issues found.`;
      } else {
        response += `⚠️ **Found ${issueCount} issue(s)** that need attention.\n`;
        response += `\nUse the suggested actions or visit the admin Domain Health page for more details.`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error checking domain health');
      return '❌ Failed to check domain health. Please try again.';
    }
  });

  // ============================================
  // PROSPECT OWNERSHIP & PIPELINE HANDLERS
  // ============================================

  // My engaged prospects - list owned prospects sorted by engagement
  handlers.set('my_engaged_prospects', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const limit = Math.min((input.limit as number) || 10, 50);
    const hotOnly = input.hot_only as boolean;

    // Get the admin's user ID from context
    const userId = memberContext?.workos_user?.workos_user_id;
    if (!userId) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    try {
      // Query prospects owned by this user
      let query = `
        SELECT
          o.workos_organization_id as org_id,
          o.name,
          o.email_domain,
          o.engagement_score,
          o.prospect_status,
          o.interest_level,
          o.company_type,
          (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id) as last_activity
        FROM organizations o
        JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
        WHERE os.user_id = $1
          AND os.role = 'owner'
          AND o.is_personal IS NOT TRUE
          AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
      `;

      if (hotOnly) {
        query += ` AND o.engagement_score >= 30`;
      }

      query += `
        ORDER BY o.engagement_score DESC NULLS LAST
        LIMIT $2
      `;

      const result = await pool.query(query, [userId, limit]);

      if (result.rows.length === 0) {
        return hotOnly
          ? `No hot prospects found. Try removing the hot_only filter to see all your prospects.`
          : `You don't own any prospects yet. Use \`unassigned_prospects\` to find prospects to claim.`;
      }

      let response = `## Your ${hotOnly ? 'Hot ' : ''}Engaged Prospects\n\n`;

      for (const row of result.rows) {
        const isHot = (row.engagement_score || 0) >= 30;
        const emoji = isHot ? '🔥' : '📊';
        response += `${emoji} **${row.name}**`;
        if (row.email_domain) response += ` (${row.email_domain})`;
        response += `\n`;
        response += `   Score: ${row.engagement_score || 0}`;
        if (row.prospect_status) response += ` | Status: ${row.prospect_status}`;
        if (row.interest_level) response += ` | Interest: ${row.interest_level}`;
        response += `\n`;
        if (row.last_activity) {
          response += `   Last activity: ${new Date(row.last_activity).toLocaleDateString()}\n`;
        }
        response += `\n`;
      }

      const hotCount = result.rows.filter(r => (r.engagement_score || 0) >= 30).length;
      response += `---\n`;
      response += `Showing ${result.rows.length} prospect(s)`;
      if (!hotOnly && hotCount > 0) {
        response += ` (${hotCount} hot)`;
      }

      return response;
    } catch (error) {
      logger.error({ error, userId }, 'Error fetching engaged prospects');
      return '❌ Failed to fetch your prospects. Please try again.';
    }
  });

  // My followups needed - list owned prospects needing attention
  handlers.set('my_followups_needed', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const limit = Math.min((input.limit as number) || 10, 50);
    const daysStale = (input.days_stale as number) || 14;

    const userId = memberContext?.workos_user?.workos_user_id;
    if (!userId) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    try {
      // Query prospects that need follow-up
      const result = await pool.query(`
        WITH prospect_activity AS (
          SELECT
            o.workos_organization_id as org_id,
            o.name,
            o.email_domain,
            o.engagement_score,
            o.prospect_status,
            o.prospect_next_action,
            o.prospect_next_action_date,
            (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id) as last_activity,
            EXTRACT(DAY FROM NOW() - COALESCE(
              (SELECT MAX(activity_date) FROM org_activities WHERE organization_id = o.workos_organization_id),
              o.created_at
            )) as days_since_activity
          FROM organizations o
          JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
          WHERE os.user_id = $1
            AND os.role = 'owner'
            AND o.is_personal IS NOT TRUE
            AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
        )
        SELECT *,
          CASE
            WHEN prospect_next_action_date IS NOT NULL AND prospect_next_action_date < CURRENT_DATE THEN 1
            WHEN days_since_activity >= $2 THEN 2
            ELSE 3
          END as urgency
        FROM prospect_activity
        WHERE (prospect_next_action_date IS NOT NULL AND prospect_next_action_date < CURRENT_DATE)
           OR days_since_activity >= $2
        ORDER BY urgency, days_since_activity DESC NULLS LAST
        LIMIT $3
      `, [userId, daysStale, limit]);

      if (result.rows.length === 0) {
        return `✅ Great news! None of your prospects need immediate follow-up.`;
      }

      let response = `## Prospects Needing Follow-Up\n\n`;

      let overdueCount = 0;
      let staleCount = 0;

      for (const row of result.rows) {
        const isOverdue = row.prospect_next_action_date && new Date(row.prospect_next_action_date) < new Date();
        if (isOverdue) {
          overdueCount++;
          response += `⚠️ **${row.name}** - OVERDUE\n`;
          response += `   Next step: ${row.prospect_next_action || 'Not set'}\n`;
          response += `   Due: ${new Date(row.prospect_next_action_date).toLocaleDateString()}\n`;
        } else {
          staleCount++;
          response += `⏰ **${row.name}** - ${Math.round(row.days_since_activity)} days since activity\n`;
        }
        if (row.last_activity) {
          response += `   Last activity: ${new Date(row.last_activity).toLocaleDateString()}\n`;
        }
        if (row.engagement_score) {
          response += `   Engagement: ${row.engagement_score}${row.engagement_score >= 30 ? ' 🔥' : ''}\n`;
        }
        response += `\n`;
      }

      response += `---\n`;
      if (overdueCount > 0) response += `⚠️ ${overdueCount} overdue task(s)\n`;
      if (staleCount > 0) response += `⏰ ${staleCount} stale (>${daysStale} days)\n`;

      return response;
    } catch (error) {
      logger.error({ error, userId }, 'Error fetching followups needed');
      return '❌ Failed to fetch follow-ups. Please try again.';
    }
  });

  // Unassigned prospects - list high-engagement prospects without owners
  handlers.set('unassigned_prospects', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const limit = Math.min((input.limit as number) || 10, 50);
    const minEngagement = (input.min_engagement as number) || 10;

    try {
      const result = await pool.query(`
        SELECT
          o.workos_organization_id as org_id,
          o.name,
          o.email_domain,
          o.engagement_score,
          o.prospect_status,
          o.company_type
        FROM organizations o
        WHERE o.is_personal IS NOT TRUE
          AND (o.subscription_status IS NULL OR o.subscription_status != 'active')
          AND o.engagement_score >= $1
          AND NOT EXISTS (
            SELECT 1 FROM org_stakeholders os
            WHERE os.organization_id = o.workos_organization_id
              AND os.role = 'owner'
          )
        ORDER BY o.engagement_score DESC NULLS LAST
        LIMIT $2
      `, [minEngagement, limit]);

      if (result.rows.length === 0) {
        return minEngagement > 10
          ? `No unassigned prospects with engagement >= ${minEngagement}. Try lowering min_engagement.`
          : `All engaged prospects have owners! Nice work team.`;
      }

      let response = `## Unassigned Prospects (engagement >= ${minEngagement})\n\n`;

      for (const row of result.rows) {
        const isHot = (row.engagement_score || 0) >= 30;
        const emoji = isHot ? '🔥' : '📊';
        response += `${emoji} **${row.name}**`;
        if (row.email_domain) response += ` (${row.email_domain})`;
        response += `\n`;
        response += `   Score: ${row.engagement_score || 0}`;
        if (row.company_type) response += ` | Type: ${row.company_type}`;
        response += `\n`;
        response += `   ID: ${row.org_id}\n`;
        response += `\n`;
      }

      response += `---\n`;
      response += `Use \`claim_prospect\` to take ownership of any of these.`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error fetching unassigned prospects');
      return '❌ Failed to fetch unassigned prospects. Please try again.';
    }
  });

  // Claim prospect - assign self as owner
  handlers.set('claim_prospect', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    let orgId = input.org_id as string;
    const companyName = input.company_name as string;
    const replaceExisting = input.replace_existing as boolean;
    const notes = input.notes as string;

    const userId = memberContext?.workos_user?.workos_user_id;
    const userName = memberContext?.workos_user?.first_name || 'Unknown';
    const userEmail = memberContext?.workos_user?.email;

    if (!userId || !userEmail) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    if (!orgId && !companyName) {
      return '❌ Please provide either org_id or company_name.';
    }

    try {
      // Look up org by name if no ID provided
      if (!orgId && companyName) {
        // Escape SQL LIKE wildcard characters to prevent pattern injection
        const escapedName = companyName.replace(/[%_\\]/g, '\\$&');
        const searchResult = await pool.query(`
          SELECT workos_organization_id, name
          FROM organizations
          WHERE LOWER(name) LIKE LOWER($1) ESCAPE '\\'
            AND is_personal IS NOT TRUE
          ORDER BY
            CASE WHEN LOWER(name) = LOWER($2) THEN 0 ELSE 1 END,
            engagement_score DESC NULLS LAST
          LIMIT 1
        `, [`%${escapedName}%`, companyName]);

        if (searchResult.rows.length === 0) {
          return `❌ No organization found matching "${companyName}". Try using the exact org_id instead.`;
        }

        orgId = searchResult.rows[0].workos_organization_id;
      }

      // Check for existing owner
      const existingOwner = await pool.query(`
        SELECT user_id, user_name, user_email
        FROM org_stakeholders
        WHERE organization_id = $1 AND role = 'owner'
      `, [orgId]);

      if (existingOwner.rows.length > 0) {
        const owner = existingOwner.rows[0];
        if (owner.user_id === userId) {
          return `✅ You are already the owner of this prospect.`;
        }
        if (!replaceExisting) {
          return `❌ This prospect already has an owner: ${owner.user_name} (${owner.user_email}).\n\nUse \`replace_existing: true\` to take over ownership.`;
        }

        // Remove existing owner
        await pool.query(`
          DELETE FROM org_stakeholders
          WHERE organization_id = $1 AND role = 'owner'
        `, [orgId]);
      }

      // Add self as owner
      await pool.query(`
        INSERT INTO org_stakeholders (organization_id, user_id, user_name, user_email, role, notes)
        VALUES ($1, $2, $3, $4, 'owner', $5)
        ON CONFLICT (organization_id, user_id)
        DO UPDATE SET role = 'owner', notes = $5, updated_at = NOW()
      `, [orgId, userId, userName, userEmail, notes || `Claimed via Addie on ${new Date().toLocaleDateString()}`]);

      // Get the org name for confirmation
      const orgResult = await pool.query(`
        SELECT name FROM organizations WHERE workos_organization_id = $1
      `, [orgId]);

      const orgName = orgResult.rows[0]?.name || orgId;

      let response = `✅ You are now the owner of **${orgName}**!`;
      if (existingOwner.rows.length > 0) {
        response += `\n\n_Previous owner ${existingOwner.rows[0].user_name} has been removed._`;
      }
      return response;
    } catch (error) {
      logger.error({ error, orgId, userId }, 'Error claiming prospect');
      return '❌ Failed to claim prospect. Please try again.';
    }
  });

  // Suggest prospects - find unmapped domains and Lusha results
  handlers.set('suggest_prospects', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const limit = Math.min((input.limit as number) || 10, 20);
    const includeLusha = input.include_lusha !== false;
    const lushaKeywords = (input.lusha_keywords as string[]) || ['programmatic', 'DSP', 'ad tech'];

    let response = `## Suggested Prospects\n\n`;

    // 1. Find unmapped corporate domains (already engaged, high value)
    try {
      const unmappedResult = await pool.query(`
        WITH corporate_domains AS (
          -- Extract domains from Slack users not in personal orgs
          SELECT DISTINCT
            LOWER(SUBSTRING(sm.slack_email FROM POSITION('@' IN sm.slack_email) + 1)) as domain,
            COUNT(DISTINCT sm.slack_user_id) as user_count
          FROM slack_user_mappings sm
          WHERE sm.slack_email IS NOT NULL
            AND sm.slack_is_bot IS NOT TRUE
            -- Exclude common personal email domains
            AND LOWER(sm.slack_email) NOT LIKE '%@gmail.com'
            AND LOWER(sm.slack_email) NOT LIKE '%@yahoo.com'
            AND LOWER(sm.slack_email) NOT LIKE '%@hotmail.com'
            AND LOWER(sm.slack_email) NOT LIKE '%@outlook.com'
            AND LOWER(sm.slack_email) NOT LIKE '%@icloud.com'
            AND LOWER(sm.slack_email) NOT LIKE '%@aol.com'
          GROUP BY domain
        )
        SELECT
          cd.domain,
          cd.user_count
        FROM corporate_domains cd
        WHERE NOT EXISTS (
          -- Not already mapped to an org
          SELECT 1 FROM organization_domains od
          WHERE od.domain = cd.domain
        )
        AND NOT EXISTS (
          -- Not the email_domain of any org
          SELECT 1 FROM organizations o
          WHERE o.email_domain = cd.domain
        )
        ORDER BY cd.user_count DESC
        LIMIT $1
      `, [limit]);

      if (unmappedResult.rows.length > 0) {
        response += `### 🎯 Unmapped Domains (Already in Slack!)\n\n`;
        response += `_These people are already engaged but their companies aren't in our system:_\n\n`;

        for (const row of unmappedResult.rows) {
          response += `• **${row.domain}** - ${row.user_count} Slack user(s)\n`;
        }
        response += `\n_Use \`add_prospect\` to create organizations for these domains._\n\n`;
      } else {
        response += `### 🎯 Unmapped Domains\n\n`;
        response += `✅ All active Slack domains are mapped to organizations!\n\n`;
      }
    } catch (error) {
      logger.error({ error }, 'Error finding unmapped domains');
      response += `### 🎯 Unmapped Domains\n\n`;
      response += `⚠️ Could not check unmapped domains.\n\n`;
    }

    // 2. Lusha search for external prospects
    if (includeLusha && isLushaConfigured()) {
      try {
        const lushaClient = getLushaClient();
        if (lushaClient) {
          response += `### 🔍 Lusha Search Results\n\n`;
          response += `_External companies matching: ${lushaKeywords.join(', ')}_\n\n`;

          // Note: This would use the actual Lusha search API
          // For now, we'll indicate it's available
          response += `Use \`prospect_search_lusha\` with specific criteria to find external companies.\n\n`;
        }
      } catch (error) {
        logger.error({ error }, 'Error searching Lusha');
        response += `### 🔍 Lusha Search\n\n`;
        response += `⚠️ Lusha search failed. Try \`prospect_search_lusha\` directly.\n\n`;
      }
    } else if (includeLusha) {
      response += `### 🔍 Lusha Search\n\n`;
      response += `⚠️ Lusha is not configured. Contact an admin to set up Lusha API access.\n\n`;
    }

    response += `---\n`;
    response += `Use \`add_prospect\` to add any company to the prospect list.`;

    return response;
  });

  // Set reminder - create a next step/reminder for a prospect
  handlers.set('set_reminder', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    let orgId = input.org_id as string;
    const companyName = input.company_name as string;
    const reminder = input.reminder as string;
    const dueDateInput = input.due_date as string;

    const userId = memberContext?.workos_user?.workos_user_id;
    const userName = memberContext?.workos_user?.first_name || 'Unknown';

    if (!userId) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    if (!orgId && !companyName) {
      return '❌ Please provide either org_id or company_name.';
    }

    if (!reminder) {
      return '❌ Please provide a reminder description.';
    }

    if (!dueDateInput) {
      return '❌ Please provide a due date.';
    }

    // Parse the due date
    let dueDate: Date;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lowerInput = dueDateInput.toLowerCase().trim();

    if (lowerInput === 'today') {
      dueDate = today;
    } else if (lowerInput === 'tomorrow') {
      dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + 1);
    } else if (lowerInput.startsWith('next ')) {
      const dayName = lowerInput.replace('next ', '');
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(dayName);
      if (targetDay === -1) {
        return `❌ Could not parse day name: "${dayName}". Try "next monday", "next tuesday", etc.`;
      }
      dueDate = new Date(today);
      const currentDay = dueDate.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      dueDate.setDate(dueDate.getDate() + daysUntil);
    } else if (lowerInput.match(/^in (\d+) days?$/)) {
      const match = lowerInput.match(/^in (\d+) days?$/);
      const numDays = parseInt(match![1], 10);
      dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + numDays);
    } else if (lowerInput.match(/^in (\d+) weeks?$/)) {
      const match = lowerInput.match(/^in (\d+) weeks?$/);
      const numWeeks = parseInt(match![1], 10);
      dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + numWeeks * 7);
    } else {
      // Try parsing as a date
      dueDate = new Date(dueDateInput);
      if (isNaN(dueDate.getTime())) {
        return `❌ Could not parse date: "${dueDateInput}". Try "tomorrow", "next Monday", "in 3 days", or "2024-01-15".`;
      }
    }

    try {
      // Look up org by name if no ID provided
      if (!orgId && companyName) {
        // Escape LIKE pattern special characters (% and _)
        const escapedName = companyName.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const searchResult = await pool.query(`
          SELECT workos_organization_id, name
          FROM organizations
          WHERE LOWER(name) LIKE LOWER($1) ESCAPE '\\'
            AND is_personal IS NOT TRUE
          ORDER BY
            CASE WHEN LOWER(name) = LOWER($2) THEN 0 ELSE 1 END,
            engagement_score DESC NULLS LAST
          LIMIT 1
        `, [`%${escapedName}%`, companyName]);

        if (searchResult.rows.length === 0) {
          return `❌ No organization found matching "${companyName}". Try adding them as a prospect first.`;
        }

        orgId = searchResult.rows[0].workos_organization_id;
      }

      // Get org name for confirmation
      const orgResult = await pool.query(`
        SELECT name FROM organizations WHERE workos_organization_id = $1
      `, [orgId]);

      if (orgResult.rows.length === 0) {
        return `❌ Organization not found.`;
      }

      const orgName = orgResult.rows[0].name;

      // Create the activity with next step
      await pool.query(`
        INSERT INTO org_activities (
          organization_id,
          activity_type,
          description,
          logged_by_user_id,
          logged_by_name,
          activity_date,
          is_next_step,
          next_step_due_date,
          next_step_owner_user_id,
          next_step_owner_name
        ) VALUES ($1, 'reminder', $2, $3, $4, NOW(), true, $5, $3, $4)
      `, [orgId, reminder, userId, userName, dueDate.toISOString().split('T')[0]]);

      // Also update the org's prospect_next_action fields for quick lookup
      await pool.query(`
        UPDATE organizations
        SET prospect_next_action = $2, prospect_next_action_date = $3, updated_at = NOW()
        WHERE workos_organization_id = $1
      `, [orgId, reminder, dueDate.toISOString().split('T')[0]]);

      const formattedDate = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      return `✅ Reminder set for **${orgName}**!\n\n📝 ${reminder}\n📅 Due: ${formattedDate}`;
    } catch (error) {
      logger.error({ error, orgId, userId }, 'Error setting reminder');
      return '❌ Failed to set reminder. Please try again.';
    }
  });

  // My upcoming tasks - list future scheduled tasks
  handlers.set('my_upcoming_tasks', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    const limit = Math.min((input.limit as number) || 20, 50);
    const daysAhead = (input.days_ahead as number) || 7;

    const userId = memberContext?.workos_user?.workos_user_id;
    if (!userId) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    try {
      // Query upcoming tasks from org_activities
      const result = await pool.query(`
        SELECT
          oa.id,
          oa.description,
          oa.next_step_due_date,
          oa.activity_type,
          o.name as org_name,
          o.workos_organization_id as org_id,
          o.engagement_score
        FROM org_activities oa
        JOIN organizations o ON o.workos_organization_id = oa.organization_id
        WHERE oa.is_next_step = TRUE
          AND oa.next_step_completed_at IS NULL
          AND oa.next_step_owner_user_id = $1
          AND oa.next_step_due_date >= CURRENT_DATE
          AND oa.next_step_due_date <= CURRENT_DATE + $2::INTEGER
        ORDER BY oa.next_step_due_date ASC
        LIMIT $3
      `, [userId, daysAhead, limit]);

      // Also check for tasks based on org ownership (from prospect_next_action on organizations table)
      const orgTasks = await pool.query(`
        SELECT
          o.prospect_next_action as description,
          o.prospect_next_action_date,
          o.name as org_name,
          o.workos_organization_id as org_id,
          o.engagement_score
        FROM organizations o
        JOIN org_stakeholders os ON os.organization_id = o.workos_organization_id
        WHERE os.user_id = $1
          AND os.role = 'owner'
          AND o.prospect_next_action IS NOT NULL
          AND o.prospect_next_action_date >= CURRENT_DATE
          AND o.prospect_next_action_date <= CURRENT_DATE + $2::INTEGER
          AND o.is_personal IS NOT TRUE
        ORDER BY o.prospect_next_action_date ASC
        LIMIT $3
      `, [userId, daysAhead, limit]);

      // Combine and dedupe by org_id (prefer activity-based tasks)
      const seenOrgs = new Set<string>();
      const allTasks: Array<{
        description: string;
        due_date: Date;
        org_name: string;
        org_id: string;
        engagement_score: number;
      }> = [];

      for (const row of result.rows) {
        seenOrgs.add(row.org_id);
        allTasks.push({
          description: row.description,
          due_date: new Date(row.next_step_due_date),
          org_name: row.org_name,
          org_id: row.org_id,
          engagement_score: row.engagement_score || 0,
        });
      }

      for (const row of orgTasks.rows) {
        if (!seenOrgs.has(row.org_id)) {
          allTasks.push({
            description: row.description,
            due_date: new Date(row.prospect_next_action_date),
            org_name: row.org_name,
            org_id: row.org_id,
            engagement_score: row.engagement_score || 0,
          });
        }
      }

      // Sort by date
      allTasks.sort((a, b) => a.due_date.getTime() - b.due_date.getTime());

      if (allTasks.length === 0) {
        return `📅 No upcoming tasks in the next ${daysAhead} day(s).\n\nUse \`set_reminder\` to schedule follow-ups for your prospects.`;
      }

      let response = `## Upcoming Tasks (Next ${daysAhead} Days)\n\n`;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let currentDateStr = '';
      for (const task of allTasks.slice(0, limit)) {
        const dateStr = task.due_date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

        if (dateStr !== currentDateStr) {
          currentDateStr = dateStr;
          const isToday = task.due_date.getTime() === today.getTime();
          const isTomorrow = task.due_date.getTime() === today.getTime() + 86400000;
          let label = dateStr;
          if (isToday) label = `📌 Today (${dateStr})`;
          else if (isTomorrow) label = `📅 Tomorrow (${dateStr})`;
          else label = `📅 ${dateStr}`;
          response += `\n### ${label}\n`;
        }

        const hotEmoji = task.engagement_score >= 30 ? ' 🔥' : '';
        response += `• **${task.org_name}**${hotEmoji}: ${task.description}\n`;
      }

      response += `\n---\n`;
      response += `${allTasks.length} task(s) scheduled`;
      if (allTasks.length > limit) {
        response += ` (showing first ${limit})`;
      }

      return response;
    } catch (error) {
      logger.error({ error, userId }, 'Error fetching upcoming tasks');
      return '❌ Failed to fetch upcoming tasks. Please try again.';
    }
  });

  // Log conversation - record an interaction and analyze for task management
  handlers.set('log_conversation', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const pool = getPool();
    let orgId = input.org_id as string | undefined;
    const companyName = input.company_name as string | undefined;
    const contactName = input.contact_name as string | undefined;
    const channel = (input.channel as string) || 'other';
    const summary = input.summary as string;

    const userId = memberContext?.workos_user?.workos_user_id;
    const userName = memberContext?.workos_user?.first_name || 'Unknown';

    if (!userId) {
      return '❌ Could not determine your user ID. Please try again.';
    }

    if (!summary) {
      return '❌ Please provide a summary of the conversation.';
    }

    try {
      // Look up org by name if no ID provided
      let orgName: string | undefined;

      if (!orgId && companyName) {
        // Escape LIKE pattern special characters (% and _)
        const escapedName = companyName.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const searchResult = await pool.query(`
          SELECT workos_organization_id, name
          FROM organizations
          WHERE LOWER(name) LIKE LOWER($1) ESCAPE '\\'
            AND is_personal IS NOT TRUE
          ORDER BY
            CASE WHEN LOWER(name) = LOWER($2) THEN 0 ELSE 1 END,
            engagement_score DESC NULLS LAST
          LIMIT 1
        `, [`%${escapedName}%`, companyName]);

        if (searchResult.rows.length > 0) {
          orgId = searchResult.rows[0].workos_organization_id;
          orgName = searchResult.rows[0].name;
        }
      } else if (orgId) {
        const orgResult = await pool.query(`
          SELECT name FROM organizations WHERE workos_organization_id = $1
        `, [orgId]);
        orgName = orgResult.rows[0]?.name;
      }

      // Log the activity
      const activityType = channel === 'call' || channel === 'video' ? 'call' :
                          channel === 'email' ? 'email' :
                          channel === 'in_person' ? 'meeting' : 'note';

      if (orgId) {
        await pool.query(`
          INSERT INTO org_activities (
            organization_id,
            activity_type,
            description,
            logged_by_user_id,
            logged_by_name,
            activity_date,
            metadata
          ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        `, [
          orgId,
          activityType,
          summary,
          userId,
          userName,
          JSON.stringify({ channel, contact_name: contactName }),
        ]);
      }

      // Analyze the interaction for task management
      const interactionContext: InteractionContext = {
        content: summary,
        channel: channel === 'slack_dm' ? 'slack_dm' : channel === 'email' ? 'email' : 'slack_channel',
        direction: 'outbound',
        organizationId: orgId,
        organizationName: orgName,
        contactName,
        adminUserId: userId,
        adminName: userName,
      };

      const analysisResult = await processInteraction(interactionContext);

      // Build response
      let response = `✅ Logged ${activityType}`;
      if (orgName) {
        response += ` with **${orgName}**`;
      }
      if (contactName) {
        response += ` (${contactName})`;
      }
      response += `\n\n`;

      // Report task actions
      if (analysisResult?.actionsApplied) {
        const { completed, rescheduled, created } = analysisResult.actionsApplied;

        if (completed > 0) {
          response += `✓ Auto-completed ${completed} task${completed > 1 ? 's' : ''}\n`;
        }
        if (rescheduled > 0) {
          response += `📅 Rescheduled ${rescheduled} task${rescheduled > 1 ? 's' : ''}\n`;
        }
        if (created > 0) {
          response += `📝 Created ${created} new follow-up${created > 1 ? 's' : ''}\n`;
        }
      }

      // Report learnings if any
      if (analysisResult?.analysis?.learnings) {
        const learnings = analysisResult.analysis.learnings;
        const hasLearnings = learnings.interests?.length ||
                            learnings.concerns?.length ||
                            learnings.decisionTimeline ||
                            learnings.budget ||
                            learnings.otherNotes;

        if (hasLearnings) {
          response += `\n**Learnings captured:**\n`;
          if (learnings.interests?.length) {
            response += `• Interests: ${learnings.interests.join(', ')}\n`;
          }
          if (learnings.concerns?.length) {
            response += `• Concerns: ${learnings.concerns.join(', ')}\n`;
          }
          if (learnings.decisionTimeline) {
            response += `• Timeline: ${learnings.decisionTimeline}\n`;
          }
          if (learnings.budget) {
            response += `• Budget: ${learnings.budget}\n`;
          }
          if (learnings.otherNotes) {
            response += `• Notes: ${learnings.otherNotes}\n`;
          }
        }
      }

      return response;
    } catch (error) {
      logger.error({ error, orgId, userId }, 'Error logging conversation');
      return '❌ Failed to log conversation. Please try again.';
    }
  });

  // ============================================
  // INSIGHT GOALS MANAGEMENT HANDLERS
  // ============================================

  // List insight goals
  handlers.set('list_insight_goals', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const activeOnly = input.active_only === true;

    try {
      const goals = await insightsDb.listGoals({ activeOnly });

      if (goals.length === 0) {
        return JSON.stringify({
          success: true,
          message: activeOnly ? 'No active insight goals configured.' : 'No insight goals configured yet.',
          goals: [],
        });
      }

      const formatted = goals.map(g => ({
        id: g.id,
        name: g.name,
        question: g.question,
        priority: g.priority,
        is_enabled: g.is_enabled,
        goal_type: g.goal_type,
        response_count: g.current_response_count,
        target: g.target_mapped_only ? 'mapped users only' : g.target_unmapped_only ? 'unmapped users only' : 'all users',
      }));

      return JSON.stringify({
        success: true,
        total: goals.length,
        goals: formatted,
      }, null, 2);
    } catch (error) {
      logger.error({ error }, 'Error listing insight goals');
      return '❌ Failed to list insight goals. Please try again.';
    }
  });

  // Add insight goal
  handlers.set('add_insight_goal', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const name = input.name as string;
    const question = input.question as string;
    const priority = (input.priority as number) || 50;
    const targetMappedOnly = input.target_mapped_only === true;

    if (!name || !question) {
      return '❌ Both name and question are required.';
    }

    try {
      const goal = await insightsDb.createGoal({
        name,
        question,
        priority,
        target_mapped_only: targetMappedOnly,
        is_enabled: true,
        created_by: memberContext?.workos_user?.workos_user_id || 'admin',
      });

      logger.info({ goalId: goal.id, name }, 'Admin created new insight goal');

      return JSON.stringify({
        success: true,
        message: `✅ Created insight goal "${name}" with priority ${priority}. Addie will naturally try to learn this from members.`,
        goal: {
          id: goal.id,
          name: goal.name,
          question: goal.question,
          priority: goal.priority,
        },
      });
    } catch (error) {
      logger.error({ error, name, question }, 'Error creating insight goal');
      return '❌ Failed to create insight goal. Please try again.';
    }
  });

  // Update insight goal
  handlers.set('update_insight_goal', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const goalId = input.goal_id as number;
    if (!goalId) {
      return '❌ goal_id is required.';
    }

    try {
      const updates: Record<string, unknown> = {};
      if (input.is_enabled !== undefined) updates.is_enabled = input.is_enabled;
      if (input.priority !== undefined) updates.priority = input.priority;
      if (input.question !== undefined) updates.question = input.question;

      if (Object.keys(updates).length === 0) {
        return '❌ No updates provided. Specify is_enabled, priority, or question.';
      }

      const goal = await insightsDb.updateGoal(goalId, updates);
      if (!goal) {
        return `❌ Goal with ID ${goalId} not found.`;
      }

      logger.info({ goalId, updates }, 'Admin updated insight goal');

      return JSON.stringify({
        success: true,
        message: `✅ Updated insight goal "${goal.name}".`,
        goal: {
          id: goal.id,
          name: goal.name,
          question: goal.question,
          priority: goal.priority,
          is_enabled: goal.is_enabled,
        },
      });
    } catch (error) {
      logger.error({ error, goalId }, 'Error updating insight goal');
      return '❌ Failed to update insight goal. Please try again.';
    }
  });

  // Get insight summary
  handlers.set('get_insight_summary', async (input) => {
    const adminCheck = requireAdminFromContext();
    if (adminCheck) return adminCheck;

    const insightType = input.insight_type as string | undefined;
    const limit = (input.limit as number) || 5;

    try {
      // Get stats
      const stats = await insightsDb.getInsightStats();

      // Get insight types with counts
      const types = await insightsDb.listInsightTypes(true);

      // Build summary
      const summary: Record<string, unknown> = {
        overview: {
          members_with_insights: stats.members_with_insights,
          total_insights: stats.total_insights,
          from_conversation: stats.from_conversation,
          from_manual: stats.from_manual,
        },
        types: [] as unknown[],
      };

      // For each type, get example insights
      // Note: N+1 queries here but acceptable - admin-only function with ~10 types max
      for (const type of types) {
        if (insightType && type.name !== insightType) continue;

        const insights = await insightsDb.getInsightsByType(type.id, limit);

        (summary.types as unknown[]).push({
          name: type.name,
          description: type.description,
          count: insights.length,
          examples: insights.map(i => ({
            value: i.value,
            confidence: i.confidence,
            source: i.source_type,
            created_at: i.created_at,
          })),
        });
      }

      return JSON.stringify(summary, null, 2);
    } catch (error) {
      logger.error({ error }, 'Error getting insight summary');
      return '❌ Failed to get insight summary. Please try again.';
    }
  });

  // ============================================
  // MEMBER SEARCH ANALYTICS HANDLERS
  // ============================================
  handlers.set('get_member_search_analytics', async (input) => {
    const adminError = requireAdminFromContext();
    if (adminError) return adminError;

    try {
      const days = Math.min(Math.max((input.days as number) || 30, 1), 365);

      const memberSearchAnalyticsDb = new MemberSearchAnalyticsDatabase();
      const memberDb = new MemberDatabase();

      // Get global analytics and recent introductions
      const [globalAnalytics, recentIntroductions] = await Promise.all([
        memberSearchAnalyticsDb.getGlobalAnalytics(days),
        memberSearchAnalyticsDb.getRecentIntroductionsGlobal(10),
      ]);

      // Enrich top members with profile info
      const enrichedTopMembers = await Promise.all(
        globalAnalytics.top_members.slice(0, 5).map(async (member) => {
          const profile = await memberDb.getProfileById(member.member_profile_id);
          return {
            display_name: profile?.display_name || 'Unknown',
            slug: profile?.slug || null,
            impressions: member.impressions,
          };
        })
      );

      // Enrich recent introductions with profile info
      const enrichedIntroductions = await Promise.all(
        recentIntroductions.map(async (intro) => {
          const profile = await memberDb.getProfileById(intro.member_profile_id);
          return {
            event_type: intro.event_type,
            member_name: profile?.display_name || 'Unknown',
            member_slug: profile?.slug || null,
            searcher_name: intro.searcher_name,
            searcher_email: intro.searcher_email,
            searcher_company: intro.searcher_company,
            search_query: intro.search_query,
            reasoning: intro.reasoning,
            message: intro.message,
            created_at: intro.created_at,
          };
        })
      );

      // Build response
      let response = `## Member Search Analytics (Last ${days} Days)\n\n`;

      response += `### Summary\n`;
      response += `- **Unique searches:** ${globalAnalytics.total_searches}\n`;
      response += `- **Total impressions:** ${globalAnalytics.total_impressions}\n`;
      response += `- **Profile clicks:** ${globalAnalytics.total_clicks}\n`;
      response += `- **Introduction requests:** ${globalAnalytics.total_intro_requests}\n`;
      response += `- **Introductions sent:** ${globalAnalytics.total_intros_sent}\n`;
      response += `- **Unique searchers:** ${globalAnalytics.unique_searchers}\n\n`;

      // Calculate rates
      if (globalAnalytics.total_impressions > 0) {
        const clickRate = ((globalAnalytics.total_clicks / globalAnalytics.total_impressions) * 100).toFixed(1);
        response += `**Click-through rate:** ${clickRate}%\n`;
      }
      if (globalAnalytics.total_clicks > 0) {
        const introRate = ((globalAnalytics.total_intro_requests / globalAnalytics.total_clicks) * 100).toFixed(1);
        response += `**Introduction rate (from clicks):** ${introRate}%\n`;
      }
      response += '\n';

      // Top queries
      if (globalAnalytics.top_queries.length > 0) {
        response += `### Top Search Queries\n`;
        for (const q of globalAnalytics.top_queries.slice(0, 5)) {
          response += `- "${q.query}" (${q.count} searches)\n`;
        }
        response += '\n';
      }

      // Top members
      if (enrichedTopMembers.length > 0) {
        response += `### Top Members by Visibility\n`;
        for (const m of enrichedTopMembers) {
          response += `- **${m.display_name}** - ${m.impressions} impressions`;
          if (m.slug) response += ` ([profile](/members/${m.slug}))`;
          response += '\n';
        }
        response += '\n';
      }

      // Recent introductions
      if (enrichedIntroductions.length > 0) {
        response += `### Recent Introductions\n`;
        for (const intro of enrichedIntroductions) {
          const date = new Date(intro.created_at).toLocaleDateString();
          const status = intro.event_type === 'introduction_sent' ? '✅ Sent' : '📝 Requested';
          response += `- ${status} **${intro.searcher_name}**`;
          if (intro.searcher_company) response += ` (${intro.searcher_company})`;
          response += ` → **${intro.member_name}** on ${date}\n`;
          if (intro.search_query) response += `  - Searched: "${intro.search_query}"\n`;
        }
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error getting member search analytics');
      return '❌ Failed to get member search analytics. Please try again.';
    }
  });

  return handlers;
}
