/**
 * Audience handlers for the training agent.
 *
 * Implements sync_audiences per AdCP schemas. Backed by an in-process
 * per-session store so create_media_buy can verify audience_include /
 * audience_exclude entries reference audiences the buyer registered.
 *
 * Mirrors the catalog-event-handlers.ts pattern (sync_event_sources +
 * findEventSourceInSession) — the rejection contract for unregistered
 * audience_ids is the audience-side sibling of the event-source contract
 * asserted in performance_buy_flow (#4642 / #4654).
 */

import { randomUUID } from 'node:crypto';
import { atLeastAdcpVersion, type TrainingContext, type ToolArgs } from './types.js';
import { sessionKeyFromArgs } from './state.js';
import { TRAINING_AUDIENCE_ACTIVATION_METHODS } from './product-factory.js';

// ── Types ────────────────────────────────────────────────────────

interface SyncAudiencesInput extends ToolArgs {
  audiences?: AudienceInput[];
  delete_missing?: boolean;
  idempotency_key?: string;
}

interface AudienceMemberInput {
  external_id?: string;
  hashed_email?: string;
  hashed_phone?: string;
  uids?: { type: string; value: string }[];
  [key: string]: unknown;
}

interface AudienceInput {
  audience_id: string;
  name?: string;
  description?: string;
  audience_type?: 'crm' | 'suppression' | 'lookalike_seed';
  tags?: string[];
  add?: AudienceMemberInput[];
  remove?: AudienceMemberInput[];
  source?: AudienceSourceInput;
  delete?: boolean;
  consent_basis?: string;
}

interface AudienceVendorRef {
  domain: string;
  brand_id?: string;
  countries?: string[];
  industries?: string[];
  data_subject_contestation?: Record<string, unknown>;
  brand_kit_override?: Record<string, unknown>;
}

interface AudienceSourceBase {
  vendor: AudienceVendorRef;
}

interface DatasetAudienceSourceInput extends AudienceSourceBase {
  kind: 'dataset';
  locator: string;
  access_expires_at?: string;
}

interface PlatformSegmentAudienceSourceInput extends AudienceSourceBase {
  kind: 'platform_segment';
  segment_ref: string;
}

type AudienceSourceInput = DatasetAudienceSourceInput | PlatformSegmentAudienceSourceInput;

interface AudienceSourceState {
  kind: 'dataset' | 'platform_segment';
  vendor: AudienceVendorRef;
  locator?: string;
  segment_ref?: string;
  columns_read?: string[];
  access_status: 'active' | 'unavailable';
}

export type TrainingAudienceStatus = 'processing' | 'ready' | 'too_small' | 'suspended';

interface AudienceState {
  audienceId: string;
  name: string;
  sellerId: string;
  uploadedCount: number;
  matchedCount: number;
  status: TrainingAudienceStatus;
  statusReason?: string;
  audienceType: string;
  createdAt: string;
  lastSyncedAt: string;
  source?: AudienceSourceState;
}

const audienceStore = new Map<string, Map<string, AudienceState>>();

function getAudienceMap(sessionKey: string): Map<string, AudienceState> {
  let map = audienceStore.get(sessionKey);
  if (!map) {
    map = new Map();
    audienceStore.set(sessionKey, map);
  }
  return map;
}

/** Look up an audience in the exact authorized account session.
 *  Used by create_media_buy to validate that targeting_overlay.audience_include
 *  and audience_exclude entries reference audiences registered via sync_audiences,
 *  rather than silently accepting phantom ids. Never scan other sessions: an
 *  audience_id is buyer-chosen and is not globally unique or globally readable. */
export function findAudienceInSession(sessionKey: string, audienceId: string): AudienceState | undefined {
  return audienceStore.get(sessionKey)?.get(audienceId);
}

/** Apply a deterministic lifecycle transition for comply_test_controller.
 * Returns the prior state, or undefined when the audience is unknown. */
export function forceAudienceStatusInSession(
  sessionKey: string,
  audienceId: string,
  status: TrainingAudienceStatus,
  reason?: string,
): { previous: TrainingAudienceStatus; current: TrainingAudienceStatus } | undefined {
  const audience = findAudienceInSession(sessionKey, audienceId);
  if (!audience) return undefined;
  const previous = audience.status;
  audience.status = status;
  audience.statusReason = status === 'suspended' ? reason : undefined;
  audience.lastSyncedAt = new Date().toISOString();
  return { previous, current: status };
}

/** Exported for testing */
export function clearAudienceStore(): void {
  audienceStore.clear();
}

