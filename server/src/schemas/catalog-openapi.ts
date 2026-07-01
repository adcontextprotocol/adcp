/**
 * OpenAPI registrations for the property-catalog fact-contribution surface
 * (`/api/registry/resolve` and the dispute endpoints), served by
 * `routes/catalog-api.ts`.
 *
 * Kept separate from the route file — the same reason as member-agents-openapi.ts
 * — so the spec generator can import these registrations without pulling in the
 * route factory's runtime dependencies. Schemas mirror the Zod validators and
 * result types in `routes/catalog-api.ts` / `db/catalog-db.ts` /
 * `services/catalog-governance.ts`. This makes the "send us facts" surface part
 * of the typed OpenAPI contract, so SDK clients can generate against it.
 */

import { z } from 'zod';
import { registry, ErrorSchema } from './registry.js';

// ── Shared shapes ───────────────────────────────────────────────

const CatalogIdentifierSchema = z
  .object({
    type: z.string().openapi({ example: 'domain' }),
    value: z.string().openapi({ example: 'nytimes.com' }),
  })
  .openapi('CatalogIdentifier');

const FactProvenanceSchema = z
  .object({
    type: z.enum([
      'agency_allowlist',
      'publisher_declaration',
      'impression_log',
      'ssp_inventory',
      'deal_history',
      'crawl',
      'data_partner',
      'member_assertion',
    ]).openapi({
      description:
        'How the caller knows these identifiers — the trust/audit envelope on the fact. Determines the confidence the catalog assigns. `crawl` is reserved for server-side pipelines; callers use the others.',
    }),
    context: z.string().optional().openapi({ example: 'unilever_q3', description: 'Optional free-text annotation (campaign, dataset).' }),
  })
  .openapi('FactProvenance');

// ── POST /api/registry/resolve ──────────────────────────────────

const ResolveRequestSchema = z.object({
  identifiers: z.array(CatalogIdentifierSchema).min(1).max(10000).openapi({
    description: 'Identifiers to resolve (and, in resolve mode, contribute). Max 10,000 per call for all callers.',
  }),
  provenance: FactProvenanceSchema,
  mode: z.enum(['resolve', 'lookup']).default('resolve').openapi({
    description:
      "`resolve` (default) contributes the identifiers, auto-creates missing catalog entries, logs demand activity, and returns rids — requires authentication. `lookup` is a pure read: no write, no activity log, no auth.",
  }),
}).openapi('ResolveRequest');

const ResolvedEntrySchema = z.object({
  identifier: CatalogIdentifierSchema,
  property_rid: z.string().nullable().openapi({
    description: 'Stable catalog handle for joining/dedup and TMP matching. NOT an authorization credential. `null` for excluded (ad_infra / publisher_mask) or unresolved-in-lookup identifiers.',
  }),
  classification: z.string().openapi({ example: 'property' }),
  status: z.enum(['existing', 'created', 'excluded']),
  source: z.string().nullable(),
}).openapi('ResolvedEntry');

const ResolveResponseSchema = z.object({
  resolved: z.array(ResolvedEntrySchema),
  summary: z.object({
    total: z.number().int(),
    resolved: z.number().int(),
    created: z.number().int(),
    excluded: z.number().int(),
    not_found: z.number().int(),
  }),
  server_timestamp: z.string(),
}).openapi('ResolveResponse');

registry.registerPath({
  method: 'post',
  path: '/api/registry/resolve',
  operationId: 'resolveIdentifiers',
  summary: 'Resolve identifiers to property_rids (and contribute them)',
  description:
    'The primary fact-contribution path. Takes identifiers plus a provenance envelope and returns stable `property_rid`s. In `resolve` mode (default) it auto-creates missing catalog entries and logs demand activity — so resolving your own identifier list IS the contribution. `property_rid` is a non-authoritative join/match handle, never an authorization credential. Re-resolving is idempotent on the identifier→rid mapping but additive on the activity log.',
  tags: ['Property Catalog'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: { content: { 'application/json': { schema: ResolveRequestSchema } } },
  },
  responses: {
    200: { description: 'Resolve/lookup result', content: { 'application/json': { schema: ResolveResponseSchema } } },
    400: { description: 'Invalid request (bad identifiers, unknown provenance type, batch > 10,000)', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Authentication required for resolve mode', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

// ── POST /api/registry/catalog/disputes ─────────────────────────

const DisputeRequestSchema = z.object({
  dispute_type: z.enum(['identifier_link', 'classification', 'property_data', 'false_merge']),
  subject_type: z.string().openapi({ example: 'identifier', description: 'What is being disputed — e.g. `identifier` or `property_rid`.' }),
  subject_value: z.string().openapi({ example: 'com.example.app' }),
  claim: z.string().min(10).max(2000).openapi({ description: 'The dispute claim (10–2000 chars).' }),
  evidence: z.string().max(5000).optional().openapi({ description: 'Optional supporting evidence (≤5000 chars).' }),
}).openapi('CatalogDisputeRequest');

const DisputeTriageResultSchema = z.object({
  dispute_id: z.string(),
  action_taken: z.enum(['link_suspended', 'queued_for_review', 'escalated']).openapi({
    description: 'What filing the dispute did: a medium/weak link is suspended immediately; otherwise the dispute is queued or escalated for review.',
  }),
  reason: z.string(),
}).openapi('CatalogDisputeTriageResult');

registry.registerPath({
  method: 'post',
  path: '/api/registry/catalog/disputes',
  operationId: 'fileCatalogDispute',
  summary: 'Dispute a catalog fact',
  description:
    "Challenge or correct a catalog claim — the community disavow/challenge verb. Adding links is hard; suspending suspicious ones is easy: a disputed medium/weak link is suspended immediately (`action_taken: 'link_suspended'`); stronger claims queue for review. Poll status with getCatalogDispute.",
  tags: ['Property Catalog'],
  security: [{ bearerAuth: [] }, { oauth2: [] }],
  request: {
    body: { content: { 'application/json': { schema: DisputeRequestSchema } } },
  },
  responses: {
    200: { description: 'Dispute filed and triaged', content: { 'application/json': { schema: DisputeTriageResultSchema } } },
    400: { description: 'Invalid dispute request', content: { 'application/json': { schema: ErrorSchema } } },
    401: { description: 'Authentication required', content: { 'application/json': { schema: ErrorSchema } } },
  },
});

// ── GET /api/registry/catalog/disputes/{id} ─────────────────────

const DisputeRecordSchema = z.object({
  id: z.string(),
  dispute_type: z.enum(['identifier_link', 'classification', 'property_data', 'false_merge']),
  subject_type: z.string(),
  subject_value: z.string(),
  claim: z.string(),
  evidence: z.string().nullable().optional(),
  status: z.string().openapi({ example: 'suspended', description: 'Current dispute status.' }),
  created_at: z.string(),
}).passthrough().openapi('CatalogDisputeRecord');

registry.registerPath({
  method: 'get',
  path: '/api/registry/catalog/disputes/{id}',
  operationId: 'getCatalogDispute',
  summary: 'Get a catalog dispute',
  description: 'Fetch the current state of a filed dispute by id.',
  tags: ['Property Catalog'],
  request: {
    params: z.object({ id: z.string().openapi({ example: '019539a0-b1c2-7d3e-8f4a-5b6c7d8e9f0a' }) }),
  },
  responses: {
    200: { description: 'Dispute record', content: { 'application/json': { schema: DisputeRecordSchema } } },
    404: { description: 'Dispute not found', content: { 'application/json': { schema: ErrorSchema } } },
  },
});
