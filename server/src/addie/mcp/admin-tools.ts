/**
 * Addie Admin Tools
 *
 * Tools available only to AAO platform admin users for:
 * - Looking up organization status and pending invoices
 * - Managing prospects and enrichment
 *
 * AAO platform admins are determined by membership in the "aao-admin" working group:
 * - Slack users: via isSlackUserAAOAdmin() which looks up WorkOS user ID from Slack mapping
 * - Web users: via isWebUserAAOAdmin() which checks working group membership directly
 *
 * Note: This is distinct from WorkOS organization admins, who are admins within their
 * own company's organization but do not have AAO platform-wide admin access.
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import type { MemberContext } from '../member-context.js';
import { OrganizationDatabase } from '../../db/organization-db.js';
import type { MembershipTier } from '../../db/organization-db.js';
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
  resendInvoice,
  updateCustomerEmail,
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
  createStripeCustomer,
  type BillingProduct,
} from '../../billing/stripe-client.js';
import { mergeOrganizations, previewMerge, type StripeCustomerResolution } from '../../db/org-merge-db.js';
import { workos } from '../../auth/workos-client.js';
import { DomainDataState } from '@workos-inc/node';
import { processInteraction, type InteractionContext } from '../services/interaction-analyzer.js';
import {
  listEscalations,
  getEscalation,
  updateEscalationStatus,
  buildResolutionNotificationMessage,
  type EscalationStatus,
} from '../../db/escalation-db.js';
import { sendDirectMessage } from '../../slack/client.js';

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
export async function isSlackUserAAOAdmin(slackUserId: string): Promise<boolean> {
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
export async function isWebUserAAOAdmin(workosUserId: string): Promise<boolean> {
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
    description: 'Get complete account view for any organization: lifecycle stage, membership status, engagement metrics, pipeline info, and enrichment data. Use for any company lookup.',
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

  {
    name: 'resend_invoice',
    description: `Resend an open invoice. Provide EITHER an invoice_id (if known) OR a company_name to look up their pending invoices. If the company has exactly one open invoice, it will be resent automatically. If the invoice needs to go to a different email, use update_billing_email first.`,
    usage_hints: 'Pass company_name to look up and resend in one step. Use update_billing_email first if the email needs to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        invoice_id: {
          type: 'string',
          description: 'Stripe invoice ID (starts with in_) — if you already have it',
        },
        company_name: {
          type: 'string',
          description: 'Company name to look up (will find their open invoices)',
        },
      },
    },
  },
  {
    name: 'update_billing_email',
    description: `Update the billing email on a Stripe customer. Use this when invoices need to go to a different email address (e.g., accounts payable). Can look up by org_id or direct customer_id.`,
    usage_hints: 'Use before resend_invoice if the email needs to change. Get org_id from get_account.',
    input_schema: {
      type: 'object' as const,
      properties: {
        org_id: {
          type: 'string',
          description: 'WorkOS organization ID (org_...) — will look up Stripe customer',
        },
        customer_id: {
          type: 'string',
          description: 'Direct Stripe customer ID (cus_...) — use if org_id is not available',
        },
        email: {
          type: 'string',
          description: 'New billing email address',
        },
      },
      required: ['email'],
    },
  },

  // ============================================
  // PROSPECT MANAGEMENT TOOLS
  // ============================================
  {
    name: 'add_prospect',
    description:
      'Add a new prospect organization to track. Use get_account first to confirm the company does not exist. Capture as much info as possible: name, domain, contact details, and notes about their interest.',
    usage_hints: 'Always use get_account first to check if company exists. Include champion info in notes (e.g., "Champion: Jane Doe, VP Sales").',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company name' },
        company_type: { type: 'string', enum: COMPANY_TYPE_VALUES, description: 'Type of company' },
        domain: { type: 'string', description: 'Company domain (for enrichment/dedup)' },
        contact_name: { type: 'string', description: 'Primary contact name' },
        contact_email: { type: 'string', description: 'Primary contact email' },
        contact_title: { type: 'string', description: 'Primary contact job title' },
        notes: { type: 'string', description: 'Notes about the prospect' },
        source: { type: 'string', description: 'How we found this prospect' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_prospect',
    description:
      'Update information about an existing prospect. Use this to add notes, change status, update contact info, or set interest level. IMPORTANT: When adding notes that indicate excitement, resource commitment, or intent to join, also set interest_level accordingly.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organization ID' },
        company_type: { type: 'string', enum: COMPANY_TYPE_VALUES, description: 'Type of company' },
        status: { type: 'string', enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'], description: 'Prospect status' },
        interest_level: { type: 'string', enum: ['low', 'medium', 'high', 'very_high'], description: 'Interest level (low/medium/high/very_high)' },
        contact_name: { type: 'string', description: 'Primary contact name' },
        contact_email: { type: 'string', description: 'Primary contact email' },
        notes: { type: 'string', description: 'Notes to append' },
        domain: { type: 'string', description: 'Company domain' },
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
        domain: { type: 'string', description: 'Company domain to research' },
        company_name: { type: 'string', description: 'Company name (if domain not provided)' },
        org_id: { type: 'string', description: 'Organization ID to save enrichment to' },
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
        status: { type: 'string', enum: ['prospect', 'contacted', 'responded', 'interested', 'negotiating', 'converted', 'declined', 'inactive'], description: 'Filter by status' },
        company_type: { type: 'string', enum: COMPANY_TYPE_VALUES, description: 'Filter by company type' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        sort: { type: 'string', enum: ['recent', 'name', 'activity'], description: 'Sort order' },
      },
      required: [],
    },
  },
  {
    name: 'send_payment_request',
    description: 'Send payment link or invoice to prospect. Finds/creates company, applies discounts, generates Stripe checkout URL or invoice. For invoices: use draft_invoice first, then send_invoice.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company name' },
        domain: { type: 'string', description: 'Company domain' },
        contact_name: { type: 'string', description: 'Contact person name' },
        contact_email: { type: 'string', description: 'Contact email (required for invoice)' },
        contact_title: { type: 'string', description: 'Contact job title' },
        action: { type: 'string', enum: ['payment_link', 'draft_invoice', 'send_invoice', 'lookup_only'], description: 'Action type (default: payment_link)' },
        lookup_key: { type: 'string', description: 'Product lookup_key from find_membership_products' },
        billing_address: {
          type: 'object',
          description: 'Billing address (required for invoices)',
          properties: { line1: { type: 'string' }, line2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, postal_code: { type: 'string' }, country: { type: 'string' } },
        },
        discount_percent: { type: 'number', description: 'Percentage discount' },
        discount_amount_dollars: { type: 'number', description: 'Fixed dollar discount' },
        discount_reason: { type: 'string', description: 'Reason for discount' },
        use_existing_discount: { type: 'boolean', description: 'Use existing org discount (default: true)' },
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
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to search for' },
        industries: { type: 'array', items: { type: 'string' }, description: 'Industry categories' },
        min_employees: { type: 'number', description: 'Min employee count' },
        max_employees: { type: 'number', description: 'Max employee count' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Countries to include' },
        limit: { type: 'number', description: 'Max results (default 10)' },
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
        query: { type: 'string', description: 'Search query' },
        status: { type: 'string', enum: ['all', 'active', 'inactive', 'errors'], description: 'Filter by status' },
        limit: { type: 'number', description: 'Max results (default 10)' },
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
        name: { type: 'string', description: 'Feed name' },
        feed_url: { type: 'string', description: 'RSS feed URL' },
        category: { type: 'string', enum: ['ad-tech', 'advertising', 'marketing', 'media', 'tech'], description: 'Feed category' },
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
        limit: { type: 'number', description: 'Max results (default 20)' },
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
        proposal_id: { type: 'number', description: 'Proposal ID' },
        feed_name: { type: 'string', description: 'Feed name' },
        feed_url: { type: 'string', description: 'RSS feed URL' },
        category: { type: 'string', enum: ['ad-tech', 'advertising', 'marketing', 'media', 'martech', 'ctv', 'dooh', 'creator', 'ai', 'sports', 'industry', 'research'], description: 'Feed category' },
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
        proposal_id: { type: 'number', description: 'Proposal ID' },
        reason: { type: 'string', description: 'Rejection reason' },
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
        slack_user_id: { type: 'string', description: 'Slack user ID' },
        email: { type: 'string', description: 'Email address' },
        name: { type: 'string', description: 'Full name' },
        organization: { type: 'string', description: 'Media organization' },
        role: { type: 'string', description: 'Role (Reporter/Editor/etc)' },
        notes: { type: 'string', description: 'Additional notes' },
        handling_level: { type: 'string', enum: ['standard', 'careful', 'executive_only'], description: 'Handling level' },
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
        unreviewed_only: { type: 'boolean', description: 'Only unreviewed (default: true)' },
        severity: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Filter by severity' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
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
        flagged_id: { type: 'number', description: 'Flagged conversation ID' },
        notes: { type: 'string', description: 'Review notes' },
      },
      required: ['flagged_id'],
    },
  },

  // ============================================
  // DISCOUNT MANAGEMENT TOOLS
  // ============================================
  {
    name: 'grant_discount',
    description: 'Grant a discount to an organization. Creates Stripe coupon/promo code.',
    input_schema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'Organization ID' },
        org_name: { type: 'string', description: 'Company name (if no org_id)' },
        discount_percent: { type: 'number', description: 'Percentage off' },
        discount_amount_dollars: { type: 'number', description: 'Fixed dollar amount off' },
        reason: { type: 'string', description: 'Discount reason' },
        create_promotion_code: { type: 'boolean', description: 'Create Stripe promo code (default: true)' },
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
        org_id: { type: 'string', description: 'Organization ID' },
        org_name: { type: 'string', description: 'Company name (if no org_id)' },
      },
      required: [],
    },
  },
  {
    name: 'list_discounts',
    description: 'List organizations with active discounts.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'create_promotion_code',
    description: 'Create a standalone Stripe promo code for marketing campaigns.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Checkout code (e.g., "LAUNCH2025")' },
        name: { type: 'string', description: 'Internal coupon name' },
        percent_off: { type: 'number', description: 'Percentage off' },
        amount_off_dollars: { type: 'number', description: 'Fixed dollar amount off' },
        duration: { type: 'string', enum: ['once', 'repeating', 'forever'], description: 'Duration (default: once)' },
        max_redemptions: { type: 'number', description: 'Max uses' },
      },
      required: ['code'],
    },
  },

  // ============================================
  // CHAPTER MANAGEMENT TOOLS
  // ============================================
  {
    name: 'create_chapter',
    description: 'Create a regional chapter with Slack channel. Sets founding member as chapter leader.',
    usage_hints: 'Use when a member wants to start a chapter.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Chapter name' },
        region: { type: 'string', description: 'Geographic region' },
        founding_member_id: { type: 'string', description: 'Founding member WorkOS user ID' },
        description: { type: 'string', description: 'Chapter description' },
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
    description: 'Create an industry gathering for conferences/trade shows. Auto-archives after event ends.',
    usage_hints: 'Use for coordinating around major industry events.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Event name' },
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        location: { type: 'string', description: 'Event location' },
        website_url: { type: 'string', description: 'Event website URL' },
        description: { type: 'string', description: 'Event description' },
        founding_member_id: { type: 'string', description: 'Founding member WorkOS user ID' },
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
    description: 'Add a user as leader of a committee. Leaders can manage posts, events, and members.',
    usage_hints: 'Get user_id from Slack mapping or org details.',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        user_id: { type: 'string', description: 'WorkOS user ID' },
        user_email: { type: 'string', description: 'User email (optional)' },
      },
      required: ['committee_slug', 'user_id'],
    },
  },
  {
    name: 'remove_committee_leader',
    description: 'Remove a user from committee leadership. User remains a regular member.',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        user_id: { type: 'string', description: 'WorkOS user ID' },
      },
      required: ['committee_slug', 'user_id'],
    },
  },
  {
    name: 'list_committee_leaders',
    description: 'List all leaders of a committee.',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
      },
      required: ['committee_slug'],
    },
  },

  // ============================================
  // ORGANIZATION MANAGEMENT TOOLS
  // ============================================
  {
    name: 'merge_organizations',
    description: 'Merge duplicate organization records. Destructive, cannot be undone. Preview first with preview=true. If both orgs have Stripe customers, you must specify stripe_customer_resolution.',
    usage_hints: 'Preview first, then execute with preview=false. Check preview for Stripe customer conflicts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        primary_org_id: { type: 'string', description: 'Org ID to keep (data merged into)' },
        secondary_org_id: { type: 'string', description: 'Org ID to remove (data moved from)' },
        preview: { type: 'boolean', description: 'Show preview only (default: true)' },
        stripe_customer_resolution: {
          type: 'string',
          enum: ['keep_primary', 'use_secondary', 'keep_both_unlinked'],
          description: 'Required if both orgs have Stripe customers. keep_primary=keep primary Stripe customer, use_secondary=replace with secondary Stripe customer, keep_both_unlinked=unlink both for manual resolution',
        },
      },
      required: ['primary_org_id', 'secondary_org_id'],
    },
  },
  {
    name: 'find_duplicate_orgs',
    description: 'Search for duplicate organizations by name or domain.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search_type: { type: 'string', enum: ['name', 'domain', 'all'], description: 'Search type' },
      },
      required: [],
    },
  },
  {
    name: 'check_domain_health',
    description: 'Check domain health for data quality issues: orphan domains, conflicts, misaligned users.',
    usage_hints: 'Use for data quality audits.',
    input_schema: {
      type: 'object' as const,
      properties: {
        check_type: { type: 'string', enum: ['orphan_domains', 'unverified_domains', 'domain_conflicts', 'misaligned_users', 'all'], description: 'Check type' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'manage_organization_domains',
    description: 'Add, remove, or list verified domains for an organization. Syncs to WorkOS.',
    usage_hints: 'Use "list" first. Add/remove sync to WorkOS.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'set_primary'], description: 'Action' },
        organization_id: { type: 'string', description: 'WorkOS organization ID' },
        domain: { type: 'string', description: 'Domain name' },
        set_as_primary: { type: 'boolean', description: 'Set as primary (default: false)' },
      },
      required: ['action', 'organization_id'],
    },
  },
  {
    name: 'update_org_member_role',
    description: `Update a user's role within their organization. Use this to change a member's permissions.

Common scenarios:
- User paid for membership but can't manage team → promote to admin
- Need to grant someone ability to invite team members → promote to admin
- User should have full control of their org → promote to owner

Roles: member (default), admin (can manage team), owner (full control)`,
    usage_hints: 'Get user_id from get_account tool or escalation context. Use when members need elevated permissions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        org_id: { type: 'string', description: 'WorkOS organization ID (org_...)' },
        user_id: { type: 'string', description: 'WorkOS user ID (user_...)' },
        role: { type: 'string', enum: ['member', 'admin', 'owner'], description: 'New role' },
      },
      required: ['org_id', 'user_id', 'role'],
    },
  },

  {
    name: 'rename_working_group',
    description: `Rename a working group, chapter, or committee. Updates the display name and optionally the slug. Use this when a chapter or WG needs to be renamed (e.g., "Germany Chapter" → "DACH Chapter").`,
    usage_hints: 'Look up current slug first with list_working_groups or list_chapters.',
    input_schema: {
      type: 'object' as const,
      properties: {
        working_group_slug: {
          type: 'string',
          description: 'Current slug of the working group/chapter',
        },
        new_name: {
          type: 'string',
          description: 'New display name',
        },
        new_slug: {
          type: 'string',
          description: 'New slug (optional — auto-generated from name if not provided)',
        },
      },
      required: ['working_group_slug', 'new_name'],
    },
  },

  // ============================================
  // PROSPECT OWNERSHIP & PIPELINE TOOLS
  // ============================================
  {
    name: 'my_engaged_prospects',
    description: 'List your most engaged prospects sorted by engagement score.',
    usage_hints: 'See which of your owned prospects are showing interest.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default: 10)' },
        hot_only: { type: 'boolean', description: 'Only hot prospects (score >= 30)' },
      },
      required: [],
    },
  },
  {
    name: 'my_followups_needed',
    description: 'List your prospects needing follow-up: stale or overdue.',
    usage_hints: 'Daily check-ins to see what needs attention.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_stale: { type: 'number', description: 'Days stale threshold (default: 14)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'unassigned_prospects',
    description: 'List high-engagement prospects with no owner assigned.',
    usage_hints: 'Find prospects worth claiming.',
    input_schema: {
      type: 'object' as const,
      properties: {
        min_engagement: { type: 'number', description: 'Min engagement (default: 10)' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'claim_prospect',
    description: 'Claim ownership of a prospect organization.',
    usage_hints: 'Use after finding unassigned prospects.',
    input_schema: {
      type: 'object' as const,
      properties: {
        org_id: { type: 'string', description: 'Organization ID' },
        company_name: { type: 'string', description: 'Company name (if no org_id)' },
        replace_existing: { type: 'boolean', description: 'Replace existing owner (default: false)' },
        notes: { type: 'string', description: 'Notes' },
      },
      required: [],
    },
  },
  {
    name: 'suggest_prospects',
    description: 'Suggest companies to add to prospect list. Finds unmapped domains and Lusha matches.',
    usage_hints: 'Expand prospect pipeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_lusha: { type: 'boolean', description: 'Include Lusha results (default: true)' },
        lusha_keywords: { type: 'array', items: { type: 'string' }, description: 'Lusha search keywords' },
        limit: { type: 'number', description: 'Max results per source (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder/next step for a prospect.',
    usage_hints: 'Schedule a future follow-up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        company_name: { type: 'string', description: 'Company name' },
        org_id: { type: 'string', description: 'Organization ID' },
        reminder: { type: 'string', description: 'What needs to be done' },
        due_date: { type: 'string', description: 'Due date' },
      },
      required: ['reminder', 'due_date'],
    },
  },
  {
    name: 'my_upcoming_tasks',
    description: 'List upcoming tasks and reminders.',
    usage_hints: 'Planning and scheduling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days_ahead: { type: 'number', description: 'Days ahead (default: 7)' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: [],
    },
  },
  {
    name: 'log_conversation',
    description: 'Log a conversation or interaction with a prospect/member. Analyzes and extracts learnings.',
    usage_hints: 'Use when admin reports an interaction.',
    input_schema: {
      type: 'object' as const,
      properties: {
        company_name: { type: 'string', description: 'Company name' },
        org_id: { type: 'string', description: 'Organization ID' },
        contact_name: { type: 'string', description: 'Contact name' },
        channel: { type: 'string', enum: ['call', 'video', 'slack_dm', 'email', 'in_person', 'other'], description: 'Channel' },
        summary: { type: 'string', description: 'Summary of discussion' },
      },
      required: ['summary'],
    },
  },

  // ============================================
  // MEMBER INSIGHT SUMMARY TOOLS
  // ============================================
  {
    name: 'get_insight_summary',
    description: 'Get summary of collected member insights and statistics.',
    usage_hints: 'See value of insight collection.',
    input_schema: {
      type: 'object' as const,
      properties: {
        insight_type: { type: 'string', description: 'Filter by type' },
        limit: { type: 'number', description: 'Max examples per type (default: 5)' },
      },
    },
  },

  // ============================================
  // MEMBER SEARCH & INTRODUCTION ANALYTICS TOOLS
  // ============================================
  {
    name: 'get_member_search_analytics',
    description: 'Get analytics about member searches and introductions.',
    usage_hints: 'Monitor directory and introduction performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Days to look back (default: 30)' },
      },
    },
  },

  // ============================================
  // ORGANIZATION ANALYTICS TOOLS
  // ============================================
  {
    name: 'list_organizations_by_users',
    description: 'List organizations ranked by user count (website + Slack-only).',
    usage_hints: 'Rank orgs by engagement.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20)' },
        member_status: { type: 'string', enum: ['member', 'prospect', 'churned', 'all'], description: 'Filter status' },
        min_users: { type: 'number', description: 'Min users (default: 1)' },
      },
    },
  },
  {
    name: 'list_slack_users_by_org',
    description: 'List Slack users from a specific organization.',
    usage_hints: 'See specific people from a company.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Company name or domain' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_paying_members',
    description: 'List all paying members grouped by subscription level ($50K ICL, $10K corporate, $2.5K SMB). Defaults to corporate members only.',
    usage_hints: 'Use when asked about paying members, subscription breakdown, who pays what, or membership revenue by tier.',
    input_schema: {
      type: 'object' as const,
      properties: {
        include_individual: {
          type: 'boolean',
          description: 'Include individual (personal) memberships (default: false, corporate only)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 50)',
        },
      },
    },
  },

  // ============================================
  // INSIGHT SYNTHESIS TOOLS
  // ============================================
  {
    name: 'tag_insight',
    description: 'Tag content for Addie\'s knowledge synthesis.',
    usage_hints: 'Use when admin shares expert insights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Content to tag' },
        topic: { type: 'string', description: 'Topic category' },
        author_name: { type: 'string', description: 'Author name' },
        author_context: { type: 'string', description: 'Author role/expertise' },
        notes: { type: 'string', description: 'Additional context' },
      },
      required: ['content'],
    },
  },
  {
    name: 'list_pending_insights',
    description: 'List insights pending synthesis.',
    usage_hints: 'See synthesis queue.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Filter by topic' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
    },
  },
  {
    name: 'run_synthesis',
    description: 'Trigger insight synthesis to create knowledge rules. Requires admin approval.',
    usage_hints: 'Process tagged insights into rules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Synthesize specific topic (default: all)' },
      },
    },
  },

  // ============================================
  // ESCALATION MANAGEMENT TOOLS
  // ============================================
  {
    name: 'list_escalations',
    description: `List escalations that need admin attention. Use this to see what requests Addie couldn't handle and need human action.

Filter by status to see open escalations, ones in progress, or recently resolved.`,
    usage_hints: 'Check open escalations regularly. Start with status=open.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['open', 'acknowledged', 'in_progress', 'resolved', 'wont_do', 'expired'], description: 'Filter by status (default: open)' },
        category: { type: 'string', enum: ['capability_gap', 'needs_human_action', 'complex_request', 'sensitive_topic', 'other'], description: 'Filter by category' },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: [],
    },
  },
  {
    name: 'resolve_escalation',
    description: `Mark an escalation as resolved and optionally notify the user. Use this after you've handled a request that was previously escalated.

IMPORTANT: Always notify the user unless there's a reason not to (e.g., test escalation, duplicate).

Examples:
- User needed admin role → used update_org_member_role → resolve and notify
- User needed co-leader added → used add_committee_co_leader → resolve and notify
- Duplicate request → resolve with wont_do, no notification needed`,
    usage_hints: 'After handling an escalated request, resolve it and notify the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        escalation_id: { type: 'number', description: 'Escalation ID to resolve' },
        status: { type: 'string', enum: ['resolved', 'wont_do'], description: 'Resolution status (default: resolved)' },
        resolution_notes: { type: 'string', description: 'Notes about what was done to resolve' },
        notify_user: { type: 'boolean', description: 'Send DM to user about resolution (default: true)' },
        notification_message: { type: 'string', description: 'Custom message to include in notification' },
      },
      required: ['escalation_id'],
    },
  },
  // ============================================
  // BAN MANAGEMENT TOOLS
  // ============================================
  {
    name: 'ban_entity',
    description: `Ban a user, organization, or API key. Scope can be platform-wide (blocks all access) or registry-specific (blocks brand/property edits only).

Examples:
- Platform ban user: ban_type=user, entity_id=user_01HW..., scope=platform
- Ban org from brand edits: ban_type=organization, entity_id=org_01HW..., scope=registry_brand
- Revoke API key: ban_type=api_key, entity_id=wkapikey_..., scope=platform`,
    input_schema: {
      type: 'object' as const,
      properties: {
        ban_type: {
          type: 'string',
          enum: ['user', 'organization', 'api_key'],
          description: 'What kind of entity to ban',
        },
        entity_id: {
          type: 'string',
          description: 'The entity ID (WorkOS user ID, org ID, or API key ID)',
        },
        scope: {
          type: 'string',
          enum: ['platform', 'registry_brand', 'registry_property'],
          description: 'What to ban from: platform (all access) or registry editing',
        },
        scope_target: {
          type: 'string',
          description: 'For registry bans: specific domain to ban from (omit for global)',
        },
        reason: {
          type: 'string',
          description: 'Why this entity is being banned',
        },
        expires_in_days: {
          type: 'number',
          description: 'Ban duration in days (omit for permanent)',
        },
      },
      required: ['ban_type', 'entity_id', 'scope', 'reason'],
    },
  },
  {
    name: 'unban_entity',
    description: 'Remove a ban. Provide either the ban ID directly, or the ban_type + entity_id + scope to look it up.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ban_id: {
          type: 'string',
          description: 'The ban UUID to remove (if known)',
        },
        ban_type: {
          type: 'string',
          enum: ['user', 'organization', 'api_key'],
          description: 'Entity type (used with entity_id to find the ban)',
        },
        entity_id: {
          type: 'string',
          description: 'Entity ID to look up (used with ban_type)',
        },
        scope: {
          type: 'string',
          enum: ['platform', 'registry_brand', 'registry_property'],
          description: 'Scope to match (used with ban_type + entity_id)',
        },
      },
    },
  },
  {
    name: 'list_bans',
    description: 'List active bans. Optionally filter by ban_type, scope, or entity_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        ban_type: {
          type: 'string',
          enum: ['user', 'organization', 'api_key'],
          description: 'Filter by entity type',
        },
        scope: {
          type: 'string',
          enum: ['platform', 'registry_brand', 'registry_property'],
          description: 'Filter by scope',
        },
        entity_id: {
          type: 'string',
          description: 'Filter by entity ID',
        },
      },
    },
  },
];

/**
 * Format membership tier for display
 */
