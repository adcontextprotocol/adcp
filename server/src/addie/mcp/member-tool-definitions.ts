// MEMBER_TOOLS: the tool definitions of member-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

/**
 * Tool definitions for member-related operations
 */
export const MEMBER_TOOLS: AddieTool[] = [
  // ============================================
  // WORKING GROUPS (read + user-scoped write)
  // ============================================
  {
    name: 'list_working_groups',
    description:
      'List active committees in AgenticAdvertising.org. Can filter by type: working groups (technical), councils (industry verticals), or chapters (regional). Shows public groups to everyone, and includes private groups for members.',
    usage_hints: 'use for "what groups exist?", browsing available groups, finding councils or chapters',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
        type: { type: 'string', enum: ['working_group', 'council', 'chapter', 'all'], description: 'Committee type filter' },
      },
      required: [],
    },
  },
  {
    name: 'get_working_group',
    description:
      'Get details about a specific working group including its description, leaders, member count, and recent posts. Use the group slug (URL-friendly name). Pass include_members: true to get the full member list with names, org, and email (admins only for private groups).',
    usage_hints: 'use for "tell me about X group", "who is in the Kitchen Cabinet", "list members of X committee/council/chapter"',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Working group slug' },
        include_members: { type: 'boolean', description: 'Return full member list with name, org, and email (default: false)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'join_working_group',
    description:
      'Join a working group on behalf of the current user. If the group is private, suggests using request_working_group_invitation instead. The user must be a member of AgenticAdvertising.org.',
    usage_hints: 'use when user explicitly wants to join a group',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Group slug to join' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'request_working_group_invitation',
    description:
      'Request an invitation to a private working group on behalf of the user. Creates an escalation so an admin can process the invite. Use this when join_working_group fails because a group is private.',
    usage_hints: 'use when a user wants to join a private working group',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Group slug to request invitation for' },
        reason: { type: 'string', description: 'Why the user wants to join (optional but helpful for admins)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_my_working_groups',
    description:
      "Get the current user's working group memberships. Shows which groups they belong to and their role in each.",
    usage_hints: 'use for "what groups am I in?", checking user\'s memberships',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // COUNCIL INTEREST (user-scoped)
  // ============================================
  {
    name: 'express_council_interest',
    description:
      'Express interest in joining an industry council or other committee that is not yet launched. The user can indicate whether they want to be a participant or a potential leader. This helps gauge interest before the council officially launches.',
    usage_hints: 'use when user wants to sign up for or show interest in a council',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Council slug' },
        interest_level: { type: 'string', enum: ['participant', 'leader'], description: 'Interest level (default: participant)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'withdraw_council_interest',
    description:
      'Withdraw interest in a council or committee. Use this when the user no longer wants to be notified when the council launches.',
    usage_hints: 'use when user wants to opt out or remove their interest from a council',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Council slug' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_my_council_interests',
    description:
      "Get the current user's council interest signups. Shows which councils they've expressed interest in joining.",
    usage_hints: 'use for "what councils am I interested in?", checking user\'s interest signups',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // PERSONAL PROFILE (the person)
  // ============================================
  {
    name: 'get_my_profile',
    description:
      "Get the current user's personal profile — who they are as a person. Shows headline, bio, expertise, interests, and social links.",
    usage_hints: 'use for "what\'s my profile?", "my bio", "my headline"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_my_name',
    description:
      "Set the current user's first name and (optionally) last name. Writes through to the local DB, organization memberships, and back to WorkOS. Use this when a credential check tells you the user has no name on file, or whenever the user explicitly asks to set or correct their name.",
    usage_hints: 'use when check_credentials returns NAME_REQUIRED, or the user says "my name is X" / "set my name to X". For full names like "Tom Hespos" split into first_name="Tom" + last_name="Hespos". Do NOT call this for an admin renaming someone else — that\'s update_user_name (admin only).',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'First name (required, 1-255 chars)' },
        last_name: { type: 'string', description: 'Last name (optional, up to 255 chars). Pass empty string or omit to leave blank.' },
      },
      required: ['first_name'],
    },
  },
  {
    name: 'update_my_profile',
    description:
      "Update the current user's personal profile — who they are as a person. Can update headline, bio, expertise, interests, location, and social links. Only updates fields that are provided. Does NOT update first/last name — use set_my_name for that.",
    usage_hints: 'use when user wants to update their personal info, headline, bio, or expertise',
    input_schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'Short headline (e.g., "VP of Programmatic at Acme Corp")' },
        bio: { type: 'string', description: 'Bio in markdown' },
        expertise: { type: 'array', items: { type: 'string' }, description: 'Areas of expertise' },
        interests: { type: 'array', items: { type: 'string' }, description: 'Professional interests' },
        city: { type: 'string', description: 'City/location' },
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        twitter_url: { type: 'string', description: 'Twitter/X profile URL' },
      },
      required: [],
    },
  },

  // ============================================
  // COMPANY LISTING (the org's directory entry)
  // ============================================
  {
    name: 'get_company_listing',
    description:
      "Get the company's directory listing — how the organization appears in the member directory and to Addie. Shows tagline, description, offerings, headquarters, and contact info.",
    usage_hints: 'use for "what\'s our company listing?", "our tagline", "company profile", "our directory entry"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_company_listing',
    description:
      "Update the company's directory listing text fields — tagline, description, contact info, social links, and headquarters. Only updates fields that are provided. For logo or brand color, use update_company_logo instead.",
    usage_hints: 'use when user wants to update company tagline, description, contact info, or directory listing. For logo or brand color, use update_company_logo instead.',
    input_schema: {
      type: 'object',
      properties: {
        tagline: { type: 'string', description: 'Short tagline shown on directory card and used by Addie for search matching. Omit to leave unchanged.' },
        description: { type: 'string', description: 'Longer company description' },
        offerings: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'si_agent', 'governance_agent', 'publisher', 'data_provider', 'consulting', 'other'],
          },
          description: 'Service offerings (replaces existing list)',
        },
        contact_email: { type: 'string', description: 'Contact email address' },
        contact_website: { type: 'string', description: 'Company website URL' },
        contact_phone: { type: 'string', description: 'Contact phone number' },
        linkedin_url: { type: 'string', description: 'LinkedIn company page URL' },
        twitter_url: { type: 'string', description: 'Twitter/X profile URL' },
        headquarters: { type: 'string', description: 'Headquarters location (e.g., "New York, NY")' },
      },
      required: [],
    },
  },
  {
    name: 'update_company_logo',
    description:
      "Update the company logo or brand color on the directory listing. Use when a member wants to upload, change, or fix their company logo. The logo URL must be a publicly accessible HTTPS image (PNG, JPG, SVG, etc.) — file-viewer links like Google Drive don't work.\n\nIf the brand domain was previously registered by another organization, the tool returns a notice asking the user whether to adopt the prior brand identity (logos, colors, agents) or start fresh — pass `adopt_prior_manifest: true` to adopt or `false` to clear, then call again.",
    usage_hints: 'Use when the user says "update our logo", "fix my company logo", "set the brand color", or shares a logo URL. Validates that the URL returns an actual image before saving. If the response says the brand was previously registered, ask the user to choose adopt or clear, then re-run with adopt_prior_manifest set explicitly.',
    input_schema: {
      type: 'object',
      properties: {
        logo_url: {
          type: 'string',
          description: 'Public HTTPS URL to the logo image (PNG, JPG, SVG, WebP). Omit to leave unchanged.',
        },
        brand_color: {
          type: 'string',
          description: 'Primary brand color as a hex string (e.g., "#FF5733"). Omit to leave unchanged.',
        },
        adopt_prior_manifest: {
          type: 'boolean',
          description: 'Required only when the brand was previously registered by another org. true = keep the prior brand identity (logos, colors, agents) as a starting point (acquisition / handoff case). false = start fresh. Omit on first call; set explicitly after the user picks.',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_brand_domain_challenge',
    description:
      "Issue a DNS TXT challenge so the caller's selected organization can claim a brand domain currently registered to another org or unregistered. Returns the verification record (Name/Type/Value) for the user to publish at their DNS host. DO NOT use when: the domain is already owned by the caller's org (already linked in their member profile); the user is just asking what their domain is; the user is asking generic 'is my domain set up?' questions. If the caller belongs to multiple organizations, or the current org is a personal workspace while the domain matches a company org, STOP and ask them to choose the company organization_id before issuing a challenge. Pair with verify_brand_domain_challenge ONLY after the user confirms they've published the record. Response begins with an HTML comment '<!-- STATUS: <code> -->' for machine parsing (invisible in rendered markdown) — codes: dns_record_issued, already_verified, manual_domain_upgrade, collision, invalid_domain, workos_error, not_authenticated, no_org, org_selection_required, not_admin, missing_domain.",
    usage_hints: 'Use when the user explicitly asks to claim a domain they control but cannot link (cross-org dispute, "claim nike.com for us"). Do NOT call speculatively or as a status check. Include organization_id when the user has selected a specific org.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand domain to claim (e.g., "acme.com"). The caller must control DNS for this domain.',
        },
        organization_id: { type: 'string', description: 'Optional explicit WorkOS organization ID to issue the challenge under. Required when the caller must choose between a personal workspace and a company org.' },
        organization_name: { type: 'string', description: 'Optional explicit organization name. Must match exactly one active organization for the caller. Prefer organization_id when available.' },
        replace_manual_domain: { type: 'boolean', description: 'True only after the user confirms a manual_domain_upgrade.' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'verify_brand_domain_challenge',
    description:
      "Run the WorkOS DNS lookup against a previously-issued challenge for the selected organization and, on success, apply the brand-registry update. ONLY call after request_brand_domain_challenge returned DNS instructions in this same conversation AND the user has explicitly confirmed they published the record. NEVER call speculatively, as a 'check status' tool, or in a retry loop — DNS propagation takes minutes and the server enforces a cooldown that will return still_pending if you call again too soon. If the call returns still_pending, STOP and ask the user to confirm before any retry. Response begins with an HTML comment '<!-- STATUS: <code> -->' (invisible in rendered markdown) — codes: verified, still_pending, no_challenge, workos_error, not_authenticated, no_org, org_selection_required, not_admin, missing_domain. After 'verified' the claim is complete; after 'still_pending' STOP and ask the user to confirm before retrying.",
    usage_hints: 'Use only after the user confirms publication. Include organization_id when the original challenge was issued under a selected org. Pass adopt_prior_manifest=true ONLY when the prior request_brand_domain_challenge response indicated prior_manifest_exists=true AND the user explicitly asked to inherit the prior identity (acquisition/handoff case). Default false.',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The brand domain being verified.',
        },
        organization_id: { type: 'string', description: 'Optional explicit WorkOS organization ID for the challenge to verify. Use the same org that issued the challenge.' },
        organization_name: { type: 'string', description: 'Optional explicit organization name. Must match exactly one active organization for the caller. Prefer organization_id when available.' },
        adopt_prior_manifest: {
          type: 'boolean',
          description: 'Set true ONLY when the issue response had prior_manifest_exists=true AND the user explicitly asked to keep the existing brand record (logos, colors, agents). Default false starts fresh — this is the right choice for most claims, including reclaiming a domain from a squatter or first-time registration.',
        },
      },
      required: ['domain'],
    },
  },

  // ============================================
  // PERSPECTIVES / POSTS (user-scoped write)
  // ============================================
  {
    name: 'list_perspectives',
    description:
      'List published perspectives (articles/posts) from AgenticAdvertising.org members. These are public articles shared by the community.',
    usage_hints: 'use for "show me perspectives", browsing member articles',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: [],
    },
  },
  {
    name: 'create_working_group_post',
    description:
      'Create a post in a working group on behalf of the current user. The user must be a member of the working group. Supports article, link, and discussion post types.',
    usage_hints: 'use when user wants to create a post in a working group',
    input_schema: {
      type: 'object',
      properties: {
        working_group_slug: { type: 'string', description: 'Working group slug' },
        title: { type: 'string', description: 'Post title' },
        content: { type: 'string', description: 'Content in markdown' },
        post_type: { type: 'string', enum: ['article', 'link', 'discussion'], description: 'Post type (default: discussion)' },
        link_url: { type: 'string', description: 'URL for link posts' },
      },
      required: ['working_group_slug', 'title', 'content'],
    },
  },

  // ============================================
  // UNIFIED CONTENT MANAGEMENT
  // ============================================
  {
    name: 'propose_content',
    description:
      'Submit a draft (article or link) for editorial review. Content lands in pending_review; a committee lead or admin approves it to publish. Default committee is "editorial" (site-wide Perspectives). Only `title` is required.',
    usage_hints: 'use for "publish this post", "write a perspective", "post to the sustainability group", "share my thoughts on X", "post as AgenticAdvertising.org Team", "publish under the team name", "post as [org name]"',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title' },
        subtitle: { type: 'string', description: 'Subtitle' },
        content: { type: 'string', description: 'Content in markdown' },
        content_type: { type: 'string', enum: ['article', 'link'], description: 'Type (default: article)' },
        external_url: { type: 'string', description: 'URL for link type' },
        excerpt: { type: 'string', description: 'Short excerpt/summary' },
        category: { type: 'string', description: 'Category (e.g., Op-Ed, Interview, Ecosystem, White Paper, Press Release)' },
        author_title: { type: 'string', description: 'Author credential line shown under the byline (e.g., "VP Media Operations, Pinnacle Agency"). Distinct from the byline name — do not use for org names.' },
        byline: { type: 'string', description: 'Display name for the author byline. Set when the user explicitly asks to post as a team or org name (e.g., "AgenticAdvertising.org Team"). Omit to show the user\'s profile name.' },
        featured_image_url: { type: 'string', description: 'Optional URL for cover image. Omit if the author did not provide one. Do not fabricate or search for a URL.' },
        content_origin: { type: 'string', enum: ['official', 'member'], description: 'Content origin: official (AgenticAdvertising.org reports, press releases) or member (member perspectives). Default: member' },
        committee_slug: { type: 'string', description: 'Target committee slug (default: editorial for Perspectives). Use list_working_groups to see options.' },
        co_author_emails: { type: 'array', items: { type: 'string' }, description: 'Co-author emails' },
      },
      required: ['title'],
    },
  },
  {
    name: 'attach_content_asset',
    description:
      'Attach a file (image, PDF) to a published perspective. Fetches from a URL and stores it. Use after propose_content to add cover images or report PDFs.',
    usage_hints: 'use for "attach image to perspective", "upload report PDF", "add cover image"',
    input_schema: {
      type: 'object',
      properties: {
        perspective_slug: { type: 'string', description: 'The slug of the perspective to attach the file to' },
        source_url: { type: 'string', description: 'URL to fetch the file from (public URL or Slack file URL)' },
        asset_type: { type: 'string', enum: ['cover_image', 'report', 'attachment'], description: 'Type of asset: cover_image (sets featured image), report (downloadable PDF), attachment (general)' },
        file_name: { type: 'string', description: 'Override filename (default: derived from URL)' },
      },
      required: ['perspective_slug', 'source_url', 'asset_type'],
    },
  },
  {
    name: 'get_my_content',
    description:
      'Get all content where the user is an author, proposer, or owner (committee lead). Shows content across all collections with status and relationship info.',
    usage_hints: 'use for "show my content", "my perspectives", "what have I written?", "my pending posts"',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'pending_review', 'published', 'archived', 'rejected', 'all'], description: 'Filter by status' },
        collection: { type: 'string', description: 'Filter by collection' },
        relationship: { type: 'string', enum: ['author', 'proposer', 'owner'], description: 'Filter by relationship' },
      },
      required: [],
    },
  },
  {
    name: 'list_pending_content',
    description:
      'List content pending review that the user can approve/reject. Only committee leads see their committee content; admins see all pending content.',
    usage_hints: 'use for "what content needs approval?", "pending posts", "review queue"',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug filter' },
      },
      required: [],
    },
  },
  {
    name: 'approve_content',
    description:
      'Approve pending content for publication. Only committee leads (for their committees) and admins can approve content.',
    usage_hints: 'use for "approve this post", "publish this content"',
    input_schema: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content ID' },
        publish_immediately: { type: 'boolean', description: 'Publish immediately (default: true)' },
      },
      required: ['content_id'],
    },
  },
  {
    name: 'reject_content',
    description:
      'Permanently reject content. Only committee leads (for their committees) and admins can reject content. The proposer will see the rejection reason. Use request_revisions instead if the author should address feedback and resubmit.',
    usage_hints: 'use for "permanently reject this post", "decline this content" — for asking for edits use request_revisions',
    input_schema: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content ID' },
        reason: { type: 'string', description: 'Rejection reason' },
      },
      required: ['content_id', 'reason'],
    },
  },
  {
    name: 'request_revisions',
    description:
      'Ask the author to revise and resubmit content. The article stays visible in the review queue as "needs revisions" until the author resubmits. Use this instead of reject_content when the content is fixable.',
    usage_hints: 'use for "send this back for edits", "needs revisions", "ask author to fix"',
    input_schema: {
      type: 'object',
      properties: {
        content_id: { type: 'string', description: 'Content ID' },
        notes: { type: 'string', description: 'Revision feedback for the author' },
      },
      required: ['content_id', 'notes'],
    },
  },

  // ============================================
  // COMMITTEE DOCUMENTS
  // ============================================
  {
    name: 'add_committee_document',
    description:
      'Add a Google Docs document to a committee (working group, council, or chapter) for tracking. The document will be automatically indexed and summarized. Committee members and leaders can add documents.',
    usage_hints: 'use when user wants to add a Google Doc to track for a committee',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        title: { type: 'string', description: 'Document title' },
        document_url: { type: 'string', description: 'Google Docs URL' },
        description: { type: 'string', description: 'Description' },
        is_featured: { type: 'boolean', description: 'Featured document (default: false)' },
      },
      required: ['committee_slug', 'title', 'document_url'],
    },
  },
  {
    name: 'list_committee_documents',
    description:
      'List documents tracked by a committee. Shows document titles, status, and summaries.',
    usage_hints: 'use for "what documents does X group have?", "show governance docs"',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
      },
      required: ['committee_slug'],
    },
  },
  {
    name: 'update_committee_document',
    description:
      'Update a document tracked by a committee. Can change title, description, URL, or featured status. Committee members and leaders can update documents.',
    usage_hints: 'use when user wants to update/edit a tracked document',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        document_id: { type: 'string', description: 'Document ID' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        document_url: { type: 'string', description: 'New Google Docs URL' },
        is_featured: { type: 'boolean', description: 'Featured document' },
      },
      required: ['committee_slug', 'document_id'],
    },
  },
  {
    name: 'delete_committee_document',
    description:
      'Remove a document from a committee. The document will no longer be tracked or displayed. Only committee leaders can delete documents.',
    usage_hints: 'use when user wants to remove/delete a tracked document',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: { type: 'string', description: 'Committee slug' },
        document_id: { type: 'string', description: 'Document ID' },
      },
      required: ['committee_slug', 'document_id'],
    },
  },

  // ============================================
  // ACCOUNT LINKING
  // ============================================
  {
    name: 'get_account_link',
    description:
      'Get a link to connect the user\'s Slack account with their AgenticAdvertising.org account. Use this when a user\'s accounts are not linked and they want to access member features. IMPORTANT: Share the full tool output with the user - it contains the clickable sign-in link they need. The user clicks the link to sign in and their accounts are automatically connected.',
    usage_hints: 'use when user needs to connect Slack to their AAO account',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // AGENT TESTING & COMPLIANCE
  // ============================================
  {
    name: 'get_agent_status',
    description:
      'Return the AAO registry\'s current status for an agent: health (online / last checked), declared capabilities, and the most recent compliance verdict per track from the comply storyboard suite. Reads cached state — does NOT perform a live probe. For agents not in the registry, returns guidance to register the agent (so the heartbeat picks it up) or to run evaluate_agent_quality for an on-demand check.',
    usage_hints: 'use for "is this agent online?", "is this agent up?", "what does this agent support?", "what\'s the compliance status?", "is this agent verified?". Reads the same data the public dashboard renders, so Addie and the dashboard never disagree. For an on-demand live test, use evaluate_agent_quality. For a fresh OAuth handshake / signing diagnosis, use diagnose_agent_auth.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'The agent URL to look up in the registry.' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'check_publisher_authorization',
    description:
      'Check if a publisher domain has authorized a specific agent. Results are cached briefly; pass force_refresh: true after the publisher changes adagents.json to bypass the cache.',
    usage_hints: 'use for authorization verification, "is my agent authorized?". If the result is negative and the user says they just updated adagents.json, proactively offer to rerun with force_refresh: true.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Publisher domain' },
        agent_url: { type: 'string', description: 'Agent URL' },
        force_refresh: {
          type: 'boolean',
          description: 'Bypass the cached authorization result and fetch the publisher adagents.json live.',
        },
      },
      required: ['domain', 'agent_url'],
    },
  },
  {
    name: 'test_adcp_agent',
    description:
      'Deprecated — use evaluate_agent_quality instead. Runs evaluate_agent_quality and returns the same results.',
    usage_hints: 'DEPRECATED: prefer evaluate_agent_quality for all agent testing. This tool exists for backward compatibility.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'evaluate_agent_quality',
    description:
      'Evaluate an AdCP agent across its supported compliance tracks. Identical active requests coalesce across replicas and return running status. Partial receipts retain coverage/findings but cannot support definitive verdict or root-cause claims. Custom authenticated agents require save_agent first.',
    usage_hints: 'use for agent quality tests and status follow-ups. The public test agent needs no setup. Report an existing run without retrying that turn. Caveat incomplete receipts and preserve their partial evidence.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to evaluate' },
        tracks: { type: 'array', items: { type: 'string', enum: ['core', 'products', 'media_buy', 'creative', 'reporting', 'governance', 'signals', 'si', 'audiences'] }, description: 'Specific compliance tracks to run (default: all applicable, driven by the agent\'s get_adcp_capabilities response)' },
        compliance_target: { type: 'string', description: 'Compliance target to run, e.g. "3.2", "3.1", or "3.0" for badge-eligible stable lines, or "3.2-rc"/"3.2-beta" for explicit prerelease diagnostics. Defaults to the canonical badge-eligible target when advertised.' },
      },
      required: ['agent_url'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_media_kit',
    description:
      '[DEPRECATED — use test_rfp_response or test_io_execution instead] Compare a publisher\'s stated inventory against what their agent returns. Prefer test_rfp_response (tests against real RFPs) or test_io_execution (tests whether IOs can execute through the agent).',
    usage_hints: 'DEPRECATED: prefer test_rfp_response for discovery testing and test_io_execution for execution testing. Only use this for backward compatibility.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test against' },
        idempotency_key_prefix: { type: 'string', minLength: 16, maxLength: 220, pattern: '^[A-Za-z0-9_.:-]{16,220}$', description: 'Stable prefix for generated per-brief get_products keys; reuse it when retrying this comparison.' },
        media_kit_summary: { type: 'string', description: 'Structured description of what the publisher sells (channels, formats, verticals, pricing tiers, audience capabilities)' },
        verticals: { type: 'array', items: { type: 'string' }, description: 'Verticals the publisher serves (e.g., automotive, healthcare, tech)' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels from the media kit (e.g., display, video, podcast, audio, newsletter, dooh, ctv)' },
        formats: { type: 'array', items: { type: 'string' }, description: 'Specific format types offered' },
        sample_io: { type: 'string', description: 'Text of a sample IO or RFP response for additional comparison' },
      },
      required: ['agent_url', 'idempotency_key_prefix', 'media_kit_summary'],
    },
  },
  {
    name: 'test_rfp_response',
    description:
      'Test how a publisher\'s agent responds to a real RFP or campaign brief. Addie parses the RFP document first, then calls this tool with structured data. Calls get_products on the agent and returns gap analysis comparing what the agent surfaces vs what the RFP requests. The publisher\'s stated response (what they\'d normally propose) is the highest-value input — it lets you compare agent output to how the sales team actually responds.',
    usage_hints: 'use when publisher shares an RFP, media brief, or campaign brief. IMPORTANT: before calling, ask the publisher what they would normally propose — that comparison is the most valuable output. Testing sequence: evaluate_agent_quality → test_rfp_response → test_io_execution.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test against' },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]{16,255}$', description: 'Stable key for this get_products request; reuse it after an ambiguous timeout.' },
        rfp: {
          type: 'object',
          description: 'Structured RFP data extracted by Addie from the publisher\'s document',
          properties: {
            brief: { type: 'string', description: 'Natural language campaign brief extracted from the RFP. This becomes the brief field in get_products.' },
            advertiser: { type: 'string', description: 'Advertiser name from the RFP' },
            budget: {
              type: 'object',
              properties: { amount: { type: 'number' }, currency: { type: 'string' } },
              description: 'Total budget from the RFP, if stated',
            },
            flight_dates: {
              type: 'object',
              properties: { start: { type: 'string' }, end: { type: 'string' } },
              description: 'Campaign dates from the RFP',
            },
            channels: { type: 'array', items: { type: 'string' }, description: 'Channels the buyer is asking for (e.g., display, video, ctv, podcast)' },
            formats: { type: 'array', items: { type: 'string' }, description: 'Specific format types requested (e.g., 300x250, pre-roll, mid-roll)' },
            audience: { type: 'string', description: 'Target audience description from the RFP' },
            kpis: { type: 'array', items: { type: 'string' }, description: 'Performance goals stated in the RFP (e.g., reach, CTR, completed views)' },
            publisher_response: { type: 'string', description: 'What the publisher would normally propose for this RFP. This is the highest-value input — it lets Addie compare agent output to how the sales team actually responds.' },
          },
          required: ['brief'],
        },
      },
      required: ['agent_url', 'idempotency_key', 'rfp'],
    },
  },
  {
    name: 'test_io_execution',
    description:
      'Test whether a buyer agent can execute a real IO or proposal through the publisher\'s agent. Addie parses the IO document first, then calls this tool with structured line items. Maps each line item to agent products using deterministic scoring, constructs the exact create_media_buy JSON a buyer agent would send, and optionally dry-runs it.',
    usage_hints: 'use when publisher shares an IO, insertion order, proposal, or media plan. Parse the document first to extract line items. The output includes the exact create_media_buy JSON — share it with the publisher so they can take it to their engineering team.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test against' },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]{16,255}$', description: 'Stable key for the catalog get_products request; reuse it after an ambiguous timeout.' },
        create_media_buy_idempotency_key: { type: 'string', minLength: 16, maxLength: 255, pattern: '^[A-Za-z0-9_.:-]{16,255}$', description: 'Stable key for the optional create_media_buy execution; reuse it after an ambiguous timeout.' },
        line_items: {
          type: 'array',
          description: 'Line items extracted from the IO or proposal by Addie',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'What this line item is (e.g., "Homepage takeover - 300x250 display, 1M impressions")' },
              channel: { type: 'string', description: 'Channel if identifiable (display, video, audio, etc.)' },
              format: { type: 'string', description: 'Format if specified (300x250, pre-roll, etc.)' },
              pricing_model: { type: 'string', description: 'How it\'s priced (CPM, CPC, flat rate, etc.)' },
              rate: { type: 'number', description: 'Unit price (e.g., $12 CPM). IO rates are often negotiated above rate card.' },
              budget: { type: 'number', description: 'Line item total spend' },
              start_date: { type: 'string', description: 'Start date (ISO 8601)' },
              end_date: { type: 'string', description: 'End date (ISO 8601)' },
            },
            required: ['description'],
          },
          minItems: 1,
        },
        advertiser: { type: 'string', description: 'Advertiser name from the IO' },
        advertiser_domain: { type: 'string', description: 'Advertiser brand domain (for example, brand.example). Required to construct or execute create_media_buy.' },
        account_id: { type: 'string', description: 'Seller-assigned advertiser account ID. Required to construct or execute create_media_buy.' },
        currency: { type: 'string', description: 'Currency for all line items (default: USD)' },
        execute: { type: 'boolean', description: 'If true, actually call create_media_buy on the agent. If false (default), only construct the JSON.', default: false },
      },
      required: ['agent_url', 'idempotency_key', 'create_media_buy_idempotency_key', 'line_items'],
    },
  },
  // ============================================
  // STORYBOARD TOOLS (discover, recommend, run)
  // ============================================
  {
    name: 'recommend_storyboards',
    description:
      'Probe an agent\'s `get_adcp_capabilities` and return the compliance bundles that will run. The agent\'s declared `supported_protocols` and `specialisms` drive the selection — no member configuration needed. If the agent declares nothing, explain what it needs to declare to get coverage.',
    usage_hints: 'use for "test this URL", "what can I test?", "which storyboards apply?", pasted agent URL, or any first-time agent testing. This should be the FIRST tool called when someone wants to test an agent.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to discover and recommend storyboards for' },
        compliance_target: { type: 'string', description: 'Compliance target to inspect, e.g. "3.2", "3.1", "3.0", "3.2-rc", or "3.2-beta". Defaults to the canonical badge-eligible target when advertised. Explicit targets only run when the agent advertises support.' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'get_storyboard_detail',
    description:
      'Show the full structure of a storyboard — phases, steps, what each step tests, and what passing looks like. Use this before running a storyboard so the developer understands what will be tested.',
    usage_hints: 'use when developer wants to understand a storyboard before running it, or asks "what does this test?", "show me the steps"',
    input_schema: {
      type: 'object',
      properties: {
        storyboard_id: { type: 'string', description: 'Storyboard ID (from recommend_storyboards)' },
        compliance_target: { type: 'string', description: 'Compliance target to inspect, e.g. "3.2", "3.1", "3.0", "3.2-rc", or "3.2-beta". Defaults to 3.0.' },
      },
      required: ['storyboard_id'],
    },
  },
  {
    name: 'run_storyboard',
    description:
      'Run a complete storyboard against an agent and return step-by-step results. Each step shows pass/fail, validations, and what the agent returned. Use after recommend_storyboards and optionally get_storyboard_detail.',
    usage_hints: 'use for "run this storyboard", "test media_buy_seller", "execute the test". Always call recommend_storyboards first to discover applicable storyboards.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test' },
        storyboard_id: { type: 'string', description: 'Storyboard ID to run' },
        dry_run: { type: 'boolean', description: 'If true (default), use test data that won\'t affect production state', default: true },
        compliance_target: { type: 'string', description: 'Compliance target to run, e.g. "3.2", "3.1", "3.0", "3.2-rc", or "3.2-beta". Defaults to the canonical badge-eligible target when advertised. Explicit prerelease targets are diagnostic-only and only run when the agent advertises support.' },
      },
      required: ['agent_url', 'storyboard_id'],
    },
  },
  {
    name: 'run_storyboard_step',
    description:
      'Run a single step of a storyboard. Returns the result plus a preview of the next step. Use this for step-by-step debugging — lets the developer see each request/response and decide whether to continue. Pass the context from the previous step result to maintain state.',
    usage_hints: 'use for "run one step at a time", "step through the test", "debug step by step". Start with step_id from get_storyboard_detail or from the previous step\'s next.step_id.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL to test' },
        storyboard_id: { type: 'string', description: 'Storyboard ID' },
        step_id: { type: 'string', description: 'Step ID to run (from storyboard detail or previous step\'s next.step_id)' },
        context: {
          type: 'object',
          description: 'Opaque context reference from the previous run_storyboard_step result',
          properties: {
            context_ref: { type: 'string', description: 'Server-generated context reference from the previous step' },
          },
          required: ['context_ref'],
          additionalProperties: false,
        },
        dry_run: { type: 'boolean', description: 'If true (default), use test data', default: true },
        compliance_target: { type: 'string', description: 'Compliance target to run, e.g. "3.2", "3.1", "3.0", "3.2-rc", or "3.2-beta". Defaults to the canonical badge-eligible target when advertised. Explicit prerelease targets are diagnostic-only and only run when the agent advertises support.' },
      },
      required: ['agent_url', 'storyboard_id', 'step_id'],
    },
  },
  // ============================================
  // AGENT CONTEXT MANAGEMENT
  // ============================================
  {
    name: 'save_agent',
    description:
      'Register an agent for the current organization or an explicitly selected active organization (organization_id / organization_name). Appears in /dashboard/agents, initially members_only: visible to paying AgenticAdvertising.org members (Professional, Builder, Member, Leader). Public visibility is a separate dashboard action requiring one of those tiers and a primary brand domain. Require the owner’s declared type and auth-mode choice; never guess type. Capability probes establish verified type separately. Auth: none, encrypted bearer/basic, or OAuth client credentials. Prefer configure_auth_in_dashboard for secure credential entry outside chat. Interactive OAuth uses the agent card’s Authorize flow after saving without credentials. health_check_url provides fallback liveness for authenticated or path-prefixed endpoints; it does not establish capability or compliance. Follow the registration intake rules.',
    usage_hints: 'use for "register my agent", "add an agent", "save my agent", "store my auth token", "configure client credentials". Save the registration before handing off credentials; the dashboard Register agent button opens this chat.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL' },
        agent_name: { type: 'string', description: 'Agent name' },
        configure_auth_in_dashboard: { type: 'boolean', description: 'Save the agent registration now and direct the owner to the dashboard authentication form to enter credentials securely. Do not include auth_token, auth_type, or oauth_client_credentials with this option. Existing credentials are preserved. This does not configure or verify authentication.' },
        type: {
          type: 'string',
          enum: ['brand', 'rights', 'measurement', 'governance', 'creative', 'sales', 'buying', 'signals'],
          description: 'What kind of agent this is. Required — ask the owner; do not guess. `brand` (brand-side intent), `rights` (rights/clearance), `measurement` (verification/attribution), `governance` (policy/compliance), `creative` (creative production/format), `sales` (publisher/sell-side inventory), `buying` (DSP/buy-side execution), `signals` (audience/signal provider).',
        },
        auth_token: { type: 'string', description: 'Static auth token (stored encrypted). Mutually exclusive with oauth_client_credentials on any given save call.' },
        auth_type: { type: 'string', enum: ['bearer', 'basic'], description: 'How the auth_token is sent. "bearer" (default): sends Authorization: Bearer <token>. "basic": auth_token is "username:password" with a non-empty username and a password that may be empty (the tool also accepts the base64-encoded form); stored base64-encoded and sent as Authorization: Basic <token>.' },
        oauth_client_credentials: {
          type: 'object',
          description: 'OAuth 2.0 client-credentials configuration for machine-to-machine auth (RFC 6749 §4.4). The SDK exchanges at the token endpoint before every call and refreshes on 401. Use this when the agent requires a bearer token minted from a client_id/client_secret pair, not a human authorization flow.',
          properties: {
            token_endpoint: { type: 'string', description: 'Token endpoint URL (HTTPS required; localhost allowed in dev).' },
            client_id: { type: 'string', description: 'OAuth client ID. May be a `$ENV:VAR_NAME` reference — the SDK resolves at exchange time.' },
            client_secret: { type: 'string', description: 'OAuth client secret. May be a `$ENV:VAR_NAME` reference. Stored encrypted at rest regardless.' },
            scope: { type: 'string', description: 'Space-separated OAuth scope values (optional).' },
            resource: {
              oneOf: [
                { type: 'string', maxLength: 2048, description: 'Single resource URI (max 2048 chars).' },
                { type: 'array', items: { type: 'string', maxLength: 2048 }, minItems: 1, maxItems: 8, description: '1–8 resource URIs for multi-resource authorization servers (each max 2048 chars).' },
              ],
              description: 'RFC 8707 resource indicator. Accepts a single URI string or an array of 1–8 for multi-resource authorization servers (Keycloak strict mode, AWS Cognito with multiple resource servers).',
            },
            audience: { type: 'string', description: 'Audience parameter for audience-validating authorization servers like Auth0, Okta, Azure AD (optional).' },
            auth_method: { type: 'string', enum: ['basic', 'body'], description: 'Where to put client credentials on the token request. "basic" (default, RFC 6749 §2.3.1 preferred): HTTP Basic header. "body": form fields.' },
          },
          required: ['token_endpoint', 'client_id', 'client_secret'],
        },
        protocol: { type: 'string', enum: ['mcp', 'a2a'], description: 'Protocol (default: mcp)' },
        health_check_url: { type: 'string', description: 'Optional fallback liveness URL. The dashboard probe tries the protocol handshake first; if it fails and this URL is set, the probe GETs it and treats any 2xx as "online." Used by sellers whose protocol endpoint requires auth or is path-prefixed (e.g. /adcp/mcp). Liveness only — does not populate type or tools. Pass an empty string to clear a previously-set value.' },
        organization_id: { type: 'string', description: 'Optional explicit WorkOS organization ID to save this agent under. Required when the caller belongs to multiple organizations and no selected organization context is available. The user must be an active member of this organization.' },
        organization_name: { type: 'string', description: 'Optional explicit organization name to save this agent under, for natural-language requests like "save this to my org Example Co". Must match exactly one active organization for the caller. Prefer organization_id when available.' },
      },
      required: ['agent_url', 'type'],
    },
  },
  {
    name: 'list_saved_agents',
    description:
      'List all agents saved for this organization. Shows agent URLs, names, types, and whether they have auth tokens stored (but never shows the actual tokens). Use this when users ask "what agents do I have saved?" or want to see their configured agents.',
    usage_hints: 'use for "show my agents", "what agents are saved?", "list our agents"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'remove_saved_agent',
    description:
      'Remove a saved agent and its stored auth token. Use this when users want to delete or forget an agent configuration.',
    usage_hints: 'use for "remove my agent", "delete the agent", "forget this agent"',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'Agent URL' },
      },
      required: ['agent_url'],
    },
  },
  {
    name: 'setup_test_agent',
    description:
      'Save the public AdCP test agent credentials for the user\'s organization so teammates can use them. Any logged-in user can already use the public test agent directly via evaluate_agent_quality without this step — no organization required. This is only needed for teams that want credentials stored.',
    usage_hints: 'use for "set up test agent for my team", "save test agent credentials". For "I want to try AdCP" or "test the API", prefer evaluate_agent_quality directly — it works immediately for any logged-in user. No organization or member profile required to try the test agent.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ============================================
  // GITHUB ISSUE DRAFTING
  // ============================================
  {
    name: 'draft_github_issue',
    description:
      'Draft a GitHub issue and generate a pre-filled URL for the user to create it. Use this when users report bugs, request features, or ask you to create a GitHub issue. CRITICAL: Users CANNOT see tool outputs - you MUST copy this tool\'s entire output (the GitHub link, title, body preview) into your response. Never say "click the link above" without including the actual link. The user will click the link to create the issue from their own GitHub account. All issues go to the "adcp" repository which contains the protocol, schemas, AgenticAdvertising.org server, and documentation.',
    usage_hints: 'use when user wants to report a bug or request a feature - MUST include full output in response',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (no PII - GitHub is public)' },
        repo: { type: 'string', description: 'Repo name (default: "adcp")' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'create_github_issue',
    description:
      'File a GitHub issue on adcontextprotocol/adcp authored by the logged-in user via their WorkOS Pipes GitHub connection. Use after showing the user a draft and getting their confirmation. If the user has not yet connected GitHub, the tool returns a message with a one-time Connect link AND reminds them they can ask for `draft_github_issue` instead — include that full message in your reply.',
    usage_hints: 'use after draft_github_issue when the user confirms they want the issue created. If the tool result asks the user to connect GitHub, show the full Connect link — do not silently fall back. Exception: if the user\'s message was a direct completion reply immediately after you sent them a Connect link (e.g. "connected", "just connected", "all set", "done connecting") and the tool still returns not-connected, tell them the connection may still be propagating and ask them to send the same filing request again — do not show the Connect link a second time.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (no PII - GitHub is public)' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'get_github_issue',
    description:
      'Read a GitHub issue or PR by number. Use when the user pastes a GitHub link, references "issue #1234", or asks about the status / contents of a specific RFC, epic, or PR. Returns title, body, state, labels, author, and optionally recent comments and the PR diff. Works on any public GitHub repo (forks included). PR review-thread comments (on specific diff lines) are NOT returned — only issue-style top-level comments. When the user pastes a PR link or asks for a code review, set `include_diff: true`. Do NOT use for keyword search — use list_github_issues. Do NOT use fetch_url on github.com/.../issues|pull URLs; this tool returns structured fields.',
    usage_hints: 'use when user references a specific GitHub issue or PR by number or URL; set include_diff=true when reviewing PR code',
    input_schema: {
      type: 'object',
      properties: {
        issue_number: { type: 'integer', description: 'Issue or PR number' },
        repo: { type: 'string', description: 'Repo in "owner/name" format (e.g. "adcontextprotocol/adcp", "patmmccann/adcp"). Default: "adcontextprotocol/adcp". Any public repo accepted.' },
        include_comments: { type: 'boolean', description: 'Include recent top-level comments (default: false)' },
        include_diff: { type: 'boolean', description: 'For PRs, include the unified diff (default: false). Ignored for non-PR issues.' },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'list_github_issues',
    description:
      'Search or list GitHub issues and PRs to find open items on a topic, check RFC/epic status, or answer "what is being worked on for X" questions. Pass `query` for keyword search (GitHub search syntax, but `repo:`/`org:`/`user:`/`is:` qualifiers are rejected — use the `repo` param instead). Returns title, number, state, labels, author, last-updated. Works on any public GitHub repo. Do NOT use when the user has a specific issue number — use get_github_issue.',
    usage_hints: 'use to find issues on a topic when the user has no direct link or issue number',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search (optional; GitHub issue search syntax). Do not include repo:/org:/user:/is: qualifiers.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default: "open")' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Filter by label names (no quotes or newlines)' },
        repo: { type: 'string', description: 'Repo in "owner/name" format (e.g. "adcontextprotocol/adcp", "patmmccann/adcp"). Default: "adcontextprotocol/adcp". Any public repo accepted.' },
        limit: { type: 'integer', description: 'Max results (default: 20, max: 50)' },
      },
      required: [],
    },
  },

  // ============================================
  // INDUSTRY FEED PROPOSALS
  // ============================================
  {
    name: 'propose_news_source',
    description:
      'Propose a website or RSS feed as a news source for industry monitoring. Any community member can propose sources - admins will review and approve them. Use this when someone shares a link to a relevant ad-tech, marketing, or media publication and thinks it should be monitored for news. Check for duplicates before proposing.',
    usage_hints: 'use when user shares a news link and suggests it as a source, or asks to add a publication to monitoring',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Source URL' },
        name: { type: 'string', description: 'Feed name' },
        reason: { type: 'string', description: 'Why this source is relevant' },
        category: { type: 'string', enum: ['ad-tech', 'advertising', 'marketing', 'media', 'martech', 'ctv', 'dooh', 'creator', 'ai', 'sports', 'industry', 'research'], description: 'Category' },
      },
      required: ['url'],
    },
  },

  // ============================================
  // MEMBER SEARCH / FIND HELP
  // ============================================
  {
    name: 'search_members',
    description:
      'Search for member ORGANIZATIONS (companies) that offer specific capabilities or services. Searches member names, descriptions, taglines, offerings, and tags. Use this when users want to find vendors, consultants, implementation partners, or managed services. The query should reflect what the user actually needs (e.g., "CTV measurement", "sales agent implementation") — not a generic term like "partner". Returns public member profiles with contact info.',
    usage_hints: 'use for "find someone to run a sales agent", "who can help me implement AdCP", "find a CTV partner", "looking for managed services", "need a consultant". Do NOT use for finding individual people or contacts at specific companies.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the user is looking for — use their specific need (e.g., "CTV measurement partner", "sales agent implementation"). Never use "partner" alone as the query.' },
        offerings: { type: 'array', items: { type: 'string', enum: ['buyer_agent', 'sales_agent', 'creative_agent', 'signals_agent', 'si_agent', 'governance_agent', 'publisher', 'consulting', 'other'] }, description: 'Filter by offerings' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'request_introduction',
    description:
      'Send an introduction email connecting a user with a member organization. Addie sends the email directly on behalf of the requester. Use this when a user explicitly asks to be introduced to or connected with a specific member after seeing search results.',
    usage_hints: 'use for "introduce me to X", "connect me with X", "I\'d like to talk to X", "can you put me in touch with X"',
    input_schema: {
      type: 'object',
      properties: {
        member_slug: { type: 'string', description: 'Member slug' },
        requester_name: { type: 'string', description: 'Requester name' },
        requester_email: { type: 'string', description: 'Requester email' },
        requester_company: { type: 'string', description: 'Requester company' },
        message: { type: 'string', description: 'Message to member' },
        search_query: { type: 'string', description: 'Original search query' },
        reasoning: { type: 'string', description: 'Why this member is a good fit' },
      },
      required: ['member_slug', 'requester_name', 'requester_email', 'message', 'reasoning'],
    },
  },
  {
    name: 'get_my_search_analytics',
    description:
      'Get search analytics for the user\'s member profile. Shows how many times their profile appeared in searches, profile clicks, and introduction requests. Only works for members with a public profile.',
    usage_hints: 'use for "how is my profile performing?", "how many people have seen my profile?", "search analytics", "introduction stats"',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_member_engagement',
    description:
      "Get the current user's organization engagement data: journey stage, engagement score, persona/archetype, milestone completion, and persona-based working group recommendations. Use this to understand where a member is in their journey and what actions would help them advance.",
    usage_hints: 'use when a member asks what to do next, asks about their progress or archetype, when you want to recommend working groups, or when you notice low engagement and want to suggest actions proactively',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'set_outreach_preference',
    description: `Set how often Addie sends proactive messages (tips, reminders, follow-ups). Choose a cadence or opt out entirely.`,
    usage_hints: 'use for "stop sending me messages", "unsubscribe from reminders", "opt out of outreach", "turn off notifications", "message me less", "only monthly"',
    input_schema: {
      type: 'object' as const,
      properties: {
        opt_out: {
          type: 'boolean',
          description: 'true to stop receiving proactive outreach entirely. Overrides cadence.',
        },
        cadence: {
          type: 'string',
          description: 'How often to receive proactive messages. Default = normal rules, monthly = once a month, quarterly = once every 3 months.',
          enum: ['default', 'monthly', 'quarterly'],
        },
      },
    },
  },
];