// ── Shared schema fragment ───────────────────────────────────────

const ACCOUNT_REF_SCHEMA = {
  type: 'object',
  oneOf: [
    { properties: { account_id: { type: 'string' } }, required: ['account_id'] },
    {
      properties: {
        brand: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] },
        operator: { type: 'string' },
        sandbox: { type: 'boolean' },
      },
      required: ['brand'],
    },
  ],
};

const AUDIENCE_VENDOR_SCHEMA = {
  type: 'object',
  properties: {
    domain: {
      type: 'string',
      pattern: '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$',
    },
    brand_id: { type: 'string', pattern: '^[a-z0-9_]+$' },
    countries: {
      type: 'array',
      items: { type: 'string', pattern: '^[A-Z]{2}$' },
      minItems: 1,
      uniqueItems: true,
    },
    industries: { type: 'array', items: { type: 'string' } },
    data_subject_contestation: { type: 'object' },
    brand_kit_override: { type: 'object' },
  },
  required: ['domain'],
  additionalProperties: false,
};

// ── Tool definition ─────────────────────────────────────────────

export const AUDIENCE_TOOLS = [
  {
    name: 'sync_audiences',
    description: 'Manage CRM-based audiences on an account with upsert semantics. Membership is supplied either as inline add/remove deltas or through an externally sourced dataset or platform segment. Omit audiences for discovery-only.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execution: { taskSupport: 'forbidden' as const },
    inputSchema: {
      type: 'object' as const,
      properties: {
        account: ACCOUNT_REF_SCHEMA,
        audiences: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              audience_id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              audience_type: { type: 'string', enum: ['crm', 'suppression', 'lookalike_seed'] },
              tags: { type: 'array', items: { type: 'string' } },
              add: { type: 'array' },
              remove: { type: 'array' },
              source: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', const: 'dataset' },
                      vendor: AUDIENCE_VENDOR_SCHEMA,
                      locator: { type: 'string', minLength: 1, maxLength: 512 },
                      access_expires_at: { type: 'string', format: 'date-time' },
                    },
                    required: ['kind', 'vendor', 'locator'],
                    additionalProperties: false,
                  },
                  {
                    type: 'object',
                    properties: {
                      kind: { type: 'string', const: 'platform_segment' },
                      vendor: AUDIENCE_VENDOR_SCHEMA,
                      segment_ref: { type: 'string', minLength: 1, maxLength: 256 },
                    },
                    required: ['kind', 'vendor', 'segment_ref'],
                    additionalProperties: false,
                  },
                ],
              },
              delete: { type: 'boolean' },
              consent_basis: { type: 'string' },
            },
            required: ['audience_id'],
            allOf: [
              { not: { required: ['source', 'add'] } },
              { not: { required: ['source', 'remove'] } },
            ],
          },
          minItems: 1,
        },
        delete_missing: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['account', 'idempotency_key'],
    },
  },
];

/** First immutable release line containing core/audience-source.json. */
const EXTERNAL_AUDIENCE_SOURCE_ADCP_VERSION = '3.2-beta.7';
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const BRAND_ID_PATTERN = /^[a-z0-9_]+$/;
const AUDIENCE_VENDOR_KEYS = new Set([
  'domain',
  'brand_id',
  'countries',
  'industries',
  'data_subject_contestation',
  'brand_kit_override',
]);
const CREDENTIAL_KEY_NAMES = new Set([
  'auth',
  'authorization',
  'bearer',
  'apikey',
  'xapikey',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secret',
  'secretkey',
  'password',
  'credential',
  'credentials',
  'privatekey',
  'publickey',
  'signingkey',
  'jwk',
  'jwks',
  'jwksuri',
  'token',
  'cookie',
  'setcookie',
  'sessionid',
  'oauthcode',
  'oauthverifier',
  'jwt',
  'signature',
  'sig',
  'key',
]);
const CREDENTIAL_KEY_SUFFIXES = [
  'apikey',
  'accesskey',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'secretkey',
  'privatekey',
  'publickey',
  'signingkey',
  'credential',
  'credentials',
  'token',
  'signature',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CREDENTIAL_KEY_NAMES.has(normalized)
    || CREDENTIAL_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function credentialBearingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return true;
  const queryKeys = [...url.searchParams.keys()];
  const fragmentKeys = url.hash.startsWith('#')
    ? [...new URLSearchParams(url.hash.slice(1)).keys()]
    : [];
  return [...queryKeys, ...fragmentKeys].some(isCredentialKey);
}

function containsCredentialMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^\s*(?:Bearer|Basic)\s+\S+/i.test(value)
      || /-----BEGIN (?:[A-Z0-9 ]*(?:PRIVATE|PUBLIC) KEY|CERTIFICATE)-----/i.test(value)
      || credentialBearingUrl(value);
  }
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (!isRecord(value)) return false;
  if (typeof value.kty === 'string') return true;
  return Object.entries(value).some(([key, nested]) => (
    isCredentialKey(key)
    || containsCredentialMaterial(nested)
  ));
}

function supportsExternalAudienceSource(servedVersion: string | undefined): boolean {
  return atLeastAdcpVersion(servedVersion, EXTERNAL_AUDIENCE_SOURCE_ADCP_VERSION);
}

type CanonicalSourceResult =
  | { ok: true; source: AudienceSourceInput }
  | { ok: false; field: string; message: string };

/**
 * Build a new source object from the closed canonical wire vocabulary. Never
 * retain or echo the caller's object wholesale: doing so would let properties
 * that escaped an adapter's JSON-schema validation become durable state.
 */
function canonicalAudienceSource(value: unknown): CanonicalSourceResult {
  if (!isRecord(value) || (value.kind !== 'dataset' && value.kind !== 'platform_segment')) {
    return { ok: false, field: 'source.kind', message: 'source.kind must be dataset or platform_segment.' };
  }
  if (!isRecord(value.vendor)) {
    return { ok: false, field: 'source.vendor', message: 'source.vendor must be a canonical BrandRef.' };
  }
  const unknownVendorKey = Object.keys(value.vendor).find(key => !AUDIENCE_VENDOR_KEYS.has(key));
  if (unknownVendorKey) {
    return { ok: false, field: 'source.vendor', message: 'source.vendor contains a field outside canonical BrandRef.' };
  }
  if (typeof value.vendor.domain !== 'string' || !DOMAIN_PATTERN.test(value.vendor.domain)) {
    return { ok: false, field: 'source.vendor.domain', message: 'source.vendor.domain must be a valid lowercase domain.' };
  }
  if (value.vendor.brand_id !== undefined
    && (typeof value.vendor.brand_id !== 'string' || !BRAND_ID_PATTERN.test(value.vendor.brand_id))) {
    return { ok: false, field: 'source.vendor.brand_id', message: 'source.vendor.brand_id must be lowercase alphanumeric with underscores.' };
  }
  if (value.vendor.countries !== undefined
    && (!Array.isArray(value.vendor.countries)
      || value.vendor.countries.length === 0
      || !value.vendor.countries.every(country => typeof country === 'string' && /^[A-Z]{2}$/.test(country))
      || new Set(value.vendor.countries).size !== value.vendor.countries.length)) {
    return { ok: false, field: 'source.vendor.countries', message: 'source.vendor.countries must contain unique ISO alpha-2 codes.' };
  }
  if (value.vendor.industries !== undefined
    && (!Array.isArray(value.vendor.industries) || !value.vendor.industries.every(industry => typeof industry === 'string'))) {
    return { ok: false, field: 'source.vendor.industries', message: 'source.vendor.industries must be an array of strings.' };
  }
  if (value.vendor.data_subject_contestation !== undefined && !isRecord(value.vendor.data_subject_contestation)) {
    return { ok: false, field: 'source.vendor.data_subject_contestation', message: 'source.vendor.data_subject_contestation must be an object.' };
  }
  if (value.vendor.brand_kit_override !== undefined && !isRecord(value.vendor.brand_kit_override)) {
    return { ok: false, field: 'source.vendor.brand_kit_override', message: 'source.vendor.brand_kit_override must be an object.' };
  }

  const vendor: AudienceVendorRef = {
    domain: value.vendor.domain,
    ...(typeof value.vendor.brand_id === 'string' && { brand_id: value.vendor.brand_id }),
    ...(Array.isArray(value.vendor.countries) && { countries: structuredClone(value.vendor.countries) as string[] }),
    ...(Array.isArray(value.vendor.industries) && { industries: structuredClone(value.vendor.industries) as string[] }),
    ...(isRecord(value.vendor.data_subject_contestation) && {
      data_subject_contestation: structuredClone(value.vendor.data_subject_contestation),
    }),
    ...(isRecord(value.vendor.brand_kit_override) && {
      brand_kit_override: structuredClone(value.vendor.brand_kit_override),
    }),
  };

  if (value.kind === 'dataset') {
    const unknownKey = Object.keys(value).find(key => !['kind', 'vendor', 'locator', 'access_expires_at'].includes(key));
    if (unknownKey) return { ok: false, field: 'source', message: 'Dataset source contains an unknown field.' };
    if (typeof value.locator !== 'string' || value.locator.length === 0 || value.locator.length > 512) {
      return { ok: false, field: 'source.locator', message: 'source.locator must contain 1-512 characters.' };
    }
    if (value.access_expires_at !== undefined
      && (typeof value.access_expires_at !== 'string' || Number.isNaN(Date.parse(value.access_expires_at)))) {
      return { ok: false, field: 'source.access_expires_at', message: 'source.access_expires_at must be an ISO 8601 date-time.' };
    }
    return {
      ok: true,
      source: {
        kind: 'dataset',
        vendor,
        locator: value.locator,
        ...(typeof value.access_expires_at === 'string' && { access_expires_at: value.access_expires_at }),
      },
    };
  }

  const unknownKey = Object.keys(value).find(key => !['kind', 'vendor', 'segment_ref'].includes(key));
  if (unknownKey) return { ok: false, field: 'source', message: 'Platform-segment source contains an unknown field.' };
  if (typeof value.segment_ref !== 'string' || value.segment_ref.length === 0 || value.segment_ref.length > 256) {
    return { ok: false, field: 'source.segment_ref', message: 'source.segment_ref must contain 1-256 characters.' };
  }
  return { ok: true, source: { kind: 'platform_segment', vendor, segment_ref: value.segment_ref } };
}

