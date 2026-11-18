// ADMIN_TOOLS: the tool definitions of admin-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import { COMPANY_TYPE_VALUES } from '../../config/company-types.js';
import { VALID_MEMBER_OFFERINGS } from '../../types.js';
import { ADMIN_ANALYTICS_TOOL } from './admin-analytics.js';
import type { AddieTool } from '../types.js';

/**
 * Admin tool definitions - includes both billing/invoice tools and prospect management tools
 */
export const ADMIN_TOOLS: AddieTool[] = [
  // ============================================
  // BILLING & INVOICE TOOLS
  // ============================================
  {
    name: "list_pending_invoices",
    description: `List all organizations with pending (unpaid) invoices.
Use this when an admin asks about outstanding invoices or payment status across organizations.
Returns a list of organizations with open or draft invoices.`,
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 10)",
        },
      },
    },
  },
  {
    name: "get_account",
    description:
      "Get complete account view for any organization: lifecycle stage, membership status, engagement metrics, pipeline info, and enrichment data. Use for any company lookup. If no org matches, falls back to the users table — surfaces people who signed up with a matching email domain but have not yet created/joined an org (typical for inbound website signups).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            'Company name or domain to look up (e.g., "Mediaocean" or "mediaocean.com")',
        },
      },
      required: ["query"],
    },
  },

  {
    name: "resend_invoice",
    description: `Resend an open invoice. Provide EITHER an invoice_id (if known) OR a company_name to look up their pending invoices. If the company has exactly one open invoice, it will be resent automatically. If the invoice needs to go to a different email, use update_billing_email first.`,
    usage_hints:
      "Pass company_name to look up and resend in one step. Use update_billing_email first if the email needs to change.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoice_id: {
          type: "string",
          description:
            "Stripe invoice ID (starts with in_) — if you already have it",
        },
        company_name: {
          type: "string",
          description:
            "Company name to look up (will find their open invoices)",
        },
      },
    },
  },
  {
    name: "update_billing_email",
    description: `Update the billing email on a Stripe customer. Use this when invoices need to go to a different email address (e.g., accounts payable). Can look up by org_id or direct customer_id.`,
    usage_hints:
      "Use before resend_invoice if the email needs to change. Get org_id from get_account.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description:
            "WorkOS organization ID (org_...) — will look up Stripe customer",
        },
        customer_id: {
          type: "string",
          description:
            "Direct Stripe customer ID (cus_...) — use if org_id is not available",
        },
        email: {
          type: "string",
          description: "New billing email address",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "preview_org_stripe_customer_update",
    description: `Preview relinking an organization to a different Stripe customer. This validates the org and Stripe customer, shows the current and proposed customer IDs, and returns a preview_token. It does not write any changes. Always show the preview to the admin before confirming.`,
    usage_hints:
      "Use get_account first to identify org_id. After the admin explicitly approves the preview, call confirm_org_stripe_customer_update with the preview_token, confirm: true, and an audit reason.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_...) to relink",
        },
        new_customer_id: {
          type: "string",
          pattern: "^cus_",
          description: "Proposed Stripe customer ID (cus_...) to validate",
        },
      },
      required: ["org_id", "new_customer_id"],
    },
  },
  {
    name: "confirm_org_stripe_customer_update",
    description: `Confirm a previously previewed organization Stripe customer relink. This tool does not accept a raw Stripe customer ID; it only commits the validated preview_token after explicit admin approval.`,
    usage_hints:
      "Only call after preview_org_stripe_customer_update has shown the current vs proposed customer diff and the admin has explicitly approved it.",
    input_schema: {
      type: "object" as const,
      properties: {
        preview_token: {
          type: "string",
          description:
            "Opaque token returned by preview_org_stripe_customer_update",
        },
        confirm: {
          type: "boolean",
          const: true,
          description: "Must be true to commit the relink",
        },
        reason: {
          type: "string",
          minLength: 10,
          description:
            "Audit reason for relinking this organization to the validated Stripe customer",
        },
      },
      required: ["preview_token", "confirm", "reason"],
    },
  },

  // ============================================
  // PROSPECT MANAGEMENT TOOLS
  // ============================================
  {
    name: "add_prospect",
    description:
      "Add a new prospect organization to track. Use get_account first to confirm the company does not exist. Capture as much info as possible: name, domain, contact details, and notes about their interest.",
    usage_hints:
      'Always use get_account first to check if company exists. Include champion info in notes (e.g., "Champion: Jane Doe, VP Sales").',
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Company name" },
        company_type: {
          type: "string",
          enum: COMPANY_TYPE_VALUES,
          description: "Type of company",
        },
        domain: {
          type: "string",
          description: "Company domain (for enrichment/dedup)",
        },
        contact_name: { type: "string", description: "Primary contact name" },
        contact_email: { type: "string", description: "Primary contact email" },
        contact_title: {
          type: "string",
          description: "Primary contact job title",
        },
        notes: { type: "string", description: "Notes about the prospect" },
        source: { type: "string", description: "How we found this prospect" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_prospect",
    description:
      "Update information about an existing prospect. Use this to add notes, change status, update contact info, or set interest level. IMPORTANT: When adding notes that indicate excitement, resource commitment, or intent to join, also set interest_level accordingly.",
    input_schema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "Organization ID" },
        company_type: {
          type: "string",
          enum: COMPANY_TYPE_VALUES,
          description: "Type of company",
        },
        status: {
          type: "string",
          enum: [
            "prospect",
            "contacted",
            "responded",
            "interested",
            "negotiating",
            "converted",
            "declined",
            "inactive",
          ],
          description: "Prospect status",
        },
        interest_level: {
          type: "string",
          enum: ["low", "medium", "high", "very_high"],
          description: "Interest level (low/medium/high/very_high)",
        },
        contact_name: { type: "string", description: "Primary contact name" },
        contact_email: { type: "string", description: "Primary contact email" },
        notes: { type: "string", description: "Notes to append" },
        domain: { type: "string", description: "Company domain" },
      },
      required: ["org_id"],
    },
  },
  {
    name: "enrich_company",
    description:
      "Research a company using Lusha to get firmographic data (revenue, employee count, industry, etc.). Can be used with a domain or company name.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Company domain to research" },
        company_name: {
          type: "string",
          description: "Company name (if domain not provided)",
        },
        org_id: {
          type: "string",
          description: "Organization ID to save enrichment to",
        },
      },
      required: [],
    },
  },
  {
    name: "research_domain",
    description:
      "Comprehensive domain research: checks brand registry, enriches via Brandfetch + Sonnet classification + Lusha firmographics. Skips sources that already have fresh data (< 30 days). Returns brand identity, corporate hierarchy (house_domain/parent_brand), and firmographics in one call.",
    input_schema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to research (e.g., mindshare.com)",
        },
        org_id: {
          type: "string",
          description:
            "Organization ID to attach Lusha data to (auto-detected from domain if not provided)",
        },
        skip_brandfetch: {
          type: "boolean",
          description: "Skip Brandfetch/Sonnet enrichment",
        },
        skip_lusha: {
          type: "boolean",
          description: "Skip Lusha firmographic enrichment",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "query_prospects",
    description:
      'Query prospects across different views. Use `view` to switch perspective: "all" (default), "my_engaged", "my_followups", "unassigned", or "addie_pipeline".',
    input_schema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: [
            "all",
            "my_engaged",
            "my_followups",
            "unassigned",
            "addie_pipeline",
          ],
          description: "Which view (default: all)",
        },
        status: {
          type: "string",
          enum: [
            "prospect",
            "contacted",
            "responded",
            "interested",
            "negotiating",
            "converted",
            "declined",
            "inactive",
          ],
          description: "Filter by status (all/addie_pipeline views)",
        },
        company_type: {
          type: "string",
          enum: COMPANY_TYPE_VALUES,
          description: "Filter by company type (all view)",
        },
        limit: { type: "number", description: "Max results (default 10)" },
        sort: {
          type: "string",
          enum: ["recent", "name", "activity"],
          description: "Sort order (all view)",
        },
        hot_only: {
          type: "boolean",
          description: "Only hot prospects with score >= 30 (my_engaged view)",
        },
        days_stale: {
          type: "number",
          description: "Days stale threshold, default 14 (my_followups view)",
        },
        min_engagement: {
          type: "number",
          description: "Min engagement score, default 10 (unassigned view)",
        },
      },
      required: [],
    },
  },
  {
    name: "send_payment_request",
    description: `Find or create a prospect organization and either look up its products, draft an invoice for review, or send a membership invite. Admins cannot directly mint payment links or send invoices from this tool — those operations are only valid in the recipient's own authenticated session, after they accept the invite.

Actions:
- "lookup_only": find or create the org, list eligible products. Read-only.
- "draft_invoice": preview what the invoice would look like (amount, discount). No Stripe write.
- "send_invite": create a membership invite token and email it to the contact. This is NOT a direct invoice send — there is no admin path to issue invoices or payment links to non-signed-in recipients. The recipient signs in, accepts the agreement, and the invoice or checkout is then issued in their authenticated session — never under the admin's or a hallucinated email.`,
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string", description: "Company name" },
        domain: { type: "string", description: "Company domain" },
        contact_name: { type: "string", description: "Contact person name" },
        contact_email: {
          type: "string",
          description:
            "Email of the human who will sign in to complete billing in their own session. Used only to deliver the invite — never used as a Stripe customer email or invoice recipient directly. Required for send_invite.",
        },
        contact_title: { type: "string", description: "Contact job title" },
        customer_type: {
          type: "string",
          enum: ["company", "individual"],
          description:
            'Membership customer type. Defaults to "company". Individual requests require contact_email so the personal workspace can be safely reused.',
        },
        action: {
          type: "string",
          enum: ["lookup_only", "draft_invoice", "send_invite"],
          description: "Action type (default: lookup_only)",
        },
        lookup_key: {
          type: "string",
          description: "Product lookup_key from find_membership_products",
        },
        discount_percent: {
          type: "number",
          description: "Percentage discount (preview only in draft_invoice)",
        },
        discount_amount_dollars: {
          type: "number",
          description: "Fixed dollar discount (preview only in draft_invoice)",
        },
        discount_reason: {
          type: "string",
          description: "Reason for discount (required when applying one)",
        },
        use_existing_discount: {
          type: "boolean",
          description: "Use existing org discount (default: true)",
        },
      },
      required: ["company_name"],
    },
  },
  {
    name: "prospect_search_lusha",
    description:
      "Search Lusha's database for potential prospects matching criteria. Use this to find new companies to reach out to based on industry, size, or location.",
    input_schema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Keywords to search for",
        },
        industries: {
          type: "array",
          items: { type: "string" },
          description: "Industry categories",
        },
        min_employees: { type: "number", description: "Min employee count" },
        max_employees: { type: "number", description: "Max employee count" },
        countries: {
          type: "array",
          items: { type: "string" },
          description: "Countries to include",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: [],
    },
  },

  // ============================================
  // MEMBERSHIP INVITE TOOLS
  // ============================================
  {
    name: "diagnose_signin_block",
    description:
      "Use when a user reports they cannot sign in to AgenticAdvertising.org. Combines person, invite, and org-membership state into a single verdict — needs_signin (account exists, just sign in), needs_resend (invite expired or stale, send a fresh one), needs_invite (no invite on file, send one), or needs_human (state is unclear). Do NOT use for general account questions — use lookup_person or get_account for those. Returns the verdict plus a one-line reason and any pending invite token to act on.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "Email address of the person who cannot sign in",
        },
        org_id: {
          type: "string",
          description:
            "WorkOS organization ID (org_…) the user is trying to access",
        },
      },
      required: ["email", "org_id"],
    },
  },
  {
    name: "list_invites_for_org",
    description:
      'Use when an admin asks "what invites do we have for X" or you need to reference an invite token before resending or revoking. Defaults to pending only; pass include_accepted or include_revoked to widen. Capped at 20, sorted by expiry (soonest first). Returns one invite per line with its token suffix so you can quote a token back into resend_invite or revoke_invite.',
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_…)",
        },
        include_accepted: {
          type: "boolean",
          description:
            "Include invites that have been accepted. Default false.",
        },
        include_revoked: {
          type: "boolean",
          description: "Include invites that have been revoked. Default false.",
        },
      },
      required: ["org_id"],
    },
  },
  {
    name: "resend_invite",
    description:
      "Use to refresh a pending or expired membership invite — atomically revokes the original and emails a fresh one. Do NOT use to invite a brand-new contact (use send_payment_request for that). Do NOT use on an accepted invite. Returns the new expiry and whether the email was delivered.",
    input_schema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string",
          description:
            "Token of the invite to resend (from list_invites_for_org or diagnose_signin_block)",
        },
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_…) the invite belongs to",
        },
        customer_type: {
          type: "string",
          enum: ["company", "individual"],
          description:
            "Optional consistency check. When omitted, the persisted organization type is used so existing individual invites remain resendable.",
        },
      },
      required: ["token", "org_id"],
    },
  },
  {
    name: "revoke_invite",
    description:
      "Use to cancel a pending or expired invite (e.g. wrong email, person no longer joining). Does NOT send any notification to the recipient — their existing invite link will simply stop working. Cannot revoke an already-accepted or already-revoked invite. Returns confirmation including the previous status.",
    input_schema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string",
          description:
            "Token of the invite to revoke (from list_invites_for_org)",
        },
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_…) the invite belongs to",
        },
      },
      required: ["token", "org_id"],
    },
  },
  {
    name: "add_member_to_org",
    description:
      "Use when an admin or owner asks to add, invite, or promote a colleague on a paying org. Also the action to take when diagnose_signin_block returns needs_invite for an authorized requester. Handles four states automatically: invites new users (no WorkOS account yet), adds existing users to the org, updates roles, or no-ops if already correct. Do NOT use to remove members (no removal path), to change your own role, or for personal workspaces. Returns one of: invited, member_added, role_updated, no_change.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "Email of the colleague to add or promote",
        },
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_…) to add them to",
        },
        role: {
          type: "string",
          enum: ["member", "admin", "owner"],
          description:
            "Role to assign. Default: member. Note: owner can only be assigned by another owner or AAO super-admin; new invites always go out as member regardless and must be promoted after acceptance.",
        },
        seat_type: {
          type: "string",
          enum: ["contributor", "community_only"],
          description:
            "Seat type. Default: community_only. Contributors get Slack/working-groups/councils; community-only get Addie/certification/training.",
        },
      },
      required: ["email", "org_id"],
    },
  },

  // ============================================
  // INDUSTRY FEED MANAGEMENT TOOLS
  // ============================================
  {
    name: "search_industry_feeds",
    description:
      "Search and list RSS industry feeds. Use this to find feeds by name, URL, or category, or to see feeds with errors that need attention.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        status: {
          type: "string",
          enum: ["all", "active", "inactive", "errors"],
          description: "Filter by status",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "add_industry_feed",
    description:
      "Add a new RSS feed to monitor for industry news. Provide the feed URL and a name.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Feed name" },
        feed_url: { type: "string", description: "RSS feed URL" },
        category: {
          type: "string",
          enum: ["ad-tech", "advertising", "marketing", "media", "tech"],
          description: "Feed category",
        },
      },
      required: ["name", "feed_url"],
    },
  },
  {
    name: "get_feed_stats",
    description:
      "Get statistics about industry feeds - total feeds, active feeds, articles collected, processing status, etc.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  ADMIN_ANALYTICS_TOOL,
  {
    name: "list_feed_proposals",
    description:
      "List pending feed proposals submitted by community members. Use this to review what news sources have been proposed.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "approve_feed_proposal",
    description:
      "Approve a feed proposal and create the feed. You must provide the final feed name and URL (which may differ from the proposed URL if you find the actual RSS feed).",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "number", description: "Proposal ID" },
        feed_name: { type: "string", description: "Feed name" },
        feed_url: { type: "string", description: "RSS feed URL" },
        category: {
          type: "string",
          enum: [
            "ad-tech",
            "advertising",
            "marketing",
            "media",
            "martech",
            "ctv",
            "dooh",
            "creator",
            "ai",
            "sports",
            "industry",
            "research",
          ],
          description: "Feed category",
        },
      },
      required: ["proposal_id", "feed_name", "feed_url"],
    },
  },
  {
    name: "reject_feed_proposal",
    description:
      "Reject a feed proposal. Optionally provide a reason that could be shared with the proposer.",
    input_schema: {
      type: "object",
      properties: {
        proposal_id: { type: "number", description: "Proposal ID" },
        reason: { type: "string", description: "Rejection reason" },
      },
      required: ["proposal_id"],
    },
  },

  // ============================================
  // SENSITIVE TOPICS & MEDIA CONTACT TOOLS
  // ============================================
  {
    name: "add_media_contact",
    description:
      "Flag a Slack user as a known media contact (journalist, reporter, editor). Messages from this user will be handled with extra care and sensitive topics will be deflected.",
    input_schema: {
      type: "object",
      properties: {
        slack_user_id: { type: "string", description: "Slack user ID" },
        email: { type: "string", description: "Email address" },
        name: { type: "string", description: "Full name" },
        organization: { type: "string", description: "Media organization" },
        role: { type: "string", description: "Role (Reporter/Editor/etc)" },
        notes: { type: "string", description: "Additional notes" },
        handling_level: {
          type: "string",
          enum: ["standard", "careful", "executive_only"],
          description: "Handling level",
        },
      },
      required: [],
    },
  },
  {
    name: "list_flagged_conversations",
    description:
      "List conversations that have been flagged for sensitive topic detection. These need human review to ensure appropriate handling.",
    input_schema: {
      type: "object",
      properties: {
        unreviewed_only: {
          type: "boolean",
          description: "Only unreviewed (default: true)",
        },
        severity: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Filter by severity",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "review_flagged_conversation",
    description:
      "Mark a flagged conversation as reviewed. Use this after you've looked at a flagged message and determined if any follow-up action is needed.",
    input_schema: {
      type: "object",
      properties: {
        flagged_id: { type: "number", description: "Flagged conversation ID" },
        notes: { type: "string", description: "Review notes" },
      },
      required: ["flagged_id"],
    },
  },

  // ============================================
  // DISCOUNT MANAGEMENT TOOLS
  // ============================================
  {
    name: "grant_discount",
    description:
      "Grant a discount to an organization. Creates Stripe coupon/promo code.",
    input_schema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "Organization ID" },
        org_name: {
          type: "string",
          description: "Company name (if no org_id)",
        },
        discount_percent: { type: "number", description: "Percentage off" },
        discount_amount_dollars: {
          type: "number",
          description: "Fixed dollar amount off",
        },
        reason: { type: "string", description: "Discount reason" },
        create_promotion_code: {
          type: "boolean",
          description: "Create Stripe promo code (default: true)",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "remove_discount",
    description:
      "Remove a discount from an organization. Note: This does not delete any Stripe coupons that were created.",
    input_schema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "Organization ID" },
        org_name: {
          type: "string",
          description: "Company name (if no org_id)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_discounts",
    description: "List organizations with active discounts.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "create_promotion_code",
    description:
      "Create a standalone Stripe promo code for marketing campaigns.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: 'Checkout code (e.g., "LAUNCH2025")',
        },
        name: { type: "string", description: "Internal coupon name" },
        percent_off: { type: "number", description: "Percentage off" },
        amount_off_dollars: {
          type: "number",
          description: "Fixed dollar amount off",
        },
        duration: {
          type: "string",
          enum: ["once", "repeating", "forever"],
          description: "Duration (default: once)",
        },
        max_redemptions: { type: "number", description: "Max uses" },
      },
      required: ["code"],
    },
  },

  // ============================================
  // CHAPTER MANAGEMENT TOOLS
  // ============================================
  {
    name: "create_chapter",
    description:
      "Create a regional chapter with Slack channel. Sets founding member as chapter leader.",
    usage_hints: "Use when a member wants to start a chapter.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Chapter name" },
        region: { type: "string", description: "Geographic region" },
        founding_member_id: {
          type: "string",
          description: "Founding member WorkOS user ID",
        },
        description: { type: "string", description: "Chapter description" },
      },
      required: ["name", "region"],
    },
  },
  {
    name: "list_chapters",
    description:
      "List all regional chapters with their member counts and Slack channels.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ============================================
  // INDUSTRY GATHERING TOOLS
  // ============================================
  {
    name: "create_industry_gathering",
    description:
      "Create an industry gathering for conferences/trade shows. Auto-archives after event ends.",
    usage_hints: "Use for coordinating around major industry events.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Event name" },
        start_date: { type: "string", description: "Start date (YYYY-MM-DD)" },
        end_date: { type: "string", description: "End date (YYYY-MM-DD)" },
        location: { type: "string", description: "Event location" },
        website_url: { type: "string", description: "Event website URL" },
        description: { type: "string", description: "Event description" },
        founding_member_id: {
          type: "string",
          description: "Founding member WorkOS user ID",
        },
      },
      required: ["name", "start_date", "location"],
    },
  },
  {
    name: "list_industry_gatherings",
    description:
      "List all industry gatherings with their dates, locations, and member counts.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ============================================
  // COMMITTEE TOOLS
  // ============================================
  {
    name: "create_committee",
    description:
      "Create a committee (working group, council, or governance body). For chapters use create_chapter; for conferences use create_industry_gathering. Can link an existing Slack channel by name.",
    usage_hints:
      "Use when an admin wants to create a new working group, council, or governance body.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Committee name" },
        committee_type: {
          type: "string",
          enum: ["working_group", "council", "governance"],
          description: "Type of committee. Default: working_group",
        },
        description: {
          type: "string",
          description: "What the committee is for",
        },
        is_private: {
          type: "boolean",
          description:
            "Whether the group is private (invite-only). Default: false",
        },
        slack_channel_name: {
          type: "string",
          description:
            "Existing Slack channel name (without #) to link. Leave blank to skip.",
        },
      },
      required: ["name"],
    },
  },

  // ============================================
  // COMMITTEE LEADERSHIP TOOLS
  // ============================================
  {
    name: "add_committee_leader",
    description:
      "Add a user as leader of a committee. Leaders can manage posts, events, and members.",
    usage_hints:
      "Accepts Slack user IDs (e.g. U12345ABC from <@U12345ABC>) — they are automatically resolved to WorkOS user IDs. Use list_working_groups to find the committee slug.",
    input_schema: {
      type: "object",
      properties: {
        committee_slug: {
          type: "string",
          description:
            'Committee slug (e.g. "media-buy-wg"). Use list_working_groups to find it.',
        },
        user_id: {
          type: "string",
          description: "Slack user ID (e.g. U12345ABC) or WorkOS user ID",
        },
        user_email: { type: "string", description: "User email (optional)" },
      },
      required: ["committee_slug", "user_id"],
    },
  },
  {
    name: "remove_committee_leader",
    description:
      "Remove a user from committee leadership. User remains a regular member.",
    usage_hints:
      "Accepts Slack user IDs (e.g. U12345ABC from <@U12345ABC>) — they are automatically resolved to WorkOS user IDs. Use list_working_groups to find the committee slug.",
    input_schema: {
      type: "object",
      properties: {
        committee_slug: { type: "string", description: "Committee slug" },
        user_id: {
          type: "string",
          description: "Slack user ID (e.g. U12345ABC) or WorkOS user ID",
        },
      },
      required: ["committee_slug", "user_id"],
    },
  },
  {
    name: "list_committee_leaders",
    description: "List all leaders of a committee.",
    input_schema: {
      type: "object",
      properties: {
        committee_slug: { type: "string", description: "Committee slug" },
      },
      required: ["committee_slug"],
    },
  },

  // ============================================
  // WORKING GROUP MEMBERSHIP (admin)
  // ============================================
  {
    name: "add_working_group_member",
    description:
      "Add a user as a member of a working group, council, chapter, or industry gathering.",
    usage_hints:
      "Use for adding regular members — use add_committee_leader to add leaders instead. Accepts Slack user IDs (e.g. U12345ABC from <@U12345ABC>) — they are automatically resolved to WorkOS user IDs. Use list_working_groups to find the committee slug.",
    input_schema: {
      type: "object",
      properties: {
        committee_slug: {
          type: "string",
          description:
            'Committee slug (e.g. "media-buy-wg"). Use list_working_groups to find it.',
        },
        user_id: {
          type: "string",
          description: "Slack user ID (e.g. U12345ABC) or WorkOS user ID",
        },
        user_email: {
          type: "string",
          description: "User email (optional, helps identify them)",
        },
      },
      required: ["committee_slug", "user_id"],
    },
  },
  {
    name: "remove_working_group_member",
    description:
      "Remove a user from a working group, council, chapter, or industry gathering. The user is deactivated, not deleted.",
    usage_hints:
      "Accepts Slack user IDs (e.g. U12345ABC from <@U12345ABC>) — they are automatically resolved to WorkOS user IDs. Use list_working_groups to find the committee slug.",
    input_schema: {
      type: "object",
      properties: {
        committee_slug: {
          type: "string",
          description:
            'Committee slug (e.g. "media-buy-wg"). Use list_working_groups to find it.',
        },
        user_id: {
          type: "string",
          description: "Slack user ID (e.g. U12345ABC) or WorkOS user ID",
        },
      },
      required: ["committee_slug", "user_id"],
    },
  },

  // ============================================
  // ORGANIZATION MANAGEMENT TOOLS
  // ============================================
  {
    name: "merge_organizations",
    description:
      "Merge duplicate organization records. Destructive, cannot be undone. Preview first with preview=true. If both orgs have Stripe customers, you must specify stripe_customer_resolution.",
    usage_hints:
      "Preview first, then execute with preview=false. Check preview for Stripe customer conflicts.",
    input_schema: {
      type: "object" as const,
      properties: {
        primary_org_id: {
          type: "string",
          description: "Org ID to keep (data merged into)",
        },
        secondary_org_id: {
          type: "string",
          description: "Org ID to remove (data moved from)",
        },
        preview: {
          type: "boolean",
          description: "Show preview only (default: true)",
        },
        stripe_customer_resolution: {
          type: "string",
          enum: ["keep_primary", "use_secondary", "keep_both_unlinked"],
          description:
            "Required if both orgs have Stripe customers. keep_primary=keep primary Stripe customer, use_secondary=replace with secondary Stripe customer, keep_both_unlinked=unlink both for manual resolution",
        },
      },
      required: ["primary_org_id", "secondary_org_id"],
    },
  },
  {
    name: "find_duplicate_orgs",
    description: "Search for duplicate organizations by name or domain.",
    input_schema: {
      type: "object" as const,
      properties: {
        search_type: {
          type: "string",
          enum: ["name", "domain", "all"],
          description: "Search type",
        },
      },
      required: [],
    },
  },
  {
    name: "check_domain_health",
    description:
      "Check domain health for data quality issues: orphan domains, conflicts, misaligned users.",
    usage_hints: "Use for data quality audits.",
    input_schema: {
      type: "object" as const,
      properties: {
        check_type: {
          type: "string",
          enum: [
            "orphan_domains",
            "unverified_domains",
            "domain_conflicts",
            "misaligned_users",
            "all",
          ],
          description: "Check type",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "manage_organization_domains",
    description:
      "Add, remove, list, set primary, or reconcile verified domains for an organization. Syncs to WorkOS.",
    usage_hints: 'Use "list" first. Use "reconcile_workos" when WorkOS and local organization_domains are out of sync.',
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove", "set_primary", "reconcile_workos"],
          description: "Action",
        },
        organization_id: {
          type: "string",
          description: "WorkOS organization ID",
        },
        domain: { type: "string", description: "Domain name" },
        set_as_primary: {
          type: "boolean",
          description: "Set as primary (default: false)",
        },
      },
      required: ["action", "organization_id"],
    },
  },
  {
    name: "update_org_member_role",
    description: `Update a user's role within their organization. Use this to change a member's permissions.

Common scenarios:
- User paid for membership but can't manage team → promote to admin
- Need to grant someone ability to invite team members → promote to admin
- User should have full control of their org → promote to owner

Roles: member (default), admin (can manage team), owner (full control)`,
    usage_hints:
      "Get user_id from get_account tool or escalation context. Use when members need elevated permissions.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: {
          type: "string",
          description: "WorkOS organization ID (org_...)",
        },
        user_id: { type: "string", description: "WorkOS user ID (user_...)" },
        role: {
          type: "string",
          enum: ["member", "admin", "owner"],
          description: "New role",
        },
      },
      required: ["org_id", "user_id", "role"],
    },
  },

  {
    name: "update_user_name",
    description: `Update a user's display name (first and last name). Use this when a user's name is showing incorrectly (e.g., as their email prefix) and needs manual correction.`,
    usage_hints:
      "Get user_id from get_account or escalation context. Provide the correct first_name and optionally last_name.",
    input_schema: {
      type: "object" as const,
      properties: {
        user_id: { type: "string", description: "WorkOS user ID (user_...)" },
        email: {
          type: "string",
          description: "User email (alternative to user_id for lookup)",
        },
        first_name: { type: "string", description: "First name" },
        last_name: { type: "string", description: "Last name" },
      },
      required: ["first_name"],
    },
  },

  {
    name: "rename_working_group",
    description: `Rename a working group, chapter, or committee. Updates the display name and optionally the slug. Use this when a chapter or WG needs to be renamed (e.g., "Germany Chapter" → "DACH Chapter").`,
    usage_hints:
      "Look up current slug first with list_working_groups or list_chapters.",
    input_schema: {
      type: "object" as const,
      properties: {
        working_group_slug: {
          type: "string",
          description: "Current slug of the working group/chapter",
        },
        new_name: {
          type: "string",
          description: "New display name",
        },
        new_slug: {
          type: "string",
          description:
            "New slug (optional — auto-generated from name if not provided)",
        },
      },
      required: ["working_group_slug", "new_name"],
    },
  },

  // ============================================
  // PROSPECT OWNERSHIP TOOLS
  // ============================================
  {
    name: "claim_prospect",
    description:
      'Claim ownership of a prospect. Use owner_type "self" (default) to assign the current human user, or "addie" to assign Addie as SDR owner.',
    usage_hints: "Use after finding unassigned prospects.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_id: { type: "string", description: "Organization ID" },
        company_name: {
          type: "string",
          description: "Company name (if no org_id)",
        },
        owner_type: {
          type: "string",
          enum: ["self", "addie"],
          description:
            'Who to assign: "self" (human user) or "addie" (AI SDR). Default: self',
        },
        replace_existing: {
          type: "boolean",
          description: "Replace existing owner (default: false)",
        },
        notes: { type: "string", description: "Notes" },
      },
      required: [],
    },
  },
  {
    name: "suggest_prospects",
    description:
      "Suggest companies to add to prospect list. Finds unmapped domains and Lusha matches.",
    usage_hints: "Expand prospect pipeline.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_lusha: {
          type: "boolean",
          description: "Include Lusha results (default: true)",
        },
        lusha_keywords: {
          type: "array",
          items: { type: "string" },
          description: "Lusha search keywords",
        },
        limit: {
          type: "number",
          description: "Max results per source (default: 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "set_reminder",
    description: "Set a reminder/next step for a prospect.",
    usage_hints: "Schedule a future follow-up.",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: { type: "string", description: "Company name" },
        org_id: { type: "string", description: "Organization ID" },
        reminder: { type: "string", description: "What needs to be done" },
        due_date: { type: "string", description: "Due date" },
      },
      required: ["reminder", "due_date"],
    },
  },
  {
    name: "my_upcoming_tasks",
    description: "List upcoming tasks and reminders.",
    usage_hints: "Planning and scheduling.",
    input_schema: {
      type: "object" as const,
      properties: {
        days_ahead: { type: "number", description: "Days ahead (default: 7)" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: [],
    },
  },
  {
    name: "complete_task",
    description:
      "Mark a task/reminder as done. Can complete by company name, org ID, or all overdue tasks at once.",
    usage_hints: "Use when admin says a task is done, completed, or finished.",
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: {
          type: "string",
          description: "Company name to complete task for",
        },
        org_id: {
          type: "string",
          description: "Organization ID to complete task for",
        },
        all_overdue: {
          type: "boolean",
          description: "Complete all overdue tasks for this user",
        },
      },
      required: [],
    },
  },
  {
    name: "log_conversation",
    description:
      "Log a conversation or interaction with a prospect/member. Analyzes and extracts learnings.",
    usage_hints:
      'Use when admin reports a conversation, email, call, or any outreach. Only summary is required — infer company_name, contact_name, and channel from context (e.g. "emailed" → channel=email, "called" → channel=call).',
    input_schema: {
      type: "object" as const,
      properties: {
        company_name: { type: "string", description: "Company name" },
        org_id: { type: "string", description: "Organization ID" },
        contact_name: { type: "string", description: "Contact name" },
        channel: {
          type: "string",
          enum: ["call", "video", "slack_dm", "email", "in_person", "other"],
          description: "Channel",
        },
        summary: { type: "string", description: "Summary of discussion" },
      },
      required: ["summary"],
    },
  },

  // ============================================
  // MEMBER INSIGHT SUMMARY TOOLS
  // ============================================
  // MEMBER SEARCH & INTRODUCTION ANALYTICS TOOLS
  // ============================================
  // ============================================
  // ORGANIZATION ANALYTICS TOOLS
  // ============================================
  {
    name: "list_slack_users_by_org",
    description: "List Slack users from a specific organization.",
    usage_hints: "See specific people from a company.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Company name or domain" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_paying_members",
    description:
      "List a limited page of paying memberships grouped by subscription level ($50K ICL, $10K corporate, $2.5K SMB, individual), with names and primary contacts. The summary counts all matching memberships before the row limit. Includes individuals by default; include_individual: false selects organizations only. For a count or membership breakdown without contact details, use query_admin_analytics with view=platform_stats.",
    usage_hints:
      "Use for member names and contacts, who pays what, outreach lists, or payment issues. For current totals and individual/organization or tier breakdowns, prefer query_admin_analytics with view=platform_stats.",
    input_schema: {
      type: "object" as const,
      properties: {
        include_individual: {
          type: "boolean",
          description:
            "Include individual (personal) memberships (default: true)",
        },
        include_payment_issues: {
          type: "boolean",
          description:
            "Also include members with past_due or unpaid subscriptions, flagged in output (default: false)",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 200, max: 500)",
        },
      },
    },
  },

  // ============================================
  // ESCALATION MANAGEMENT TOOLS
  // ============================================
  {
    name: "list_escalations",
    description: "List escalations (default: open), with total_count and next_offset. Use escalation_id for full details at any status.",
    usage_hints:
      "Show every returned ticket; distinguish total matches from the page shown. Use next_offset for more records.",
    input_schema: {
      type: "object" as const,
      properties: {
        escalation_id: {
          type: "number",
          description:
            "Full details for one ID; ignores list filters",
        },
        status: {
          type: "string",
          enum: [
            "open",
            "acknowledged",
            "in_progress",
            "resolved",
            "wont_do",
            "expired",
          ],
          description:
            "Status filter (default: open); ignored for ID lookups",
        },
        category: {
          type: "string",
          enum: [
            "capability_gap",
            "needs_human_action",
            "complex_request",
            "sensitive_topic",
            "other",
          ],
          description: "Filter by category",
        },
        limit: {
          type: "integer", minimum: 1, maximum: 25,
          description: "Page size (default: 10)",
        },
        offset: {
          type: "integer", minimum: 0,
          description: "Skip matches (default: 0); use next_offset to continue",
        },
      },
      required: [],
    },
  },
  {
    name: "resolve_escalation",
    description: `Mark an escalation as resolved and notify the user via Slack DM or email. Use this after you've handled a request that was previously escalated.

IMPORTANT: Always notify the user unless there's a reason not to (e.g., test escalation, duplicate).
Notification is sent via Slack DM when a Slack user ID is on record, or via email as fallback.
This is how you notify users about escalation outcomes — use it whenever asked to "let someone know", "follow up", or "close the loop" on an escalation.

Examples:
- User needed admin role → used update_org_member_role → resolve and notify
- User needed co-leader added → used add_committee_co_leader → resolve and notify
- Admin says "this is fixed, let them know" → resolve and notify
- Duplicate request → resolve with wont_do, no notification needed`,
    usage_hints:
      "After handling an escalated request, resolve it and notify the user. Also use when asked to let someone know about a resolved escalation.",
    input_schema: {
      type: "object" as const,
      properties: {
        escalation_id: {
          type: "number",
          description: "Escalation ID to resolve",
        },
        status: {
          type: "string",
          enum: ["resolved", "wont_do"],
          description: "Resolution status (default: resolved)",
        },
        resolution_notes: {
          type: "string",
          description: "Notes about what was done to resolve",
        },
        notify_user: {
          type: "boolean",
          description:
            "Notify user about resolution via Slack DM or email (default: true)",
        },
        notification_message: {
          type: "string",
          description: "Custom message to include in notification",
        },
      },
      required: ["escalation_id"],
    },
  },
  // ============================================
  // BAN MANAGEMENT TOOLS
  // ============================================
  {
    name: "ban_entity",
    description: `Ban a user, organization, or API key. Scope can be platform-wide (blocks all access) or registry-specific (blocks brand/property edits only).

Examples:
- Platform ban user: ban_type=user, entity_id=user_01HW..., scope=platform
- Ban org from brand edits: ban_type=organization, entity_id=org_01HW..., scope=registry_brand
- Revoke API key: ban_type=api_key, entity_id=wkapikey_..., scope=platform`,
    input_schema: {
      type: "object" as const,
      properties: {
        ban_type: {
          type: "string",
          enum: ["user", "organization", "api_key"],
          description: "What kind of entity to ban",
        },
        entity_id: {
          type: "string",
          description: "The entity ID (WorkOS user ID, org ID, or API key ID)",
        },
        scope: {
          type: "string",
          enum: ["platform", "registry_brand", "registry_property"],
          description:
            "What to ban from: platform (all access) or registry editing",
        },
        scope_target: {
          type: "string",
          description:
            "For registry bans: specific domain to ban from (omit for global)",
        },
        reason: {
          type: "string",
          description: "Why this entity is being banned",
        },
        expires_in_days: {
          type: "number",
          description: "Ban duration in days (omit for permanent)",
        },
      },
      required: ["ban_type", "entity_id", "scope", "reason"],
    },
  },
  {
    name: "unban_entity",
    description:
      "Remove a ban. Provide either the ban ID directly, or the ban_type + entity_id + scope to look it up.",
    input_schema: {
      type: "object" as const,
      properties: {
        ban_id: {
          type: "string",
          description: "The ban UUID to remove (if known)",
        },
        ban_type: {
          type: "string",
          enum: ["user", "organization", "api_key"],
          description: "Entity type (used with entity_id to find the ban)",
        },
        entity_id: {
          type: "string",
          description: "Entity ID to look up (used with ban_type)",
        },
        scope: {
          type: "string",
          enum: ["platform", "registry_brand", "registry_property"],
          description: "Scope to match (used with ban_type + entity_id)",
        },
      },
    },
  },
  {
    name: "list_bans",
    description:
      "List active bans. Optionally filter by ban_type, scope, or entity_id.",
    input_schema: {
      type: "object" as const,
      properties: {
        ban_type: {
          type: "string",
          enum: ["user", "organization", "api_key"],
          description: "Filter by entity type",
        },
        scope: {
          type: "string",
          enum: ["platform", "registry_brand", "registry_property"],
          description: "Filter by scope",
        },
        entity_id: {
          type: "string",
          description: "Filter by entity ID",
        },
      },
    },
  },

  // ============================================
  // MEMBER PROFILE TOOLS
  // ============================================
  {
    name: "update_member_logo",
    description: `Set or update the logo URL on a member's directory profile. Requires a publicly hosted HTTPS logo URL plus either the member's org_name or profile slug to identify them. Creates a brand entry if none exists, or updates the existing one.

Do not use this to upload or host logo files — the URL must already be publicly accessible. After updating, use resolve_escalation to close the related support ticket.`,
    usage_hints:
      "Call get_account first to confirm the member exists. After updating, call resolve_escalation to close the escalation and notify the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_name: {
          type: "string",
          description:
            "Organization display name. Provide this or slug (one is required).",
        },
        slug: {
          type: "string",
          description:
            "Member profile slug. Provide this or org_name (one is required).",
        },
        logo_url: {
          type: "string",
          description: "Publicly hosted HTTPS URL of the logo (PNG, SVG, etc.)",
        },
      },
      required: ["logo_url"],
    },
  },

  {
    name: "update_member_profile",
    description: `Update fields on a member's directory profile. Identify the member by org_name or slug (exact match required). Accepts any combination of: description, tagline, contact info, social links, headquarters, markets, offerings, and visibility settings.

For logo changes, use update_member_logo instead.`,
    usage_hints:
      "Call get_account first to confirm the member exists. Useful for fixing profile data or toggling visibility.",
    input_schema: {
      type: "object" as const,
      properties: {
        org_name: {
          type: "string",
          description:
            "Organization display name. Provide this or slug (one is required).",
        },
        slug: {
          type: "string",
          description:
            "Member profile slug. Provide this or org_name (one is required).",
        },
        description: { type: "string", description: "Company description." },
        tagline: {
          type: "string",
          description: "Short tagline. Set to empty string to clear.",
        },
        contact_email: {
          type: "string",
          description: "Contact email address.",
        },
        contact_website: {
          type: "string",
          description: "Company website URL.",
        },
        contact_phone: { type: "string", description: "Contact phone number." },
        linkedin_url: {
          type: "string",
          description: "LinkedIn profile or company page URL.",
        },
        twitter_url: { type: "string", description: "Twitter/X profile URL." },
        headquarters: {
          type: "string",
          description: 'Headquarters location (e.g., "New York, NY").',
        },
        markets: {
          type: "array",
          items: { type: "string" },
          description: 'Target markets (e.g., ["North America", "EMEA"]).',
        },
        offerings: {
          type: "array",
          items: {
            type: "string",
            enum: [...VALID_MEMBER_OFFERINGS],
          },
          description: "Member offering types.",
        },
        is_public: {
          type: "boolean",
          description:
            "Whether profile is visible in the public member directory.",
        },
        show_in_carousel: {
          type: "boolean",
          description: "Whether profile appears in the homepage carousel.",
        },
        is_founding_member: {
          type: "boolean",
          description:
            "Whether this member has founding member status. Admin-only. Setting true requires founding_member_source.",
        },
        founding_member_source: {
          type: "string",
          enum: ["auto_pre_cutoff", "manual_grandfather"],
          description:
            'Provenance for the founding member flag. Use "manual_grandfather" for admin overrides outside the auto-cutoff window.',
        },
        founding_member_granted_reason: {
          type: "string",
          description:
            'Free-text reason for a manual grandfather grant (e.g., "site issues blocked pre-deadline enrollment"). Recorded for audit.',
        },
      },
    },
  },

  // ============================================
  // ADDIE SDR TOOLS
  // ============================================
  {
    name: "triage_prospect_domain",
    description: `Assess an email domain as a potential prospect. Addie will research the company, determine fit, and optionally create a prospect record. Use this when someone mentions a company that isn't in the system yet.`,
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: 'Email domain to assess (e.g., "thetradedesk.com")',
        },
        company_name: {
          type: "string",
          description: "Company name, if known",
        },
        create_if_relevant: {
          type: "boolean",
          description:
            "If true, create a prospect record automatically when the company is relevant (default: true)",
        },
      },
      required: ["domain"],
    },
  },

  // ============================================
  // OUTREACH TOOLS
  // ============================================
  {
    name: "get_outreach_stats",
    description:
      'Get outreach performance metrics: messages sent, response rates. Use this when asked "how is outreach going?" or about engagement performance.',
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_outreach_history",
    description:
      "Get outreach message history. With a slack_user_id, returns that person's full outreach timeline with goals and responses. Without, returns recent system-wide outreach.",
    input_schema: {
      type: "object" as const,
      properties: {
        slack_user_id: {
          type: "string",
          description:
            "Slack user ID to get history for (optional — omit for recent system-wide)",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20)",
        },
      },
    },
  },
  {
    name: "send_outreach",
    description:
      "Trigger outreach to a Slack user. Checks eligibility first. Set dry_run=true to check eligibility without sending. Use lookup_person for full person context.",
    input_schema: {
      type: "object" as const,
      properties: {
        slack_user_id: {
          type: "string",
          description: "Slack user ID to contact",
        },
        dry_run: {
          type: "boolean",
          description:
            "If true, check eligibility without sending. Returns whether the user can be contacted and their capabilities.",
        },
      },
      required: ["slack_user_id"],
    },
  },
  {
    name: "lookup_person",
    description:
      "Look up a person by Slack user ID, email, or name. Returns their relationship stage, sentiment, contact eligibility, recent activity, and org. Use for person-level context (vs get_account for org-level).",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Slack user ID (U...), email address, or name to search",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_contact",
    description:
      "Create or find a contact record for a person by email. Writes to email_contacts (CRM) and person_relationships (engagement tracking). Returns whether the contact was new and whether they were auto-matched to an organization.",
    usage_hints:
      "Use when admin wants to add a new outreach contact or ensure a person exists in the CRM. Only email is required.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "Email address of the contact",
        },
        display_name: {
          type: "string",
          description: "Full name of the contact (optional but recommended)",
        },
      },
      required: ["email"],
    },
  },
  {
    name: "get_person_memory",
    description:
      "Use when you need the full picture of what we know about a person — identity, membership, engagement, preferences, pending invites, recent threads — gathered into one view before reasoning. Prefer this over chaining lookup_person + get_account + list_invites_for_org. Do NOT use for org-level questions. Returns a structured summary with sources so you can cite where each fact came from.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Slack user ID (U...), email, or display name",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_engagement_plan",
    description:
      "Preview the engagement plan for a person — shows contact eligibility, scored opportunities, and what Addie would say. Use this to understand or debug engagement decisions.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Slack user ID (U...), email address, or name",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_outreach_health",
    description:
      'Get a health report on the outreach system: stage breakdown, over-contacted people approaching circuit breaker, outreach volume, and email stats. Use to assess system health or when asked "how is outreach doing?"',
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_action_items",
    description:
      'Get open action items from the outreach pipeline — nudges, warm leads, momentum signals, follow-ups. Shows what needs attention today. Use to answer "who needs follow-up?" or "what\'s in my pipeline?"',
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description:
            "Filter by status: open, snoozed, completed, dismissed. Default: open",
          enum: ["open", "snoozed", "completed", "dismissed"],
        },
        action_type: {
          type: "string",
          description:
            "Filter by type: nudge, warm_lead, momentum, feedback, alert, follow_up, celebration",
          enum: [
            "nudge",
            "warm_lead",
            "momentum",
            "feedback",
            "alert",
            "follow_up",
            "celebration",
          ],
        },
        priority: {
          type: "string",
          description: "Filter by priority: high, medium, low",
          enum: ["high", "medium", "low"],
        },
        limit: {
          type: "number",
          description: "Max items to return. Default 20.",
        },
      },
      required: [],
    },
  },

  // ============================================
  // BRAND LOGO REVIEW TOOLS
  // ============================================
  {
    name: "list_pending_brand_logos",
    description:
      'List brand logos awaiting moderator review across the registry. Returns logo IDs, domains, uploader email, tags, and how long they have been pending. Use this to triage the registry approval queue or answer "what logos need approval?"',
    usage_hints:
      "Pair with review_brand_logo to approve or reject from the queue. Pending logos block the company-listing display until reviewed.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum logos to return (default 25, max 100)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0)",
        },
      },
    },
  },
  {
    name: "list_brand_logos",
    description:
      "List every logo for ONE specific brand domain — pending, approved, rejected, deleted — to investigate why a brand's logo is or is not displaying. Use this when you have a domain in hand. For the global moderation queue across all domains, use list_pending_brand_logos instead.",
    usage_hints:
      'Use when a member reports their logo is "disappearing" or stuck on a known domain. Pending status means an admin must approve via review_brand_logo.',
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: 'Brand domain (e.g., "thehook.es")',
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "review_brand_logo",
    description:
      "Approve, reject, or delete a pending brand logo. Approving makes it visible on the brand's company listing; rejecting hides it; deleting tombstones it. Triggers manifest rebuild on approve for unverified brands.",
    usage_hints:
      "Get the logo_id from list_pending_brand_logos or list_brand_logos. Always include a short note explaining the decision so the uploader gets useful feedback.",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "Brand domain the logo belongs to",
        },
        logo_id: {
          type: "string",
          description: "Logo UUID (from list_pending_brand_logos)",
        },
        action: {
          type: "string",
          enum: ["approve", "reject", "delete"],
          description:
            "approve = publish, reject = hide with reason, delete = tombstone",
        },
        note: {
          type: "string",
          description:
            "Reviewer note (max 500 chars). Required for reject/delete; helpful on approve.",
        },
      },
      required: ["domain", "logo_id", "action"],
    },
  },
  {
    name: "list_pending_community_mirrors",
    description:
      "List community mirror proposals awaiting expert review, including platform, proposal ID, digest, and submission time.",
    usage_hints:
      "Use for queue visibility only. All approve/reject decisions must be made by the human reviewer at /admin/community-mirrors.",
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum proposals to return (default 25, max 50)",
        },
      },
    },
  },

  // ============================================
  // BRAND REGISTRY TOOLS
  // ============================================
  {
    name: "transfer_brand_ownership",
    description: `Transfer ownership of a brand domain from one organization to another. Records a revision for audit. Use after out-of-band verification (acquisition docs, support ticket, legal correspondence) confirms the new org should own the domain.

Do not use to resolve unverified disputes — use the escalation queue for those. This is for confirmed transfers only.`,
    usage_hints:
      "Get new_org_id from get_account. Pair with resolve_escalation to close the related support ticket after transfer.",
    input_schema: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: 'Brand domain to transfer (e.g., "nova-brands.com")',
        },
        new_org_id: {
          type: "string",
          description:
            'WorkOS organization ID of the new owner (e.g., "org_01HW...")',
        },
        reason: {
          type: "string",
          description:
            'Reason for the transfer, recorded in the audit trail (e.g., "Acquisition by Pinnacle Agency — see ticket #4821")',
        },
      },
      required: ["domain", "new_org_id", "reason"],
    },
  },
  {
    name: "list_orphaned_brands",
    description: `List brand domains in the orphaned state — a prior owner relinquished and the manifest is preserved for adoption. Use this to audit relinquished brands, see which ones have stale data, and trigger admin cleanup or reach out to potential adopters. Returns prior owner org name + id, when relinquished, and a manifest preview so admins can decide at a glance.`,
    usage_hints:
      'Use to answer "what brands are awaiting adoption?" or to find a specific orphaned domain. Pair with transfer_brand_ownership when an admin has confirmed the right next owner out of band.',
    input_schema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum brands to return (default 50, max 200)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default 0)",
        },
      },
    },
  },
];
