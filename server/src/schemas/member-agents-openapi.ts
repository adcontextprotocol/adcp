/**
 * OpenAPI registrations for the per-agent REST surface at /api/me/agents.
 *
 * Kept separate from the route file so the spec generator can import this
 * without pulling in middleware/auth.ts (which instantiates WorkOS at module
 * load and refuses to run without env vars).
 */

import { z } from 'zod';
import { registry, ErrorSchema } from './registry.js';

const OrgQuerySchema = z.object({
  org: z.string().optional().openapi({
    description:
      "WorkOS organization id to act on. Defaults to the caller's primary organization. Use this from a multi-org session (or when shelling with a user JWT) to target a non-primary org. Verification goes through WorkOS membership lookup; non-members get `403`.",
    example: 'org_01HXZAB123',
  }),
});

const MemberAgentVisibilitySchema = z
  .enum(['private', 'members_only', 'public'])
  .openapi('MemberAgentVisibility', {
    description:
      "Visibility tier on the registry catalog. `private` = profile owner only; `members_only` = AAO API-tier members on operator lookup; `public` = listed in the public catalog and reflected in the org's `brand.json` (requires Professional tier or higher).",
  });

const MemberAgentTypeSchema = z
  .enum([
    'brand',
    'rights',
    'measurement',
    'governance',
    'creative',
    'sales',
    'buying',
    'signals',
    'unknown',
  ])
  .openapi('MemberAgentType', {
    description:
      "Agent type. Resolved server-side from the agent's capability snapshot when one exists; the value submitted by the client is used only as a fallback when no snapshot is available, and is never trusted to override an inferred classification.",
  });

const MemberAgentSchema = z
  .object({
    url: z.string().url().openapi({ example: 'https://agent.example.com/mcp' }),
    visibility: MemberAgentVisibilitySchema,
    name: z.string().optional(),
    type: MemberAgentTypeSchema.optional(),
    health_check_url: z.string().url().optional().openapi({
      description:
        'Optional fallback liveness URL used by the health probe when the protocol handshake fails.',
    }),
  })
  .openapi('MemberAgent', { description: 'Agent entry stored on a member profile.' });

const MemberAgentInputSchema = z
  .object({
    url: z.string().url().openapi({ example: 'https://agent.example.com/mcp' }),
    name: z.string().optional(),
    visibility: MemberAgentVisibilitySchema.optional(),
    type: MemberAgentTypeSchema.optional(),
    health_check_url: z.string().url().optional(),
  })
  .openapi('MemberAgentInput', { description: 'Request body for `POST /api/me/agents`.' });

const MemberAgentPatchSchema = z
  .object({
    name: z.string().optional(),
    visibility: MemberAgentVisibilitySchema.optional(),
    type: MemberAgentTypeSchema.optional(),
    health_check_url: z.string().url().optional(),
  })
  .openapi('MemberAgentPatch', {
    description:
      'Request body for `PATCH /api/me/agents/{url}`. The `url` field cannot be changed via PATCH; re-register at the new URL and DELETE the old entry instead.',
  });

const MemberAgentVisibilityWarningSchema = z
  .object({
    code: z.literal('visibility_downgraded'),
    agent_url: z.string(),
    requested: z.literal('public'),
    applied: z.literal('members_only'),
    reason: z.literal('tier_required'),
    message: z.string(),
  })
  .openapi('MemberAgentVisibilityWarning', {
    description: 'Emitted when the tier gate downgrades a requested visibility.',
  });

const MemberAgentResponseSchema = z
  .object({
    agent: MemberAgentSchema,
    warnings: z.array(MemberAgentVisibilityWarningSchema).optional(),
    profile_auto_created: z.boolean().optional().openapi({
      description:
        'Set to `true` when this `POST` was the first agent registration on the caller\'s organization and the server auto-created a private member profile (display name = organization name, `is_public: false`). Absent on subsequent calls and on update-in-place. Surfaced so storefront-style integrations can show the user a "we set up your profile" hint without needing to detect the prior 404 → bootstrap → retry shape.',
    }),
  })
  .openapi('MemberAgentResponse');

const MemberAgentListResponseSchema = z
  .object({
    agents: z.array(MemberAgentSchema),
  })
  .openapi('MemberAgentListResponse');