function externalSourceSupported(source: AudienceSourceInput): boolean {
  const pattern = source.kind === 'dataset' ? 'dataset_query' : 'platform_distribution';
  return TRAINING_AUDIENCE_ACTIVATION_METHODS.some(method =>
    method.pattern === pattern
    && (!('vendor' in method) || method.vendor.domain === source.vendor.domain),
  );
}

function sourceStateFromInput(source: AudienceSourceInput): AudienceSourceState {
  if (source.kind === 'dataset') {
    return {
      kind: source.kind,
      vendor: structuredClone(source.vendor),
      locator: source.locator,
      columns_read: ['external_id', 'hashed_email'],
      access_status: 'active',
    };
  }
  return {
    kind: source.kind,
    vendor: structuredClone(source.vendor),
    segment_ref: source.segment_ref,
    access_status: 'active',
  };
}

function sourceResponse(
  source: AudienceSourceState | undefined,
  servedVersion: string | undefined,
): AudienceSourceState | undefined {
  return source && supportsExternalAudienceSource(servedVersion) ? structuredClone(source) : undefined;
}

// ── Handler implementation ──────────────────────────────────────

export async function handleSyncAudiences(args: ToolArgs, ctx: TrainingContext) {
  const req = args as unknown as SyncAudiencesInput;

  if (!req.account) {
    return {
      errors: [{ code: 'INVALID_REQUEST', message: 'account is required' }],
    };
  }

  const sessionKey = sessionKeyFromArgs(req, ctx.mode, ctx.userId, ctx.moduleId);
  const audiences = getAudienceMap(sessionKey);
  const now = new Date().toISOString();

  // Credential-bearing requests fail atomically before any audience is
  // mutated. The error deliberately identifies only the structural field and
  // never repeats the secret-bearing key or value.
  const credentialSourceIndex = req.audiences?.findIndex(audience => (
    audience.source !== undefined && containsCredentialMaterial(audience.source)
  ));
  if (credentialSourceIndex !== undefined && credentialSourceIndex >= 0) {
    return {
      errors: [{
        code: 'CREDENTIAL_IN_ARGS',
        field: `audiences[${credentialSourceIndex}].source`,
        message: 'Audience source references must not contain credential or trust material; configure access on the vendor transport.',
      }],
    };
  }

  // Discovery mode — return existing audiences without mutation.
  if (!req.audiences) {
    const existing = Array.from(audiences.values()).map(a => {
      const projectedSource = sourceResponse(a.source, ctx.servedAdcpVersion);
      return {
        audience_id: a.audienceId,
        name: a.name,
        seller_id: a.sellerId,
        action: 'unchanged',
        status: a.status,
        ...(a.statusReason && { reason: a.statusReason }),
        uploaded_count: 0,
        total_uploaded_count: a.uploadedCount,
        matched_count: a.matchedCount,
        ...(a.uploadedCount > 0 && {
          effective_match_rate: a.matchedCount / a.uploadedCount,
        }),
        last_synced_at: a.lastSyncedAt,
        ...(projectedSource && { source: projectedSource }),
      };
    });
    return { audiences: existing };
  }

  const results: Record<string, unknown>[] = [];

  for (const input of req.audiences) {
    if (!input.audience_id) {
      results.push({
        audience_id: 'unknown',
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', message: 'audience_id is required' }],
      });
      continue;
    }

    const existing = audiences.get(input.audience_id);

    if (input.delete === true) {
      if (existing) audiences.delete(input.audience_id);
      results.push({
        audience_id: input.audience_id,
        action: 'deleted',
      });
      continue;
    }

    if (input.source && !supportsExternalAudienceSource(ctx.servedAdcpVersion)) {
      results.push({
        audience_id: input.audience_id,
        action: 'failed',
        errors: [{
          code: 'UNSUPPORTED_FEATURE',
          field: 'source',
          message: `External audience sources require AdCP ${EXTERNAL_AUDIENCE_SOURCE_ADCP_VERSION} or later.`,
        }],
      });
      continue;
    }

    const canonicalSource = input.source ? canonicalAudienceSource(input.source) : undefined;
    if (canonicalSource && !canonicalSource.ok) {
      results.push({
        audience_id: input.audience_id,
        action: 'failed',
        errors: [{ code: 'INVALID_REQUEST', field: canonicalSource.field, message: canonicalSource.message }],
      });
      continue;
    }
    const source = canonicalSource?.source;

    const suppliesInlineMembers = input.add !== undefined || input.remove !== undefined;
    const changesTransport = existing !== undefined
      && (source !== undefined || suppliesInlineMembers)
      && (existing.source !== undefined) !== (source !== undefined);
    if (changesTransport) {
      results.push({
        audience_id: input.audience_id,
        action: 'failed',
        errors: [{
          code: 'CONFLICT',
          field: 'audience_id',
          message: 'Audience transport is fixed at creation; delete and recreate the audience to change transport.',
        }],
      });
      continue;
    }

    if (source && !externalSourceSupported(source)) {
      results.push({
        audience_id: input.audience_id,
        action: 'failed',
        errors: [{
          code: 'UNSUPPORTED_FEATURE',
          field: 'source.kind',
          message: `External audience source ${source.kind} is not declared by this seller.`,
        }],
      });
      continue;
    }

    // External sources model one successful read of a stable shared dataset.
    // Inline sources keep the existing deterministic ~70% match simulation.
    const uploadedThisCall = source ? 240 : (input.add?.length ?? 0);
    const matchedThisCall = source ? 168 : Math.floor(uploadedThisCall * 0.7);
    const preservesSourcedCounts = existing?.source !== undefined && source === undefined;
    const totalUploaded = source
      ? uploadedThisCall
      : preservesSourcedCounts ? existing.uploadedCount : (existing?.uploadedCount ?? 0) + uploadedThisCall;
    const totalMatched = source
      ? matchedThisCall
      : preservesSourcedCounts ? existing.matchedCount : (existing?.matchedCount ?? 0) + matchedThisCall;
    // Mirror sales-platform capabilities.audience_targeting.minimum_audience_size.
    const minimumSize = 100;
    const status: AudienceState['status'] = totalMatched === 0
      ? 'processing'
      : totalMatched < minimumSize ? 'too_small' : 'ready';

    const state: AudienceState = {
      audienceId: input.audience_id,
      name: input.name ?? existing?.name ?? input.audience_id,
      sellerId: existing?.sellerId ?? `aud_${randomUUID().slice(0, 8)}`,
      uploadedCount: totalUploaded,
      matchedCount: totalMatched,
      status,
      audienceType: input.audience_type ?? existing?.audienceType ?? 'crm',
      createdAt: existing?.createdAt ?? now,
      lastSyncedAt: now,
      source: source ? sourceStateFromInput(source) : existing?.source,
    };

    audiences.set(input.audience_id, state);

    const projectedSource = sourceResponse(state.source, ctx.servedAdcpVersion);
    const result: Record<string, unknown> = {
      audience_id: state.audienceId,
      name: state.name,
      seller_id: state.sellerId,
      action: existing ? 'updated' : 'created',
      status: state.status,
      uploaded_count: uploadedThisCall,
      total_uploaded_count: state.uploadedCount,
      matched_count: state.matchedCount,
      last_synced_at: state.lastSyncedAt,
      ...(projectedSource && { source: projectedSource }),
    };

    if (state.uploadedCount > 0) {
      result.effective_match_rate = state.matchedCount / state.uploadedCount;
    }
    if (state.status === 'too_small') {
      result.minimum_size = minimumSize;
    }

    results.push(result);
  }

  return { audiences: results };
}
