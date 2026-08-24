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
  org: z.string().openapi({
    description:
      'Explicit WorkOS organization id to act on. Required on every request. Verification uses the exact authenticated credential; identity linkage and primary organizations are not authorization inputs.',
    example: 'org_01HXZAB123',
  }),
});

const MemberAgentVisibilitySchema = z
  .enum(['private', 'members_only', 'public'])
  .openapi('MemberAgentVisibility', {
    description:
      "Visibility tier on the registry catalog. `private` = profile owner only; `members_only` = AAO API-tier members on operator lookup; `public` = listed in the public catalog and reflected in the org's `brand.json` (requires a paid AAO tier — Professional, Builder, Member, or Leader).",
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
      "Agent type as stored on the registry. Server-side smuggle protection compares the caller's declaration against the capability snapshot (when one exists) and may stamp `unknown` if the snapshot contradicts the declaration without classifying it. `unknown` is reserved for that server-side outcome; clients cannot submit it.",
  });

const MemberAgentTypeInputSchema = z
  .enum([
    'brand',
    'rights',
    'measurement',
    'governance',
    'creative',
    'sales',
    'buying',
    'signals',
  ])
  .openapi('MemberAgentTypeInput', {
    description:
      "Agent type the caller declares. Required on register; smuggle-protection still cross-checks against the capability snapshot when one exists. The server never infers `type` — the owner declares what kind of agent this is.",
  });

const MemberAgentSchema = z
  .object({
    url: z.string().url().openapi({ example: 'https://agent.example.com/mcp' }),
    visibility: MemberAgentVisibilitySchema,
    type: MemberAgentTypeSchema,
    name: z.string().optional(),
    health_check_url: z.string().url().optional().openapi({
      description:
        'Optional fallback liveness URL used by the health probe when the protocol handshake fails.',
    }),
  })
  .openapi('MemberAgent', {
    description:
      "Agent entry stored on a member profile. `type` is required on read because every write surface declares it and the operator endpoint always emits it; a stored value of `unknown` is the smuggle-protection outcome (snapshot contradicted the declaration without classifying it) and is the only path that surfaces an agent without a real type.",
  });

const MemberAgentInputSchema = z
  .object({
    url: z.string().url().openapi({ example: 'https://agent.example.com/mcp' }),
    type: MemberAgentTypeInputSchema,
    name: z.string().optional(),
    visibility: MemberAgentVisibilitySchema.optional(),
    health_check_url: z.string().url().optional(),
  })
  .openapi('MemberAgentInput', { description: 'Request body for `POST /api/me/agents`. `type` is required — the owner declares it; the server never infers.' });

const MemberAgentPatchSchema = z
  .object({
    name: z.string().optional(),
    visibility: MemberAgentVisibilitySchema.optional(),
    type: MemberAgentTypeInputSchema.optional(),
    health_check_url: z.string().url().optional(),
  })
  .openapi('MemberAgentPatch', {
    description:
      'Request body for `PATCH /api/me/agents/{url}`. The `url` field cannot be changed via PATCH; re-register at the new URL and DELETE the old entry instead. If `type` is omitted, the existing value is preserved.',
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
        'Set to `true` when this `POST` was the first agent registration on the caller\'s organization and the server auto-created a private member profile (display name = organization name, `is_public: false`). Absent on subsequent calls and on update-in-place. Surfaced so storefront-style integrations can show a "we set up your profile" hint without needing to detect the prior 404 → bootstrap → retry shape.',
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
      description: 'The required `org` query parameter is missing.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        'The exact authenticated credential is not authorized for the selected organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description:
        'No member profile exists yet — create one via `POST /api/me/member-profile`.',
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
    'The `org` query parameter is required. If the selected organization has no member profile, the server creates a private profile (display name = organization name, `is_public: false`) and includes `profile_auto_created: true`.',
    "`type` is required and declared by the caller — the server does not infer it. Server-side smuggle protection still cross-checks the declared type against the agent's capability snapshot when one exists; if the snapshot contradicts the declaration without classifying it, the stored value is `unknown` and the dashboard surfaces the conflict for the owner to resolve.",
    '`visibility: "public"` requires a paid AAO tier (Professional, Builder, Member, or Leader) and a verified primary domain on the organization (set via the Linked Domains UI). Non-API-tier callers (Explorer or no tier) who request `public` will have the entry stored as `members_only` instead, and the response will include a `visibility_downgraded` warning describing the coercion.',
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
        'Missing required `org`, missing or invalid `url`, or missing/invalid `type`.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        'The exact authenticated credential is not authorized for the selected organization.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    404: {
      description:
        'No member profile exists and a private profile could not be created.',
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
        'The required `org` query parameter is missing, or `body.url` differs from the path (`url_immutable`).',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        'The exact authenticated credential is not authorized for the selected organization.',
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
      description: 'The required `org` query parameter is missing.',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    401: {
      description: 'Authentication required',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    403: {
      description:
        'The exact authenticated credential is not authorized for the selected organization.',
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