registry.registerPath({
  method: 'get',
  path: '/api/me/agents',
  operationId: 'listMemberAgents',
  summary: 'List my registered agents',
  description:
    "List the agents registered on the caller's organization member profile. Returns the same `agents[]` array stored on the profile, in the order members registered them.",
  tags: ['Member Agents'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: { query: OrgQuerySchema },
  responses: {
    200: {
      description: 'Registered agents',
      content: { 'application/json': { schema: MemberAgentListResponseSchema } },
    },
    400: {
      description: 'No organization associated with this account',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        '`?org=` was supplied but the caller is not a member of that organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description:
        'No member profile exists yet. Either call `POST /api/me/agents` to register your first agent (the profile is auto-created on first call) or `POST /api/me/member-profile` to create the profile explicitly.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/me/agents',
  operationId: 'registerMemberAgent',
  summary: 'Register an agent',
  description: [
    "Register an agent on the caller's organization member profile.",
    'Idempotent on `url`: re-posting the same `url` updates the entry in place rather than creating a duplicate. New entries return `201`; updates return `200`.',
    'If the caller\'s organization does not yet have a member profile, this endpoint **auto-creates a private profile** (display name = organization name, `is_public: false`) before registering the agent — the response includes `profile_auto_created: true` so callers can show a "profile set up" hint. To customize `display_name`, `slug`, `tagline`, etc. before adding any agents, call `POST /api/me/member-profile` first; otherwise this auto-bootstrap is the recommended path for storefront-style integrations.',
    "The `type` field is resolved server-side from the agent's capability snapshot — a client cannot pin a misclassification (e.g. registering a sales agent as `buying`).",
    '`visibility: "public"` requires Professional tier or higher and a `primary_brand_domain` set on the profile. Non-API-tier callers who request `public` will have the entry stored as `members_only` instead, and the response will include a `visibility_downgraded` warning describing the coercion.',
  ].join('\n\n'),
  tags: ['Member Agents'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: OrgQuerySchema,
    body: { content: { 'application/json': { schema: MemberAgentInputSchema } } },
  },
  responses: {
    200: {
      description: 'Agent already registered at this `url`; entry updated in place.',
      content: { 'application/json': { schema: MemberAgentResponseSchema } },
    },
    201: {
      description:
        'Agent registered. When this is the first agent on a freshly created organization, the response includes `profile_auto_created: true`.',
      content: { 'application/json': { schema: MemberAgentResponseSchema } },
    },
    400: {
      description:
        'Missing or invalid `url`, or no organization associated with this account. (When the caller has no organization at all, create one first with `POST /api/organizations`.)',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        '`?org=` was supplied but the caller is not a member of that organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description:
        'Auto-bootstrap failed (e.g. the organization has no name yet). Call `POST /api/me/member-profile` to create a profile explicitly, then retry.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    429: {
      description: 'Rate limit exceeded',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/me/agents/{url}',
  operationId: 'updateMemberAgent',
  summary: 'Update an agent',
  description:
    'Update one registered agent identified by its `url`. The `url` field itself cannot be changed via PATCH — supplying a `url` in the body that differs from the path returns `400 url_immutable`; re-register at the new URL and DELETE the old entry to migrate. All other fields accept partial updates.',
  tags: ['Member Agents'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: OrgQuerySchema,
    params: z.object({
      url: z.string().openapi({
        description:
          "The agent's `url`, URL-encoded (e.g. `https%3A%2F%2Fagent.example.com%2Fmcp`).",
      }),
    }),
    body: { content: { 'application/json': { schema: MemberAgentPatchSchema } } },
  },
  responses: {
    200: {
      description: 'Agent updated.',
      content: { 'application/json': { schema: MemberAgentResponseSchema } },
    },
    400: {
      description:
        'No organization associated with this account, or `body.url` differs from the path (`url_immutable`).',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        '`?org=` was supplied but the caller is not a member of that organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description: 'No member profile, or no agent registered at the given `url`.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/me/agents/{url}',
  operationId: 'removeMemberAgent',
  summary: 'Remove an agent',
  description: [
    'Remove one registered agent identified by its `url`.',
    'A currently-`public` agent is reflected in the published `brand.json` manifest. To prevent the registry catalog and `brand.json` from silently disagreeing, this endpoint returns `409 unpublish_first` when the agent is `public` — `PATCH /api/me/agents/{url}` with `visibility: "private"` first (or call `DELETE /api/me/member-profile/agents/{index}/publish` to reconcile the manifest), then re-issue the DELETE.',
  ].join('\n\n'),
  tags: ['Member Agents'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    query: OrgQuerySchema,
    params: z.object({
      url: z.string().openapi({
        description:
          "The agent's `url`, URL-encoded (e.g. `https%3A%2F%2Fagent.example.com%2Fmcp`).",
      }),
    }),
  },
  responses: {
    204: { description: 'Agent removed.' },
    400: {
      description: 'No organization associated with this account',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        '`?org=` was supplied but the caller is not a member of that organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description: 'No member profile, or no agent registered at the given `url`.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    409: {
      description:
        'Agent is currently `public` and reflected in `brand.json`; unpublish first.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
});