function formatMembershipTier(tier: string): string {
  const labels: Record<string, string> = {
    individual_professional: 'Professional ($250/yr)',
    individual_academic: 'Academic ($50/yr)',
    company_standard: 'Company Standard ($2.5K or $10K/yr based on revenue)',
    company_icl: 'Industry Council Leader ($50K/yr)',
  };
  return labels[tier] || tier;
}

/**
 * Infer membership tier from subscription amount and organization type.
 * Amounts are in cents. Monthly amounts are annualized for comparison.
 */
function inferMembershipTier(
  amountCents: number | null,
  interval: string | null,
  isPersonal: boolean
): MembershipTier | null {
  if (amountCents == null || amountCents === 0) return null;

  const annualCents = interval === 'month' ? amountCents * 12 : amountCents;

  if (isPersonal) {
    if (annualCents >= 25000) return 'individual_professional';
    if (annualCents >= 5000) return 'individual_academic';
    return null;
  }

  // company_standard covers both $2.5K and $10K pricing tiers
  if (annualCents >= 5000000) return 'company_icl';
  return 'company_standard';
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

interface FormattedInvoice {
  id: string;
  status: string;
  amount: string;
  product: string;
  sent_to: string;
  created: string;
  due_date: string;
  payment_url: string | null;
}

function formatPendingInvoice(invoice: PendingInvoice): FormattedInvoice {
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

function renderPendingInvoiceSection(pendingInvoices: PendingInvoice[]): string {
  if (pendingInvoices.length === 0) return '';
  let result = `**Pending invoices:** ${pendingInvoices.length}\n`;
  for (const inv of pendingInvoices.slice(0, 3)) {
    const formatted = formatPendingInvoice(inv);
    result += `  - \`${formatted.id}\` — ${formatted.amount} (${formatted.status})`;
    if (formatted.sent_to !== 'Unknown') result += ` → ${formatted.sent_to}`;
    result += '\n';
  }
  if (pendingInvoices.length > 3) {
    result += `  _... and ${pendingInvoices.length - 3} more (use list_pending_invoices for all)_\n`;
  }
  return result;
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
 * Admin tool handler implementations.
 * Callers must gate access via isSlackUserAAOAdmin/isWebUserAAOAdmin before registering these handlers.
 */
export function createAdminToolHandlers(
  memberContext?: MemberContext | null
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();


  // ============================================
  // BILLING & INVOICE HANDLERS
  // ============================================

  // List pending invoices across all customers (queries Stripe directly)
  handlers.set('list_pending_invoices', async (input) => {

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

  // Resend an open invoice — by invoice_id or company_name lookup
  handlers.set('resend_invoice', async (input) => {
    const invoiceId = input.invoice_id as string | undefined;
    const companyName = input.company_name as string | undefined;

    // Direct resend by invoice ID
    if (invoiceId) {
      if (!invoiceId.startsWith('in_')) {
        return '❌ Invoice ID must start with in_ (e.g., in_1234567890).';
      }

      logger.info({ invoiceId }, 'Addie: Admin resending invoice');

      const result = await resendInvoice(invoiceId);
      if (!result.success) {
        return `❌ Could not resend invoice: ${result.error}`;
      }

      let msg = `✅ Invoice ${invoiceId} has been resent.`;
      if (result.hosted_invoice_url) {
        msg += `\n\nPayment link: ${result.hosted_invoice_url}`;
      }
      return msg;
    }

    // Lookup by company name
    if (companyName) {
      const pool = getPool();
      const escaped = companyName.replace(/[%_\\]/g, '\\$&');
      const searchPattern = `%${escaped}%`;
      const orgResult = await pool.query(
        `SELECT workos_organization_id, name, stripe_customer_id
         FROM organizations
         WHERE is_personal = false
           AND (LOWER(name) LIKE LOWER($1) ESCAPE '\\' OR LOWER(email_domain) LIKE LOWER($1) ESCAPE '\\')
         LIMIT 5`,
        [searchPattern]
      );

      if (orgResult.rows.length === 0) {
        return `❌ No organization found matching "${companyName}".`;
      }

      // Fetch invoices for all orgs with Stripe customers (cache to avoid duplicate API calls)
      const invoicesByOrg = new Map<string, PendingInvoice[]>();
      for (const org of orgResult.rows) {
        if (!org.stripe_customer_id) continue;
        invoicesByOrg.set(org.workos_organization_id, await getPendingInvoices(org.stripe_customer_id));
      }

      // Find orgs with open invoices
      const orgsWithOpen: { org: typeof orgResult.rows[0]; invoices: PendingInvoice[] }[] = [];
      for (const org of orgResult.rows) {
        const invoices = invoicesByOrg.get(org.workos_organization_id) || [];
        const openInvoices = invoices.filter(inv => inv.status === 'open');
        if (openInvoices.length > 0) {
          orgsWithOpen.push({ org, invoices: openInvoices });
        }
      }

      // If exactly one org with exactly one open invoice — resend it
      if (orgsWithOpen.length === 1 && orgsWithOpen[0].invoices.length === 1) {
        const { org, invoices: openInvoices } = orgsWithOpen[0];
        const inv = openInvoices[0];
        logger.info({ invoiceId: inv.id, orgName: org.name }, 'Addie: Admin resending invoice by company lookup');

        const result = await resendInvoice(inv.id);
        if (!result.success) {
          return `❌ Found invoice \`${inv.id}\` for ${org.name} but could not resend: ${result.error}`;
        }

        let msg = `✅ Invoice \`${inv.id}\` for **${org.name}** has been resent.`;
        msg += `\n**Amount:** ${formatCurrency(inv.amount_due, inv.currency)}`;
        if (inv.customer_email) msg += `\n**Sent to:** ${inv.customer_email}`;
        if (result.hosted_invoice_url) msg += `\n**Payment link:** ${result.hosted_invoice_url}`;
        return msg;
      }

      // Multiple matches or multiple invoices — list them for the user to choose
      if (orgsWithOpen.length > 0) {
        let msg = `Found open invoices for "${companyName}". Which one should I resend?\n\n`;
        for (const { org, invoices: openInvoices } of orgsWithOpen) {
          msg += `**${org.name}:**\n`;
          for (const inv of openInvoices) {
            const formatted = formatPendingInvoice(inv);
            msg += `  - \`${formatted.id}\` — ${formatted.amount} (${formatted.status})`;
            if (formatted.sent_to !== 'Unknown') msg += ` → ${formatted.sent_to}`;
            msg += '\n';
          }
        }
        msg += `\nCall resend_invoice with the specific invoice_id.`;
        return msg;
      }

      // No open invoices found — check for drafts and explain
      const orgNames = orgResult.rows.map((r: { name: string }) => r.name).join(', ');
      const noStripe = orgResult.rows.filter((r: { stripe_customer_id: string | null }) => !r.stripe_customer_id);
      let msg = `❌ No open invoices found for "${companyName}".`;
      if (noStripe.length === orgResult.rows.length) {
        msg += `\n\nNote: None of the matching organizations (${orgNames}) have a Stripe customer linked.`;
      } else if (noStripe.length > 0) {
        msg += `\n\nNote: Some of the matching organizations (${orgNames}) have no Stripe customer linked.`;
      }

      // Report any draft invoices from the cached results
      for (const org of orgResult.rows) {
        const invoices = invoicesByOrg.get(org.workos_organization_id) || [];
        const draftInvoices = invoices.filter(inv => inv.status === 'draft');
        if (draftInvoices.length > 0) {
          msg += `\n\n**${org.name}** has ${draftInvoices.length} draft invoice(s) that haven't been sent yet:`;
          for (const inv of draftInvoices) {
            msg += `\n- \`${inv.id}\` — ${formatCurrency(inv.amount_due, inv.currency)} (draft)`;
          }
          msg += `\n\nDraft invoices need to be finalized in Stripe before they can be resent.`;
        }
      }

      return msg;
    }

    return '❌ Please provide either an invoice_id (e.g., in_...) or a company_name to look up.';
  });

  // Update billing email on a Stripe customer
  handlers.set('update_billing_email', async (input) => {
    const orgId = input.org_id as string | undefined;
    const directCustomerId = input.customer_id as string | undefined;
    const email = input.email as string;

    if (!email) {
      return '❌ Email is required.';
    }

    let customerId = directCustomerId;

    if (customerId && !customerId.startsWith('cus_')) {
      return '❌ A valid Stripe customer ID (starting with cus_) is required.';
    }

    // Look up Stripe customer from org if needed
    if (!customerId && orgId) {
      const org = await orgDb.getOrganization(orgId);
      if (!org) {
        return `❌ Organization ${orgId} not found.`;
      }
      if (!org.stripe_customer_id) {
        return `❌ Organization "${org.name}" has no Stripe customer linked.`;
      }
      customerId = org.stripe_customer_id;
    }

    if (!customerId) {
      return '❌ Either org_id or customer_id is required.';
    }

    logger.info({ customerId, email }, 'Addie: Admin updating billing email');

    const result = await updateCustomerEmail(customerId, email);
    if (!result.success) {
      return `❌ Could not update email: ${result.error}`;
    }

    return `✅ Billing email for customer ${customerId} updated to ${email}. Future invoices will be sent to this address.`;
  });

  // Shared handler for get_account and get_organization_details
  const getAccountHandler = async (input: Record<string, unknown>) => {

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
        slackOnlyUsersResult,
        slackActivityResult,
        workingGroupsResult,
        activitiesResult,
        engagementSignals,
        pendingInvoicesResult,
        subscriptionHistoryResult,
      ] = await Promise.all([
        // Slack users count for this org (mapped members)
        pool.query(
          `SELECT COUNT(DISTINCT sm.slack_user_id) as slack_user_count
           FROM slack_user_mappings sm
           JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
           WHERE om.workos_organization_id = $1
             AND sm.mapping_status = 'mapped'`,
          [orgId]
        ),
        // Slack-only users (discovered via domain but not signed up)
        pool.query(
          `SELECT COUNT(*) as count
           FROM slack_user_mappings
           WHERE pending_organization_id = $1
             AND mapping_status = 'unmapped'
             AND workos_user_id IS NULL
             AND slack_is_bot = false
             AND slack_is_deleted = false`,
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
        // Subscription history (cancellations, renewals, signups)
        pool.query(
          `SELECT activity_type, description, activity_date, logged_by_name
           FROM org_activities
           WHERE organization_id = $1
             AND activity_type IN ('subscription', 'subscription_cancelled', 'payment')
           ORDER BY activity_date DESC
           LIMIT 10`,
          [orgId]
        ),
      ]);

      const slackUserCount = parseInt(slackUsersResult.rows[0]?.slack_user_count || '0');
      const slackOnlyCount = parseInt(slackOnlyUsersResult.rows[0]?.count || '0');
      const totalSlackUsers = slackUserCount + slackOnlyCount;
      const slackActivity = slackActivityResult.rows[0] || { active_users: 0, messages: 0, reactions: 0, thread_replies: 0 };
      const workingGroups = workingGroupsResult.rows;
      const recentActivities = activitiesResult.rows;
      const pendingInvoices = pendingInvoicesResult;
      const subscriptionHistory = subscriptionHistoryResult.rows;

      // Build comprehensive response
      let response = `## ${org.name}\n\n`;

      // Lifecycle stage - the unified view (prominently displayed at top)
      response += `**Lifecycle Stage:** ${LIFECYCLE_STAGE_EMOJI[lifecycleStage]} **${lifecycleStage.charAt(0).toUpperCase() + lifecycleStage.slice(1)}**\n`;

      // Basic info
      if (org.company_type) response += `**Type:** ${org.company_type}\n`;
      if (org.email_domain) response += `**Domain:** ${org.email_domain}\n`;
      if (org.parent_name) response += `**Parent:** ${org.parent_name}\n`;
      const displayTier = org.membership_tier
        || inferMembershipTier(org.subscription_amount, org.subscription_interval, org.is_personal);
      if (displayTier) {
        const inferred = !org.membership_tier ? ' _(inferred from amount)_' : '';
        response += `**Membership Tier:** ${formatMembershipTier(displayTier)}${inferred}\n`;
      }
      if (org.revenue_tier) response += `**Revenue Tier:** ${formatRevenueTier(org.revenue_tier)}\n`;
      response += `**ID:** ${orgId}\n`;
      if (org.stripe_customer_id) response += `**Stripe Customer:** \`${org.stripe_customer_id}\`\n`;
      response += '\n';

      // Membership details (if member or has subscription history)
      if (lifecycleStage === 'member' || lifecycleStage === 'churned' || org.subscription_status) {
        response += `### Membership\n`;
        if (org.subscription_status === 'active') {
          response += `**Status:** Active - ${org.subscription_product_name || 'Subscription'}\n`;
          if (org.subscription_amount) {
            const amount = formatCurrency(org.subscription_amount);
            const interval = org.subscription_interval === 'month' ? '/mo' : org.subscription_interval === 'year' ? '/yr' : '';
            response += `**Amount:** ${amount}${interval}\n`;
          }
          if (org.subscription_current_period_end) {
            response += `**Renews:** ${formatDate(new Date(org.subscription_current_period_end))}\n`;
          }
          if (org.subscription_canceled_at) {
            response += `**Cancels at period end:** Yes (canceled ${formatDate(new Date(org.subscription_canceled_at))})\n`;
          }
        } else if (org.subscription_status === 'canceled') {
          response += `**Status:** Canceled\n`;
          if (org.subscription_canceled_at) {
            response += `**Canceled:** ${formatDate(new Date(org.subscription_canceled_at))}\n`;
          }
          if (org.subscription_current_period_end) {
            response += `**Access until:** ${formatDate(new Date(org.subscription_current_period_end))}\n`;
          }
        } else if (org.subscription_status === 'past_due') {
          response += `**Status:** Past due - payment needed\n`;
        }

        // Subscription history from org_activities
        if (subscriptionHistory.length > 0) {
          response += `**Subscription history:**\n`;
          for (const event of subscriptionHistory) {
            const date = formatDate(new Date(event.activity_date));
            response += `  - ${date}: ${event.description || event.activity_type}`;
            if (event.logged_by_name) response += ` (${event.logged_by_name})`;
            response += '\n';
          }
        }

        response += renderPendingInvoiceSection(pendingInvoices);

        // Discount info
        if (org.discount_percent || org.discount_amount_cents) {
          const discount = org.discount_percent
            ? `${org.discount_percent}% off`
            : `${formatCurrency(org.discount_amount_cents!)} off`;
          response += `**Discount:** ${discount}`;
          if (org.stripe_promotion_code) response += ` (code: ${org.stripe_promotion_code})`;
          response += '\n';
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
        response += renderPendingInvoiceSection(pendingInvoices);
        response += '\n';
      }

      // Slack presence
      response += `### Slack Presence\n`;
      response += `**Total in Slack:** ${totalSlackUsers}`;
      if (totalSlackUsers > 0 && (slackUserCount > 0 || slackOnlyCount > 0)) {
        response += ` (${slackUserCount} members`;
        if (slackOnlyCount > 0) {
          response += `, ${slackOnlyCount} Slack-only`;
        }
        response += `)`;
      }
      response += `\n`;
      if (slackActivity.active_users > 0) {
        response += `**Active (30d):** ${slackActivity.active_users} users\n`;
        response += `**Messages (30d):** ${slackActivity.messages || 0}\n`;
        response += `**Reactions (30d):** ${slackActivity.reactions || 0}\n`;
      } else if (totalSlackUsers > 0) {
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

      // Recent activities (excluding subscription events shown in Membership section)
      const SUBSCRIPTION_ACTIVITY_TYPES = new Set(['subscription', 'subscription_cancelled', 'payment']);
      const nonSubscriptionActivities = recentActivities.filter(
        (a: { activity_type: string }) => !SUBSCRIPTION_ACTIVITY_TYPES.has(a.activity_type)
      );
      if (nonSubscriptionActivities.length > 0) {
        response += `### Recent Activity\n`;
        for (const activity of nonSubscriptionActivities) {
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

  // ============================================
  // PROSPECT MANAGEMENT HANDLERS
  // ============================================

  // Add prospect
  handlers.set('add_prospect', async (input) => {

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

  // Update prospect
  handlers.set('update_prospect', async (input) => {

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
      stripe_customer_id?: string;
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
              enrichment_employee_count, enrichment_revenue, stripe_customer_id,
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
                enrichment_employee_count, enrichment_revenue, stripe_customer_id,
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

        // Ensure a Stripe customer exists with org metadata before creating the
        // checkout session. Without this, Stripe creates a new customer during
        // checkout that has no workos_organization_id metadata, so the subscription
        // webhook can't link the payment back to the organization.
        let customerId: string | undefined;
        if (emailToUse) {
          customerId = await orgDb.getOrCreateStripeCustomer(org.workos_organization_id, () =>
            createStripeCustomer({
              email: emailToUse,
              name: org.name,
              metadata: { workos_organization_id: org.workos_organization_id },
            })
          ) || undefined;
        } else {
          customerId = org.stripe_customer_id;
        }

        const session = await createCheckoutSession({
          priceId: finalProduct.price_id,
          customerId: customerId || undefined,
          customerEmail: customerId ? undefined : (emailToUse || undefined),
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

    // Draft invoice - prepare and show for review (TWO-STEP PROCESS: Step 1)
    if (action === 'draft_invoice') {
      if (!finalProduct) {
        return response + `\n❌ No membership products available. Please check Stripe configuration.`;
      }

      // Determine what discount would be applied
      let appliedDiscount: string | undefined;
      let finalAmount = finalProduct.amount_cents || 0;

      // Check if a new discount is being requested
      if (discountPercent !== undefined || discountAmountDollars !== undefined) {
        if (!discountReason) {
          return response + `\n❌ Please provide a discount_reason when applying a discount.`;
        }
        appliedDiscount = discountPercent ? `${discountPercent}% off` : `$${discountAmountDollars} off`;
        if (discountPercent) {
          finalAmount = Math.round(finalAmount * (1 - discountPercent / 100));
        } else if (discountAmountDollars) {
          finalAmount = Math.max(0, finalAmount - (discountAmountDollars * 100));
        }
      } else if (useExistingDiscount && (org.discount_percent || org.discount_amount_cents)) {
        // Use existing org discount
        appliedDiscount = org.discount_percent
          ? `${org.discount_percent}% off`
          : `$${(org.discount_amount_cents || 0) / 100} off`;
        if (org.discount_percent) {
          finalAmount = Math.round(finalAmount * (1 - org.discount_percent / 100));
        } else if (org.discount_amount_cents) {
          finalAmount = Math.max(0, finalAmount - org.discount_amount_cents);
        }
      }

      response += `### 📋 Draft Invoice for Review\n\n`;
      response += `---\n\n`;

      // Company info
      response += `**Company:** ${org.name}\n`;
      if (org.revenue_tier) {
        const tierLabels: Record<string, string> = {
          'under_1m': 'Under $1M',
          '1m_5m': '$1M-$5M',
          '5m_50m': '$5M-$50M',
          '50m_250m': '$50M-$250M',
          '250m_1b': '$250M-$1B',
          '1b_plus': 'Over $1B'
        };
        response += `**Revenue Tier:** ${tierLabels[org.revenue_tier] || org.revenue_tier}\n`;
      }

      // Contact info
      response += `\n**Contact:** ${org.prospect_contact_name || contactName || '_Not set_'}\n`;
      response += `**Email:** ${emailToUse || '_Not set - required for invoice_'}\n`;

      // Billing address
      response += `\n**Billing Address:**\n`;
      if (billingAddress?.line1) {
        response += `${billingAddress.line1}\n`;
        if (billingAddress.line2) response += `${billingAddress.line2}\n`;
        response += `${billingAddress.city || ''}, ${billingAddress.state || ''} ${billingAddress.postal_code || ''}\n`;
        response += `${billingAddress.country || 'US'}\n`;
      } else {
        response += `_Not provided - required for invoice_\n`;
      }

      // Product and pricing
      response += `\n---\n\n`;
      response += `**Product:** ${finalProduct.display_name}\n`;
      if (finalProduct.amount_cents) {
        const listPrice = finalProduct.amount_cents / 100;
        const netPrice = finalAmount / 100;
        if (appliedDiscount) {
          response += `**List Price:** ~~$${listPrice.toLocaleString()}~~/year\n`;
          response += `**Discount:** ${appliedDiscount}`;
          if (org.discount_percent || org.discount_amount_cents) {
            response += ` (existing org discount)`;
          }
          response += `\n`;
          response += `**Invoice Amount:** **$${netPrice.toLocaleString()}**/year\n`;
        } else {
          response += `**Invoice Amount:** $${listPrice.toLocaleString()}/year\n`;
        }
      }
      response += `**Payment Terms:** NET 30\n`;

      // What's missing
      const missingFields: string[] = [];
      if (!emailToUse) missingFields.push('contact_email');
      if (!billingAddress?.line1) missingFields.push('billing_address');

      if (missingFields.length > 0) {
        response += `\n---\n\n`;
        response += `⚠️ **Missing required fields:** ${missingFields.join(', ')}\n`;
        response += `\n_Please provide these fields to proceed._\n`;
      } else {
        response += `\n---\n\n`;
        response += `✅ **Ready to send!**\n\n`;
        response += `To send this invoice, confirm with the admin then call this tool again with:\n`;
        response += `- \`action: "send_invoice"\`\n`;
        response += `- Same company_name and all other parameters\n`;
        response += `\nOr if changes are needed, ask the admin what to modify.\n`;
      }

      logger.info(
        { orgId: org.workos_organization_id, orgName: org.name, product: finalProduct.lookup_key, discount: appliedDiscount },
        'Addie prepared draft invoice'
      );

      return response;
    }

    // Send invoice - actually send after review (TWO-STEP PROCESS: Step 2)
    // Also support legacy 'invoice' action for backward compatibility
    if (action === 'send_invoice' || action === 'invoice') {
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
          if (appliedDiscount && invoiceResult.discountApplied) {
            // Calculate discounted amount for display
            let discountedAmount = originalAmount;
            if (discountPercent) {
              discountedAmount = originalAmount * (1 - discountPercent / 100);
            } else if (discountAmountDollars) {
              discountedAmount = originalAmount - discountAmountDollars;
            } else if (org.discount_percent) {
              discountedAmount = originalAmount * (1 - org.discount_percent / 100);
            } else if (org.discount_amount_cents) {
              discountedAmount = originalAmount - (org.discount_amount_cents / 100);
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

        // Warn if discount was requested but not applied
        if (invoiceResult.discountWarning) {
          response += `\n\n⚠️ **Warning:** ${invoiceResult.discountWarning}`;
        }

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

    return response + `\n❌ Unknown action: ${action}. Use "payment_link", "draft_invoice", "send_invoice", or "lookup_only".`;
  });

  // Search Lusha for prospects
  handlers.set('prospect_search_lusha', async (input) => {

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

      // Check if already a leader (use canonical_user_id for Slack/WorkOS resolution)
      const leaders = await wgDb.getLeaders(committee.id);
      if (leaders.some((l) => l.canonical_user_id === userId)) {
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
        invalidateWebAdminStatusCache(userId);
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

      // Check if they are a leader (use canonical_user_id for Slack/WorkOS resolution)
      const leaders = await wgDb.getLeaders(committee.id);
      if (!leaders.some((l) => l.canonical_user_id === userId)) {
        return `ℹ️ User ${userId} is not a leader of "${committee.name}".`;
      }

      await wgDb.removeLeader(committee.id, userId);
      invalidateWebAdminStatusCache(userId);

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

  // Rename a working group / chapter / committee
  handlers.set('rename_working_group', async (input) => {
    const slug = input.working_group_slug as string;
    const newName = input.new_name as string;
    const newSlug = input.new_slug as string | undefined;

    if (!slug || !newName) {
      return '❌ Both working_group_slug and new_name are required.';
    }

    try {
      const wg = await wgDb.getWorkingGroupBySlug(slug);
      if (!wg) {
        return `❌ Working group with slug "${slug}" not found.`;
      }

      const generatedSlug = newSlug || newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      if (!generatedSlug) {
        return '❌ Could not generate a valid slug from that name. Please provide a new_slug explicitly.';
      }

      await wgDb.updateWorkingGroup(wg.id, {
        name: newName,
        slug: generatedSlug,
      });

      logger.info({ oldSlug: slug, newSlug: generatedSlug, newName }, 'Addie: Admin renamed working group');

      return `✅ Renamed "${wg.name}" → "${newName}"\n\nSlug: ${slug} → ${generatedSlug}\nType: ${wg.committee_type}`;
    } catch (error) {
      logger.error({ error, slug, newName }, 'Addie: Error renaming working group');
      return '❌ Failed to rename working group. Please try again.';
    }
  });

  // Merge organizations
  handlers.set('merge_organizations', async (input) => {

    const primaryOrgId = input.primary_org_id as string;
    const secondaryOrgId = input.secondary_org_id as string;
    const preview = input.preview !== false; // Default to preview mode for safety
    const stripeCustomerResolution = input.stripe_customer_resolution as StripeCustomerResolution | undefined;

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

        // Stripe customer conflict section
        const stripeConflict = previewResult.stripe_customer_conflict;
        if (stripeConflict.has_conflict) {
          response += `\n### 🔴 Stripe Customer Conflict\n`;
          response += `Both organizations have Stripe customers that need resolution:\n`;
          response += `- **Primary:** ${stripeConflict.primary_customer_id}\n`;
          response += `- **Secondary:** ${stripeConflict.secondary_customer_id}\n\n`;
          response += `You must specify \`stripe_customer_resolution\` to proceed:\n`;
          response += `- \`keep_primary\`: Keep primary's Stripe customer, orphan secondary's\n`;
          response += `- \`use_secondary\`: Replace primary's customer with secondary's\n`;
          response += `- \`keep_both_unlinked\`: Unlink both for manual resolution\n`;
        } else if (stripeConflict.secondary_customer_id && !stripeConflict.primary_customer_id) {
          response += `\n### Stripe\n`;
          response += `Secondary org's Stripe customer (${stripeConflict.secondary_customer_id}) will be moved to primary org.\n`;
        } else if (stripeConflict.primary_customer_id) {
          response += `\n### Stripe\n`;
          response += `Primary org's Stripe customer (${stripeConflict.primary_customer_id}) will be kept.\n`;
        }

        if (previewResult.warnings.length > 0) {
          response += `\n### Warnings\n`;
          for (const warning of previewResult.warnings) {
            response += `⚠️ ${warning}\n`;
          }
        }

        response += `\n---\n`;
        if (stripeConflict.requires_resolution) {
          response += `_This is a preview. To execute the merge, call merge_organizations with preview=false and stripe_customer_resolution set._`;
        } else {
          response += `_This is a preview. To execute the merge, call merge_organizations again with preview=false._`;
        }

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
        const result = await mergeOrganizations(
          primaryOrgId,
          secondaryOrgId,
          mergedBy,
          workos,
          stripeCustomerResolution ? { stripeCustomerResolution } : undefined
        );

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

        // Stripe customer action
        if (result.stripe_customer_action && result.stripe_customer_action !== 'none') {
          response += `\n### Stripe\n`;
          switch (result.stripe_customer_action) {
            case 'kept_primary':
              response += `- ✅ Kept primary org's Stripe customer\n`;
              break;
            case 'moved_from_secondary':
              response += `- 🔄 Moved Stripe customer from secondary to primary org\n`;
              break;
            case 'conflict_unresolved':
              response += `- ⚠️ Both Stripe customers were unlinked - manual linking required\n`;
              break;
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

  // Update organization member role
  handlers.set('update_org_member_role', async (input) => {

    const orgId = (input.org_id as string)?.trim();
    const userId = (input.user_id as string)?.trim();
    const role = (input.role as string)?.trim().toLowerCase();

    if (!orgId) {
      return '❌ org_id is required. Use get_account to find the organization ID (starts with org_).';
    }
    if (!userId) {
      return '❌ user_id is required. This is the WorkOS user ID (starts with user_).';
    }
    if (!role || !['member', 'admin', 'owner'].includes(role)) {
      return '❌ role must be "member", "admin", or "owner".';
    }

    if (!workos) {
      return '❌ WorkOS is not configured.';
    }

    const pool = getPool();

    try {
      // Get org name for response
      const orgResult = await pool.query(
        `SELECT name FROM organizations WHERE workos_organization_id = $1`,
        [orgId]
      );
      const orgName = orgResult.rows[0]?.name || orgId;

      // Get user info for response
      const userResult = await pool.query(
        `SELECT email, first_name, last_name FROM organization_memberships WHERE workos_user_id = $1 AND workos_organization_id = $2`,
        [userId, orgId]
      );

      if (userResult.rows.length === 0) {
        return `❌ User ${userId} is not a member of organization ${orgName}. They must join the organization first.`;
      }

      const user = userResult.rows[0];
      const userName = user.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : user.email;

      // Get the membership ID from WorkOS
      const memberships = await workos.userManagement.listOrganizationMemberships({
        organizationId: orgId,
        userId: userId,
      });

      if (memberships.data.length === 0) {
        return `❌ No WorkOS membership found for user ${userId} in organization ${orgId}.`;
      }

      const membership = memberships.data[0];
      const currentRole = membership.role?.slug || 'member';

      if (currentRole === role) {
        return `ℹ️ ${userName} already has the ${role} role in ${orgName}. No change needed.`;
      }

      // Update the role in WorkOS
      await workos.userManagement.updateOrganizationMembership(membership.id, {
        roleSlug: role,
      });

      // Update local cache
      await pool.query(
        `UPDATE organization_memberships
         SET role = $1, updated_at = NOW()
         WHERE workos_organization_id = $2 AND workos_user_id = $3`,
        [role, orgId, userId]
      );

      logger.info({ orgId, userId, oldRole: currentRole, newRole: role }, 'Addie: Updated org member role');

      let response = `✅ Updated ${userName}'s role from **${currentRole}** to **${role}** in ${orgName}.\n\n`;
      if (role === 'owner') {
        response += `They now have full ownership of the organization, including:\n- Invite and manage team members\n- View and manage organization billing\n- Update organization profile`;
      } else if (role === 'admin') {
        response += `They can now:\n- Invite and manage team members\n- View organization billing\n- Update organization profile`;
      }
      return response;
    } catch (error) {
      logger.error({ error, orgId, userId, role }, 'Error updating org member role');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Failed to update role: ${errorMessage}`;
    }
  });

  // Check domain health
  handlers.set('check_domain_health', async (input) => {

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
  // MEMBER INSIGHT SUMMARY HANDLERS
  // ============================================

  // Get insight summary
  handlers.set('get_insight_summary', async (input) => {

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

  // ============================================
  // ORGANIZATION ANALYTICS HANDLERS
  // ============================================
  handlers.set('list_organizations_by_users', async (input) => {

    try {
      const pool = getPool();
      const limit = Math.min(Math.max((input.limit as number) || 20, 1), 100);
      const validMemberStatuses = ['all', 'member', 'churned', 'prospect'];
      const rawMemberStatus = (input.member_status as string) || 'all';
      const memberStatus = validMemberStatuses.includes(rawMemberStatus) ? rawMemberStatus : 'all';
      const minUsers = Math.max((input.min_users as number) || 1, 0);

      // Query organizations with user counts (members + Slack-only users)
      const result = await pool.query<{
        workos_organization_id: string;
        name: string;
        member_count: number;
        slack_only_count: number;
        total_user_count: number;
        active_users_30d: number;
        messages_30d: number;
        subscription_status: string | null;
        member_status: string;
      }>(`
        WITH member_counts AS (
          SELECT workos_organization_id, COUNT(*) as count
          FROM organization_memberships
          GROUP BY workos_organization_id
        ),
        slack_only_counts AS (
          SELECT pending_organization_id as workos_organization_id, COUNT(*) as count
          FROM slack_user_mappings
          WHERE pending_organization_id IS NOT NULL
            AND mapping_status = 'unmapped'
            AND workos_user_id IS NULL
            AND slack_is_bot = false
            AND slack_is_deleted = false
          GROUP BY pending_organization_id
        ),
        slack_activity AS (
          SELECT
            organization_id,
            COUNT(DISTINCT slack_user_id) as active_users,
            SUM(message_count) as messages
          FROM slack_activity_daily
          WHERE activity_date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY organization_id
        )
        SELECT
          o.workos_organization_id,
          o.name,
          COALESCE(mc.count, 0)::int as member_count,
          COALESCE(soc.count, 0)::int as slack_only_count,
          (COALESCE(mc.count, 0) + COALESCE(soc.count, 0))::int as total_user_count,
          COALESCE(sa.active_users, 0)::int as active_users_30d,
          COALESCE(sa.messages, 0)::int as messages_30d,
          o.subscription_status,
          CASE
            WHEN o.subscription_status = 'active' THEN 'member'
            WHEN o.subscription_status IN ('canceled', 'past_due') THEN 'churned'
            ELSE 'prospect'
          END as member_status
        FROM organizations o
        LEFT JOIN member_counts mc ON mc.workos_organization_id = o.workos_organization_id
        LEFT JOIN slack_only_counts soc ON soc.workos_organization_id = o.workos_organization_id
        LEFT JOIN slack_activity sa ON sa.organization_id = o.workos_organization_id
        WHERE (COALESCE(mc.count, 0) + COALESCE(soc.count, 0)) >= $1
          AND ($2 = 'all' OR
               ($2 = 'member' AND o.subscription_status = 'active') OR
               ($2 = 'churned' AND o.subscription_status IN ('canceled', 'past_due')) OR
               ($2 = 'prospect' AND (o.subscription_status IS NULL OR o.subscription_status NOT IN ('active', 'canceled', 'past_due'))))
        ORDER BY total_user_count DESC, active_users_30d DESC, name ASC
        LIMIT $3
      `, [minUsers, memberStatus, limit]);

      if (result.rows.length === 0) {
        return `No organizations found with ${minUsers}+ users${memberStatus !== 'all' ? ` (filtered by status: ${memberStatus})` : ''}.`;
      }

      // Build response
      let response = `## Organizations by User Count\n\n`;

      if (memberStatus !== 'all') {
        response += `_Filtered to ${memberStatus}s only_\n\n`;
      }

      response += `| Rank | Organization | Total Users | Members | Slack Only | Active (30d) | Status |\n`;
      response += `|------|--------------|-------------|---------|------------|--------------|--------|\n`;

      for (let i = 0; i < result.rows.length; i++) {
        const org = result.rows[i];
        const rank = i + 1;
        const statusEmoji = org.member_status === 'member' ? '✅' :
                           org.member_status === 'churned' ? '❌' : '🔄';

        response += `| ${rank} | **${org.name}** | ${org.total_user_count} | ${org.member_count} | ${org.slack_only_count} | ${org.active_users_30d} | ${statusEmoji} ${org.member_status} |\n`;
      }

      response += `\n_Showing top ${result.rows.length} organizations._\n`;
      response += `\n**Legend:**\n`;
      response += `- **Members**: Users with website accounts\n`;
      response += `- **Slack Only**: Users in Slack (discovered via domain) who haven't signed up\n`;
      response += `- **Active (30d)**: Users with Slack activity in last 30 days\n`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing organizations by users');
      return '❌ Failed to list organizations by user count. Please try again.';
    }
  });

  // List paying members grouped by subscription level
  handlers.set('list_paying_members', async (input) => {
    try {
      const pool = getPool();
      const includeIndividual = (input.include_individual as boolean) || false;
      const limit = Math.min(Math.max((input.limit as number) || 50, 1), 100);

      const result = await pool.query(
        `SELECT
          o.name,
          o.is_personal,
          o.subscription_amount,
          o.subscription_currency,
          o.subscription_interval,
          o.subscription_status,
          o.membership_tier,
          o.company_type,
          o.created_at,
          o.subscription_current_period_end
        FROM organizations o
        WHERE o.subscription_status = 'active'
          AND o.subscription_canceled_at IS NULL
          AND ($1 = true OR o.is_personal = false)
        ORDER BY o.subscription_amount DESC NULLS LAST, o.name ASC
        LIMIT $2`,
        [includeIndividual, limit]
      );

      if (result.rows.length === 0) {
        return `No active members found${includeIndividual ? '' : ' (corporate only)'}.`;
      }

      // Group by annual subscription amount level.
      // Subdivides company_standard ($2.5K and $10K) into separate display groups.
      const groups: Record<string, typeof result.rows> = {
        icl: [],
        corporate: [],
        smb: [],
        other: [],
        individual: [],
      };

      for (const org of result.rows) {
        const amount = org.subscription_amount || 0;
        const annualCents = org.subscription_interval === 'month' ? amount * 12 : amount;

        if (org.is_personal) {
          groups.individual.push(org);
        } else if (annualCents >= 5000000) {
          groups.icl.push(org);
        } else if (annualCents >= 1000000) {
          groups.corporate.push(org);
        } else if (annualCents >= 250000) {
          groups.smb.push(org);
        } else {
          groups.other.push(org);
        }
      }

      const formatRow = (org: { name: string; subscription_amount: number | null; subscription_currency: string | null; subscription_interval: string | null; created_at: Date }) => {
        const amount = org.subscription_amount
          ? formatCurrency(org.subscription_amount, org.subscription_currency || 'usd')
          : 'Comped';
        const interval = org.subscription_amount
          ? (org.subscription_interval === 'month' ? '/mo' : org.subscription_interval === 'year' ? '/yr' : '')
          : '';
        const since = formatDate(org.created_at);
        return `- **${org.name}** — ${amount}${interval} (since ${since})\n`;
      };

      let response = `## Active Members\n\n`;
      response += `**${result.rows.length} active member${result.rows.length !== 1 ? 's' : ''}**`;
      if (!includeIndividual) response += ` (corporate only)`;
      response += `\n\n`;

      if (groups.icl.length > 0) {
        response += `### Industry Council Leaders ($50K/yr)\n`;
        for (const org of groups.icl) response += formatRow(org);
        response += `\n`;
      }

      if (groups.corporate.length > 0) {
        response += `### Corporate ($10K/yr)\n`;
        for (const org of groups.corporate) response += formatRow(org);
        response += `\n`;
      }

      if (groups.smb.length > 0) {
        response += `### Startup/SMB ($2.5K/yr)\n`;
        for (const org of groups.smb) response += formatRow(org);
        response += `\n`;
      }

      if (groups.other.length > 0) {
        response += `### Other\n`;
        for (const org of groups.other) response += formatRow(org);
        response += `\n`;
      }

      if (groups.individual.length > 0) {
        response += `### Individual\n`;
        for (const org of groups.individual) response += formatRow(org);
        response += `\n`;
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing members');
      return '❌ Failed to list members. Please try again.';
    }
  });

  // List Slack users for a specific organization
  handlers.set('list_slack_users_by_org', async (input) => {

    try {
      const pool = getPool();
      const query = (input.query as string || '').trim();

      if (!query) {
        return '❌ Please provide a company name or domain to look up.';
      }

      // Find the organization
      // Escape LIKE metacharacters to prevent pattern injection
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      const searchPattern = `%${escapedQuery}%`;
      const orgResult = await pool.query(
        `SELECT workos_organization_id, name, email_domain
         FROM organizations
         WHERE is_personal = false
           AND (LOWER(name) LIKE LOWER($1) OR LOWER(email_domain) LIKE LOWER($1))
         ORDER BY
           CASE WHEN LOWER(name) = LOWER($2) THEN 0
                WHEN LOWER(name) LIKE LOWER($3) THEN 1
                ELSE 2 END
         LIMIT 1`,
        [searchPattern, escapedQuery, `${escapedQuery}%`]
      );

      if (orgResult.rows.length === 0) {
        return `No organization found matching "${query}". Try searching by company name or domain.`;
      }

      const org = orgResult.rows[0];
      const orgId = org.workos_organization_id;

      // Get all Slack users for this org in parallel
      const [mappedUsersResult, slackOnlyUsersResult] = await Promise.all([
        // Mapped members (have website account + Slack)
        pool.query<{
          slack_user_id: string;
          slack_email: string | null;
          slack_display_name: string | null;
          slack_real_name: string | null;
          last_slack_activity_at: Date | null;
          email: string;
          first_name: string | null;
          last_name: string | null;
        }>(`
          SELECT
            sm.slack_user_id,
            sm.slack_email,
            sm.slack_display_name,
            sm.slack_real_name,
            sm.last_slack_activity_at,
            om.email,
            om.first_name,
            om.last_name
          FROM slack_user_mappings sm
          JOIN organization_memberships om ON om.workos_user_id = sm.workos_user_id
          WHERE om.workos_organization_id = $1
            AND sm.mapping_status = 'mapped'
          ORDER BY sm.last_slack_activity_at DESC NULLS LAST, sm.slack_real_name ASC
        `, [orgId]),

        // Slack-only users (discovered via domain)
        pool.query<{
          slack_user_id: string;
          slack_email: string | null;
          slack_display_name: string | null;
          slack_real_name: string | null;
          last_slack_activity_at: Date | null;
        }>(`
          SELECT
            slack_user_id,
            slack_email,
            slack_display_name,
            slack_real_name,
            last_slack_activity_at
          FROM slack_user_mappings
          WHERE pending_organization_id = $1
            AND mapping_status = 'unmapped'
            AND workos_user_id IS NULL
            AND slack_is_bot = false
            AND slack_is_deleted = false
          ORDER BY last_slack_activity_at DESC NULLS LAST, slack_real_name ASC
        `, [orgId]),
      ]);

      const mappedUsers = mappedUsersResult.rows;
      const slackOnlyUsers = slackOnlyUsersResult.rows;
      const totalUsers = mappedUsers.length + slackOnlyUsers.length;

      if (totalUsers === 0) {
        return `## ${org.name}\n\nNo Slack users found for this organization.`;
      }

      let response = `## ${org.name} - Slack Users (${totalUsers} total)\n\n`;

      // Helper to format last activity
      const formatLastActive = (date: Date | null) => {
        if (!date) return 'Never';
        const d = new Date(date);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
        return d.toLocaleDateString();
      };

      // Website members with Slack
      if (mappedUsers.length > 0) {
        response += `### Website Members (${mappedUsers.length})\n`;
        response += `_These users have both a website account and Slack_\n\n`;

        for (const user of mappedUsers) {
          const name = [user.first_name, user.last_name].filter(Boolean).join(' ') ||
                       user.slack_real_name || user.slack_display_name || 'Unknown';
          const lastActive = formatLastActive(user.last_slack_activity_at);
          response += `- **${name}** - ${user.email}`;
          response += ` _(Last active: ${lastActive})_\n`;
        }
        response += '\n';
      }

      // Slack-only users
      if (slackOnlyUsers.length > 0) {
        response += `### Slack Only (${slackOnlyUsers.length})\n`;
        response += `_These users are in Slack but haven't signed up for a website account_\n\n`;

        for (const user of slackOnlyUsers) {
          const name = user.slack_real_name || user.slack_display_name || 'Unknown';
          const lastActive = formatLastActive(user.last_slack_activity_at);
          response += `- **${name}**`;
          if (user.slack_email) response += ` - ${user.slack_email}`;
          response += ` _(Last active: ${lastActive})_\n`;
        }
      }

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing Slack users by org');
      return '❌ Failed to list Slack users. Please try again.';
    }
  });

  // ============================================
  // INSIGHT SYNTHESIS HANDLERS
  // ============================================

  handlers.set('tag_insight', async (input) => {

    try {
      const content = input.content as string;
      if (!content || content.trim().length === 0) {
        return '❌ Content is required. Please provide the text to tag as an insight.';
      }

      const topic = (input.topic as string) || undefined;
      const authorName = (input.author_name as string) || undefined;
      const authorContext = (input.author_context as string) || undefined;
      const notes = (input.notes as string) || undefined;

      const taggedBy = memberContext?.workos_user?.email || memberContext?.slack_user?.email || 'admin';

      // Import AddieDatabase here to avoid circular deps
      const { AddieDatabase } = await import('../../db/addie-db.js');
      const addieDb = new AddieDatabase();

      const source = await addieDb.createInsightSource({
        source_type: 'external',
        content: content.trim(),
        topic,
        author_name: authorName,
        author_context: authorContext,
        tagged_by: taggedBy,
        notes,
      });

      logger.info({
        sourceId: source.id,
        topic,
        taggedBy,
        contentLength: content.length,
      }, 'Insight source tagged via Addie tool');

      let response = `✅ **Insight tagged successfully!**\n\n`;
      response += `- **ID**: ${source.id}\n`;
      if (topic) response += `- **Topic**: ${topic}\n`;
      if (authorName) response += `- **Author**: ${authorName}`;
      if (authorContext) response += ` (${authorContext})`;
      if (authorName) response += `\n`;
      response += `- **Content**: ${source.excerpt}\n`;
      response += `- **Status**: Pending synthesis\n\n`;
      response += `This content will be synthesized into Addie's core knowledge during the next synthesis run. `;
      response += `Use \`run_synthesis\` to process pending insights, or wait for the scheduled run.`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error tagging insight');
      return '❌ Failed to tag insight. Please try again.';
    }
  });

  handlers.set('list_pending_insights', async (input) => {

    try {
      const topic = (input.topic as string) || undefined;
      const limit = Math.min((input.limit as number) || 20, 50);

      const { AddieDatabase } = await import('../../db/addie-db.js');
      const addieDb = new AddieDatabase();

      const sources = await addieDb.getPendingInsightSources(topic, limit);
      const byTopic = await addieDb.getInsightSourcesByTopic();
      const pendingCount = await addieDb.countPendingInsights();

      if (sources.length === 0) {
        return '📭 No pending insights found. Use `tag_insight` to add content for synthesis.';
      }

      let response = `## Pending Insights (${pendingCount} total)\n\n`;

      // Summary by topic
      if (byTopic.length > 0) {
        response += `### By Topic\n`;
        for (const t of byTopic) {
          response += `- **${t.topic}**: ${t.source_count} source(s)\n`;
        }
        response += `\n`;
      }

      // List sources
      response += `### Recent Sources\n`;
      for (const source of sources) {
        const date = new Date(source.tagged_at).toLocaleDateString();
        response += `\n**${source.id}.** `;
        if (source.topic) response += `[${source.topic}] `;
        if (source.author_name) response += `*${source.author_name}* - `;
        response += `${source.excerpt}\n`;
        response += `   Tagged by ${source.tagged_by} on ${date}\n`;
      }

      response += `\n---\nUse \`run_synthesis\` to process these into knowledge rules.`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing pending insights');
      return '❌ Failed to list pending insights. Please try again.';
    }
  });

  handlers.set('run_synthesis', async (input) => {

    try {
      const topic = (input.topic as string) || undefined;

      const { AddieDatabase } = await import('../../db/addie-db.js');
      const { synthesizeInsights } = await import('../jobs/insight-synthesizer.js');
      const addieDb = new AddieDatabase();

      // Check if there are pending sources
      const pendingCount = await addieDb.countPendingInsights(topic);
      if (pendingCount === 0) {
        return `📭 No pending insights${topic ? ` for topic "${topic}"` : ''}. Use \`tag_insight\` to add content first.`;
      }

      const createdBy = memberContext?.workos_user?.email || memberContext?.slack_user?.email || 'admin';

      logger.info({
        topic,
        pendingCount,
        createdBy,
      }, 'Starting insight synthesis via Addie tool');

      const result = await synthesizeInsights(addieDb, {
        topic,
        maxSources: 50,
        previewSampleSize: 20,
        createdBy,
      });

      let response = `## Synthesis Complete\n\n`;
      response += `**Run ID**: ${result.run.id}\n`;
      response += `**Status**: ${result.run.status}\n`;
      response += `**Sources processed**: ${result.run.sources_count}\n`;
      response += `**Topics**: ${result.run.topics_included.join(', ') || 'general'}\n\n`;

      // Proposed rules
      if (result.proposedRules.length > 0) {
        response += `### Proposed Rules (${result.proposedRules.length})\n\n`;
        for (const rule of result.proposedRules) {
          response += `**${rule.name}** (confidence: ${(rule.confidence * 100).toFixed(0)}%)\n`;
          response += `> ${rule.content.substring(0, 200)}${rule.content.length > 200 ? '...' : ''}\n\n`;
        }
      }

      // Preview results
      if (result.preview) {
        const { summary } = result.preview;
        response += `### Impact Preview\n`;
        response += `Tested against ${result.preview.predictions.length} historical interactions:\n`;
        response += `- ✅ Likely improved: ${summary.likely_improved}\n`;
        response += `- ➡️ Unchanged: ${summary.likely_unchanged}\n`;
        response += `- ⚠️ Potentially worse: ${summary.likely_worse}\n`;
        response += `- 📊 Average impact: ${(summary.avg_improvement * 100).toFixed(0)}%\n\n`;
      }

      // Gaps
      if (result.gaps.length > 0) {
        response += `### Gaps Identified\n`;
        response += `Topics that need more source material:\n`;
        for (const gap of result.gaps) {
          response += `- ${gap}\n`;
        }
        response += `\n`;
      }

      response += `---\n`;
      response += `**Next steps**: Review the proposed rules in the admin UI at \`/admin/addie\` and approve or reject the synthesis.\n`;
      response += `Once approved, use the "Apply" button to add these rules to Addie's knowledge.`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error running synthesis');
      const message = error instanceof Error ? error.message : 'Unknown error';
      return `❌ Synthesis failed: ${message}`;
    }
  });

  // ============================================
  // LIST ESCALATIONS
  // ============================================
  handlers.set('list_escalations', async (input) => {

    try {
      const status = (input.status as EscalationStatus) || 'open';
      const category = input.category as string | undefined;
      const limit = (input.limit as number) || 10;

      const escalations = await listEscalations({
        status,
        category: category as 'capability_gap' | 'needs_human_action' | 'complex_request' | 'sensitive_topic' | 'other' | undefined,
        limit,
      });

      if (escalations.length === 0) {
        return `📭 No ${status} escalations found.`;
      }

      const priorityEmoji: Record<string, string> = {
        urgent: '🚨',
        high: '⚠️',
        normal: '',
        low: '',
      };

      let response = `## ${status.charAt(0).toUpperCase() + status.slice(1)} Escalations (${escalations.length})\n\n`;

      for (const esc of escalations) {
        const emoji = priorityEmoji[esc.priority] || '';
        response += `### ${emoji} #${esc.id}: ${esc.summary}\n`;
        response += `**Category**: ${esc.category} | **Priority**: ${esc.priority}\n`;
        if (esc.user_display_name) {
          response += `**User**: ${esc.user_display_name}`;
          if (esc.slack_user_id) {
            response += ` (<@${esc.slack_user_id}>)`;
          }
          response += '\n';
        }
        if (esc.original_request) {
          response += `**Request**: ${esc.original_request.substring(0, 150)}${esc.original_request.length > 150 ? '...' : ''}\n`;
        }
        if (esc.addie_context) {
          response += `**Why escalated**: ${esc.addie_context.substring(0, 150)}${esc.addie_context.length > 150 ? '...' : ''}\n`;
        }
        response += `**Created**: ${new Date(esc.created_at).toLocaleDateString()}\n`;
        response += '\n';
      }

      response += `\n---\nUse \`resolve_escalation\` with the escalation ID to mark as resolved after handling.`;

      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing escalations');
      return '❌ Failed to list escalations.';
    }
  });

  // ============================================
  // RESOLVE ESCALATION
  // ============================================
  handlers.set('resolve_escalation', async (input) => {

    const escalationId = input.escalation_id;
    if (typeof escalationId !== 'number' || !Number.isInteger(escalationId) || escalationId < 1) {
      return '❌ Please provide a valid escalation_id (positive integer).';
    }

    const status = (input.status as 'resolved' | 'wont_do') || 'resolved';
    const resolutionNotes = input.resolution_notes as string | undefined;
    const notifyUser = input.notify_user !== false; // Default to true
    const notificationMessage = input.notification_message as string | undefined;

    try {
      // Get the escalation first
      const escalation = await getEscalation(escalationId);
      if (!escalation) {
        return `❌ Escalation #${escalationId} not found.`;
      }

      if (escalation.status === 'resolved' || escalation.status === 'wont_do') {
        return `ℹ️ Escalation #${escalationId} is already ${escalation.status}.`;
      }

      // Get resolver info
      const resolvedBy = memberContext?.workos_user?.email || memberContext?.slack_user?.email || 'admin';

      // Update status
      const updated = await updateEscalationStatus(escalationId, status, resolvedBy, resolutionNotes);
      if (!updated) {
        return `❌ Failed to update escalation #${escalationId}.`;
      }

      logger.info({ escalationId, status, resolvedBy, notifyUser }, 'Escalation resolved via Addie tool');

      let response = `✅ Escalation #${escalationId} marked as ${status}.`;

      // Notify user if requested and we have their Slack ID
      if (notifyUser && escalation.slack_user_id) {
        const messageText = buildResolutionNotificationMessage(escalation, status, notificationMessage);

        const dmResult = await sendDirectMessage(escalation.slack_user_id, {
          text: messageText,
        });

        if (dmResult.ok) {
          response += `\n📬 Notified user via Slack DM.`;
          logger.info({ escalationId, slackUserId: escalation.slack_user_id }, 'Sent escalation resolution notification');
        } else {
          response += `\n⚠️ Could not notify user (DM failed).`;
          logger.warn({ escalationId, slackUserId: escalation.slack_user_id, error: dmResult.error }, 'Failed to send notification');
        }
      } else if (notifyUser && !escalation.slack_user_id) {
        response += `\nℹ️ No Slack user ID on record - could not send notification.`;
      }

      if (resolutionNotes) {
        response += `\n**Notes**: ${resolutionNotes}`;
      }

      return response;
    } catch (error) {
      logger.error({ error, escalationId }, 'Error resolving escalation');
      return `❌ Failed to resolve escalation #${escalationId}.`;
    }
  });

  // ============================================
  // BAN MANAGEMENT HANDLERS
  // ============================================

  handlers.set('ban_entity', async (input) => {
    try {
      const { bansDb: bDb } = await import('../../db/bans-db.js');
      const banType = input.ban_type as string;
      const entityId = input.entity_id as string;
      const scope = input.scope as string;
      const scopeTarget = input.scope_target as string | undefined;
      const reason = input.reason as string;
      const expiresInDays = input.expires_in_days as number | undefined;

      const validBanTypes = ['user', 'organization', 'api_key'];
      const validScopes = ['platform', 'registry_brand', 'registry_property'];
      if (!validBanTypes.includes(banType)) {
        return `Invalid ban_type. Must be one of: ${validBanTypes.join(', ')}`;
      }
      if (!validScopes.includes(scope)) {
        return `Invalid scope. Must be one of: ${validScopes.join(', ')}`;
      }

      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const adminUserId = memberContext?.workos_user?.workos_user_id || 'system:addie';
      const adminEmail = memberContext?.workos_user?.email || 'addie@agenticadvertising.org';

      const ban = await bDb.createBan({
        ban_type: banType as any,
        entity_id: entityId,
        scope: scope as any,
        scope_target: scopeTarget?.toLowerCase(),
        banned_by_user_id: adminUserId,
        banned_by_email: adminEmail,
        reason,
        expires_at: expiresAt,
      });

      const scopeLabel = scope === 'platform' ? 'platform-wide' : scope.replace('registry_', '') + ' registry edits';
      let response = `**Ban created** (ID: \`${ban.id}\`)\n`;
      response += `- **Type**: ${banType}\n`;
      response += `- **Entity**: \`${entityId}\`\n`;
      response += `- **Scope**: ${scopeLabel}`;
      if (scopeTarget) response += ` (domain: ${scopeTarget})`;
      response += `\n- **Reason**: ${reason}\n`;
      if (expiresAt) response += `- **Expires**: ${expiresAt.toISOString()}\n`;
      else response += `- **Duration**: Permanent\n`;

      return response;
    } catch (error: any) {
      if (error?.constraint) {
        return `❌ A ban already exists for this entity/scope combination.`;
      }
      logger.error({ error }, 'Error creating ban');
      return `❌ Failed to create ban: ${error?.message || 'Unknown error'}`;
    }
  });

  handlers.set('unban_entity', async (input) => {
    try {
      const { bansDb: bDb } = await import('../../db/bans-db.js');
      const banId = input.ban_id as string | undefined;
      const banType = input.ban_type as string | undefined;
      const entityId = input.entity_id as string | undefined;
      const scope = input.scope as string | undefined;

      if (banId) {
        const removed = await bDb.removeBan(banId);
        if (!removed) return `No ban found with ID \`${banId}\`.`;
        return `**Ban removed** (ID: \`${banId}\`, ${removed.ban_type} ${removed.scope})`;
      }

      if (banType && entityId) {
        const bans = await bDb.listBans({
          ban_type: banType as any,
          entity_id: entityId,
          scope: scope as any,
        });

        if (bans.length === 0) return `❌ No active ban found for ${banType} \`${entityId}\`${scope ? ` with scope ${scope}` : ''}.`;

        let response = '';
        for (const ban of bans) {
          await bDb.removeBan(ban.id);
          response += `**Removed**: \`${ban.id}\` (${ban.scope}, reason: ${ban.reason})\n`;
        }
        return response;
      }

      return `❌ Provide either ban_id, or ban_type + entity_id to find the ban.`;
    } catch (error) {
      logger.error({ error }, 'Error removing ban');
      return `❌ Failed to remove ban.`;
    }
  });

  handlers.set('list_bans', async (input) => {
    try {
      const { bansDb: bDb } = await import('../../db/bans-db.js');
      const bans = await bDb.listBans({
        ban_type: input.ban_type as any,
        scope: input.scope as any,
        entity_id: input.entity_id as string | undefined,
      });

      if (bans.length === 0) return 'No active bans found.';

      let response = `**Active bans** (${bans.length}):\n\n`;
      for (const ban of bans) {
        const scopeLabel = ban.scope === 'platform' ? 'Platform' : ban.scope.replace('registry_', '').charAt(0).toUpperCase() + ban.scope.replace('registry_', '').slice(1) + ' registry';
        response += `- **\`${ban.id}\`** — ${ban.ban_type} \`${ban.entity_id}\`\n`;
        response += `  Scope: ${scopeLabel}${ban.scope_target ? ` (${ban.scope_target})` : ''}\n`;
        response += `  Reason: ${ban.reason}\n`;
        if (ban.expires_at) response += `  Expires: ${new Date(ban.expires_at).toISOString()}\n`;
        response += `  Created: ${new Date(ban.created_at).toISOString()} by ${ban.banned_by_email || ban.banned_by_user_id}\n\n`;
      }
      return response;
    } catch (error) {
      logger.error({ error }, 'Error listing bans');
      return `❌ Failed to list bans.`;
    }
  });

  return handlers;
}
