/**
 * OpenAPI registrations for the onboarding REST surface.
 *
 * `POST /api/organizations` has existed in production for a long time but
 * has only ever been documented as a private endpoint exercised by the AAO
 * dashboard's `/onboarding` form. Surfacing it in the public spec is the
 * minimum-surface answer to the storefront-bootstrap question: a
 * third-party app holding only a user's OAuth token needs *one* documented
 * call to materialize the org, then `POST /api/me/agents` to land an agent
 * (which auto-creates the member profile on first call).
 *
 * Two fields the handler accepts but the public schema deliberately omits:
 *
 * - `membership_tier` — owned exclusively by the Stripe webhook. Accepting
 *   it from the caller would let any user stamp tier intent on their org
 *   row, leaking tier-gated UI state until/unless a real subscription
 *   overwrites the column.
 * - `corporate_domain` — server derives the value from the authenticated
 *   user's email. Accepting it as a field invited 400s when a caller's
 *   value disagreed with their email and gave nothing back when it agreed.
 *
 * Kept in its own module so the spec generator's import graph stays free
 * of route handlers (each route file's transitive imports pull in WorkOS
 * init, which fails at module load without env vars).
 */

import { z } from 'zod';
import { registry, ErrorSchema } from './registry.js';

const OrganizationCompanyTypeSchema = z
  .enum(['adtech', 'agency', 'brand', 'publisher', 'data', 'ai', 'other'])
  .openapi('OrganizationCompanyType', {
    description:
      "Coarse classification of the organization's role in the open ad ecosystem. Drives default verification badges and the member profile's display category.",
  });

const OrganizationRevenueTierSchema = z
  .enum(['under_1m', '1m_5m', '5m_50m', '50m_250m', '250m_1b', '1b_plus'])
  .openapi('OrganizationRevenueTier', {
    description:
      'Annual revenue band, USD. Drives membership-tier eligibility for company-tier seats.',
  });

const CreateOrganizationInputSchema = z
  .object({
    organization_name: z.string().min(1).max(200).openapi({
      description:
        "Display name for the organization. Used both as the org row name and (when auto-bootstrapping a member profile via the first agent registration) as the profile's `display_name`.",
      example: 'Acme Media',
    }),
    is_personal: z.boolean().optional().openapi({
      description:
        'Set to `true` to create a personal workspace instead of a corporate organization. Personal workspaces skip corporate-domain verification, are limited to one per user, and cannot host the `company_*` membership tiers.',
      default: false,
    }),
    company_type: OrganizationCompanyTypeSchema.optional(),
    revenue_tier: OrganizationRevenueTierSchema.optional(),
    marketing_opt_in: z.boolean().optional().openapi({
      description:
        'Whether the caller opted in to AAO marketing communications. Recorded once per user (not overwritten on subsequent calls). Independent of Terms-of-Service consent, which is recorded server-side from the request context.',
      default: false,
    }),
  })
  .openapi('CreateOrganizationInput', {
    description: [
      'Request body for `POST /api/organizations`.',
      "Bootstraps a WorkOS organization, mirrors the caller as `owner`, records the caller's ToS / privacy-policy acceptance, and (for non-personal orgs) inserts an email-verified record into `organization_domains` so subsequent registry calls can skip explicit domain-verification.",
      "Membership tier and corporate domain are *not* caller-supplied: the tier is set by the Stripe webhook on subscription events, and the corporate domain is derived from the authenticated user's email.",
    ].join('\n\n'),
  });

const CreateOrganizationResponseSchema = z
  .object({
    success: z.boolean().optional(),
    organization: z
      .object({
        id: z.string().openapi({ example: 'org_01HXZAB123' }),
        name: z.string().openapi({ example: 'Acme Media' }),
      })
      .optional(),
    id: z.string().optional().openapi({
      description:
        "Set on the **prospect-adoption** path: when an org with the user's email domain already exists in a `prospect` state (i.e. the registry pre-recorded it from a brand crawl but no human had claimed it yet), this call adopts that org for the caller instead of creating a new one.",
    }),
    name: z.string().optional(),
    adopted: z.boolean().optional().openapi({
      description:
        '`true` when the response is the prospect-adoption path. When `true`, no new WorkOS organization was created — the caller is now the owner of an existing prospect record.',
    }),
  })
  .openapi('CreateOrganizationResponse', {
    description:
      'Response from `POST /api/organizations`. The body shape varies by path: a fresh creation returns `{ success: true, organization: { id, name } }`; a prospect adoption returns `{ id, name, adopted: true }` directly. Both paths are 2xx; downstream callers should treat any `2xx` as "the org now exists and you are an owner of it" and read whichever id is present.',
  });

registry.registerPath({
  method: 'post',
  path: '/api/organizations',
  operationId: 'createOrganization',
  summary: 'Create or adopt my organization',
  description: [
    "Bootstrap the caller's organization. This is the **entry point for a brand-new third-party integration** — a storefront-style app holding only a user's OAuth token can call this once to materialize the org, then immediately call `POST /api/me/agents` (which auto-creates the member profile on first call) to land a registered agent. No browser redirects, no separate profile-create step required.",
    'Three outcomes depending on the caller\'s state:',
    "- **Fresh create** (most common): a new WorkOS organization is created, the caller is added as `owner`, the corporate domain is recorded as email-verified, and ToS / privacy-policy acceptance is logged from the request context. Returns `{ success: true, organization: { id, name } }`.",
    "- **Prospect adoption**: an organization with the caller's email domain already exists as a `prospect` (the registry pre-recorded it from a brand crawl but no human had claimed it yet). The caller is promoted to `owner` of the existing record instead of forking a duplicate. Returns `{ id, name, adopted: true }`.",
    '- **Already-active conflict**: the org exists and is already claimed by another paying member or a previously joined user. Returns `409` with the existing org id so the caller can switch to a join-request flow (`POST /api/organizations/:orgId/join-requests`) instead of trying to register a duplicate.',
    'Tier transitions happen via the billing flow only — there is no `membership_tier` field on this endpoint. After org creation, send the user to `POST /api/checkout-session` (or the dashboard `/membership` page) to start a subscription; the Stripe webhook is the sole writer of `organizations.membership_tier`.',
    'Rate-limited per user: `15` failed attempts per hour; successful calls do not count against the limit so a legitimate registration is never penalized by earlier validation errors.',
  ].join('\n\n'),
  tags: ['Onboarding'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: { content: { 'application/json': { schema: CreateOrganizationInputSchema } } },
  },
  responses: {
    200: {
      description:
        'Prospect adoption — an existing prospect organization for this domain was claimed by the caller. Body is `{ id, name, adopted: true }`.',
      content: { 'application/json': { schema: CreateOrganizationResponseSchema } },
    },
    201: {
      description:
        'New organization created. Body is `{ success: true, organization: { id, name } }`. The caller is the `owner`; the corporate domain is recorded as email-verified for downstream registry calls.',
      content: { 'application/json': { schema: CreateOrganizationResponseSchema } },
    },
    400: {
      description: [
        'One of:',
        '- `organization_name` missing or invalid',
        '- `company_type` / `revenue_tier` value not in the documented enum',
        "- caller is on a personal-email domain (gmail.com, yahoo.com, …) and is trying to register a corporate org — register `is_personal: true` instead",
        '- per-user organization cap reached (10 orgs per user)',
      ].join('\n'),
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    409: {
      description:
        "An active organization already exists for this caller's email domain. The body includes `existing_org_id` and `existing_org_name`; the caller should switch to the join-request flow rather than retrying.",
      content: { 'application/json': { schema: ErrorSchema } },
    },
    429: {
      description:
        'Rate limit exceeded — 15 failed attempts per hour per user. Successful calls do not count against the limit.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});
