/**
 * Buyer property-list targeting for the training seller.
 *
 * A package may carry `targeting_overlay.property_list` (include) and
 * `property_list_exclude` (exclude) references to lists the buyer manages on
 * its own list agent. The seller resolves each reference, intersects it with
 * the selected product's properties, and either accepts the package with the
 * effective property set or rejects the whole request. A list that cannot be
 * resolved never degrades into a partial application.
 *
 * Resolution order for one reference:
 *   1. storyboard fixture lists (`.example` list agent, never dialed)
 *   2. this deployment's own governance tenant, in process
 *   3. the buyer's list agent over MCP, through the SSRF-guarded transport,
 *      cached per session until the response's `cache_valid_until`
 */

import { createHash } from 'node:crypto';
import { ProtocolClient, unwrapProtocolResponse } from '@adcp/sdk';
import { isPrivateHostname, normalizeExternalHostname, safeFetch } from '../utils/url-security.js';
import { createLogger } from '../logger.js';
import { getCanonicalBase, getTrainingGovernanceIssuer } from './canonical-base.js';
import { handleGetPropertyList } from './property-handlers.js';
import { PUBLISHERS } from './publishers.js';
import { isStoryboardListAgent, storyboardPropertyList } from './property-list-fixtures.js';
import type {
  AccountRef,
  ListReference,
  PackagePropertyApplication,
  PackageTargeting,
  PropertyListCacheEntry,
  SessionState,
  ToolArgs,
  TrainingContext,
} from './types.js';

const logger = createLogger('training-agent-property-lists');

const LIST_FETCH_TIMEOUT_MS = 5_000;
const LIST_MAX_RESPONSE_BYTES = 1024 * 1024;
const LIST_PAGE_SIZE = 1_000;
const LIST_MAX_PAGES = 5;
/** Wall-clock budget for resolving one list across all of its pages. */
const LIST_RESOLVE_DEADLINE_MS = 15_000;
const LIST_MAX_IDENTIFIER_LENGTH = 512;
/** Upper bound on how long a seller reuses a snapshot, whatever the list agent asks. */
const LIST_MAX_CACHE_MS = 60 * 60 * 1000;
export const PROPERTY_LIST_MAX_IDENTIFIERS = 5_000;
const LIST_CACHE_MAX_ENTRIES = 10;
/** Fixture and in-process lists carry no upstream expiry of their own. */
const LOCAL_LIST_VALIDITY_MS = 60 * 60 * 1000;

interface TaskErrorShape {
  code: string;
  message: string;
  field?: string;
  recovery?: 'correctable' | 'transient' | 'terminal';
}

// ── SSRF guard ───────────────────────────────────────────────────

/** Paths on this deployment that serve the governance `get_property_list`. */
const SELF_LIST_AGENT_PATHS = new Set([
  '',
  '/mcp',
  '/governance',
  '/governance/mcp',
  '/api/training-agent/mcp',
  '/api/training-agent/governance',
  '/api/training-agent/governance/mcp',
]);

function selfOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const base of [getTrainingGovernanceIssuer(), getCanonicalBase()]) {
    try {
      origins.add(new URL(base).origin.toLowerCase());
    } catch {
      // An unparseable base cannot match a request URL.
    }
  }
  return origins;
}

/** The training agent's own governance tenant, which already serves
 * `get_property_list` and is reached in process rather than over the network. */
export function isTrainingSelfListAgent(agentUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  return selfOrigins().has(url.origin.toLowerCase())
    && SELF_LIST_AGENT_PATHS.has(url.pathname.replace(/\/+$/, ''));
}

/** Returns a rejection reason when the list agent URL must not be dialed. */
export function listAgentUrlRejection(agentUrl: string): string | undefined {
  if (isStoryboardListAgent(agentUrl)) return undefined;
  if (isTrainingSelfListAgent(agentUrl)) return undefined;
  let url: URL;
  try {
    url = new URL(agentUrl);
  } catch {
    return 'must be a valid URL';
  }
  if (url.username || url.password) return 'must not embed credentials';
  if (url.search || url.hash) return 'must not carry a query string or fragment';
  const hostname = normalizeExternalHostname(url.hostname);
  if (!hostname || isPrivateHostname(hostname)) {
    return 'must not point at a private, loopback, or internal host';
  }
  return undefined;
}

// ── Resolution ───────────────────────────────────────────────────

export class PropertyListResolutionError extends Error {
  constructor(
    readonly kind: 'not_found' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'PropertyListResolutionError';
  }
}

interface PropertyListTestOverride {
  fetch: typeof fetch;
}

const propertyListTestOverrides = new Map<string, PropertyListTestOverride>();

/** Test-only seam: route the outbound list fetch for one agent URL through a
 * loopback stub. Production calls always use the DNS-pinned transport. */
export function setPropertyListFetchTestOverride(
  agentUrl: string,
  override: PropertyListTestOverride | undefined,
): void {
  if (override) propertyListTestOverrides.set(agentUrl, override);
  else propertyListTestOverrides.delete(agentUrl);
}

const listSafeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    throw new Error(`Unsupported list transport method: ${method}`);
  }
  const body = method === 'POST'
    ? new Uint8Array(await request.arrayBuffer())
    : undefined;
  return safeFetch(request.url, {
    method,
    headers: Object.fromEntries(request.headers.entries()),
    ...(body && { body }),
    maxRedirects: 0,
    signal: request.signal,
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cacheKey(ref: ListReference): string {
  const credential = ref.auth_token
    ? createHash('sha256').update(ref.auth_token).digest('hex').slice(0, 16)
    : 'anonymous';
  return JSON.stringify([ref.agent_url.replace(/\/+$/, ''), ref.list_id, credential]);
}

function parseIdentifiers(value: unknown): Array<{ type: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const identifiers: Array<{ type: string; value: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== 'string' || typeof entry.value !== 'string') {
      return undefined;
    }
    if (entry.type.length > LIST_MAX_IDENTIFIER_LENGTH || entry.value.length > LIST_MAX_IDENTIFIER_LENGTH) {
      return undefined;
    }
    identifiers.push({ type: entry.type, value: entry.value });
  }
  return identifiers;
}

const NOT_FOUND_CODES = new Set(['REFERENCE_NOT_FOUND', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'FORBIDDEN']);

function errorCodeOf(response: Record<string, unknown>): string | undefined {
  const adcpError = isRecord(response.adcp_error) ? response.adcp_error : undefined;
  if (typeof adcpError?.code === 'string') return adcpError.code;
  const errors = Array.isArray(response.errors) ? response.errors : undefined;
  const first = errors?.find(isRecord);
  return typeof first?.code === 'string' ? first.code : undefined;
}

function interpretListResponse(response: unknown): {
  identifiers: Array<{ type: string; value: string }>;
  resolvedAt?: string;
  cacheValidUntil?: string;
  nextCursor?: string;
} {
  if (!isRecord(response)) {
    throw new PropertyListResolutionError('unavailable', 'The list agent returned an unreadable response.');
  }
  const errorCode = errorCodeOf(response);
  if (errorCode) {
    throw new PropertyListResolutionError(
      NOT_FOUND_CODES.has(errorCode) ? 'not_found' : 'unavailable',
      'The list agent did not return the list.',
    );
  }
  const identifiers = parseIdentifiers(response.identifiers);
  if (!identifiers) {
    throw new PropertyListResolutionError('unavailable', 'The list agent returned no resolved identifiers.');
  }
  const pagination = isRecord(response.pagination) ? response.pagination : undefined;
  const hasMore = pagination?.has_more === true;
  const cursor = typeof pagination?.cursor === 'string' ? pagination.cursor : undefined;
  if (hasMore && !cursor) {
    throw new PropertyListResolutionError('unavailable', 'The list agent paginated without a cursor.');
  }
  return {
    identifiers,
    ...(typeof response.resolved_at === 'string' && { resolvedAt: response.resolved_at }),
    ...(typeof response.cache_valid_until === 'string' && { cacheValidUntil: response.cache_valid_until }),
    ...(hasMore && cursor && { nextCursor: cursor }),
  };
}

async function fetchRemoteList(ref: ListReference, now: Date): Promise<PropertyListCacheEntry> {
  const override = propertyListTestOverrides.get(ref.agent_url);
  const agent = {
    id: `property-list-${createHash('sha256').update(ref.agent_url).digest('hex').slice(0, 12)}`,
    name: 'Buyer property list agent',
    agent_uri: ref.agent_url,
    protocol: 'mcp' as const,
    // The credential rides only as the Bearer header; a public list sends none.
    ...(ref.auth_token && { auth_token: ref.auth_token }),
  };
  const identifiers: Array<{ type: string; value: string }> = [];
  let resolvedAt: string | undefined;
  let cacheValidUntil: string | undefined;
  let cursor: string | undefined;
  const deadline = now.getTime() + LIST_RESOLVE_DEADLINE_MS;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    if (Date.now() > deadline && page > 0) {
      throw new PropertyListResolutionError('unavailable', 'The list agent took too long to return every page.');
    }
    let response: unknown;
    try {
      const raw = await ProtocolClient.callTool(agent, 'get_property_list', {
        list_id: ref.list_id,
        resolve: true,
        pagination: { max_results: LIST_PAGE_SIZE, ...(cursor && { cursor }) },
      }, {
        transport: {
          trustedFetchFn: override?.fetch ?? listSafeFetch,
          allowPrivateIp: false,
          requestTimeoutMs: LIST_FETCH_TIMEOUT_MS,
          maxResponseBytes: LIST_MAX_RESPONSE_BYTES,
        },
      });
      response = unwrapProtocolResponse(raw, 'get_property_list', 'mcp');
    } catch (error) {
      if (error instanceof PropertyListResolutionError) throw error;
      // Never log the credential or the raw transport error, which may echo it.
      const logged = new URL(ref.agent_url);
      logger.warn({ agentUrl: `${logged.origin}${logged.pathname}`, listId: ref.list_id }, 'Property list fetch failed');
      throw new PropertyListResolutionError('unavailable', 'The list agent could not be reached.');
    }
    const parsed = interpretListResponse(response);
    identifiers.push(...parsed.identifiers);
    if (identifiers.length > PROPERTY_LIST_MAX_IDENTIFIERS) {
      throw new PropertyListResolutionError('unavailable', 'The list is larger than this seller can resolve.');
    }
    resolvedAt ??= parsed.resolvedAt;
    if (parsed.cacheValidUntil && (!cacheValidUntil || Date.parse(parsed.cacheValidUntil) < Date.parse(cacheValidUntil))) {
      cacheValidUntil = parsed.cacheValidUntil;
    }
    if (!parsed.nextCursor) {
      return {
        identifiers,
        resolvedAt: resolvedAt ?? now.toISOString(),
        // Without an expiry the snapshot is not reusable: re-fetch next time.
        // A long expiry is clamped so a list agent cannot pin a stale snapshot.
        cacheValidUntil: cacheValidUntil
          ? new Date(Math.min(Date.parse(cacheValidUntil) || 0, now.getTime() + LIST_MAX_CACHE_MS)).toISOString()
          : now.toISOString(),
      };
    }
    cursor = parsed.nextCursor;
  }
  throw new PropertyListResolutionError('unavailable', 'The list has more pages than this seller will read.');
}

async function fetchSelfList(
  ref: ListReference,
  ctx: TrainingContext,
  account: AccountRef | undefined,
  now: Date,
): Promise<PropertyListCacheEntry> {
  const response = await handleGetPropertyList(
    { list_id: ref.list_id, ...(account !== undefined && { account }) } as ToolArgs,
    {
      mode: ctx.mode,
      tenantId: 'governance',
      ...(ctx.userId !== undefined && { userId: ctx.userId }),
      ...(ctx.moduleId !== undefined && { moduleId: ctx.moduleId }),
      ...(ctx.principal !== undefined && { principal: ctx.principal }),
    },
  );
  const parsed = interpretListResponse(response);
  return {
    identifiers: parsed.identifiers,
    resolvedAt: parsed.resolvedAt ?? now.toISOString(),
    cacheValidUntil: parsed.cacheValidUntil ?? new Date(now.getTime() + LOCAL_LIST_VALIDITY_MS).toISOString(),
  };
}

async function resolvePropertyList(
  ref: ListReference,
  session: SessionState,
  ctx: TrainingContext,
  account: AccountRef | undefined,
  now: Date,
): Promise<PropertyListCacheEntry> {
  const fixture = storyboardPropertyList(ref.agent_url, ref.list_id);
  if (fixture) {
    return {
      identifiers: fixture.map(identifier => ({ ...identifier })),
      resolvedAt: now.toISOString(),
      cacheValidUntil: new Date(now.getTime() + LOCAL_LIST_VALIDITY_MS).toISOString(),
    };
  }
  if (isStoryboardListAgent(ref.agent_url)) {
    throw new PropertyListResolutionError('not_found', 'The list agent does not know this list.');
  }
  // The deployment's own tenant is read fresh each time, so list edits apply
  // immediately and no cache can outlive them.
  if (isTrainingSelfListAgent(ref.agent_url)) return fetchSelfList(ref, ctx, account, now);

  const key = cacheKey(ref);
  const cached = session.propertyListCache.get(key);
  if (cached && new Date(cached.cacheValidUntil).getTime() > now.getTime()) return cached;

  const entry = await fetchRemoteList(ref, now);
  session.propertyListCache.delete(key);
  // An already-expired snapshot is used for this request only.
  if (new Date(entry.cacheValidUntil).getTime() <= now.getTime()) return entry;
  session.propertyListCache.set(key, entry);
  while (session.propertyListCache.size > LIST_CACHE_MAX_ENTRIES) {
    const oldest = session.propertyListCache.keys().next().value;
    if (oldest === undefined) break;
    session.propertyListCache.delete(oldest);
  }
  return entry;
}

// ── Product inventory ────────────────────────────────────────────

interface ProductProperty {
  publisherDomain: string;
  propertyId: string;
  identifier: { type: string; value: string };
  tags: readonly string[];
}

/** The properties a catalog product sells. Undefined when any selector names a
 * publisher this seller cannot enumerate (for example a fixture product). */
export function productProperties(product: unknown): ProductProperty[] | undefined {
  const selectors = isRecord(product) && Array.isArray(product.publisher_properties)
    ? product.publisher_properties
    : undefined;
  if (!selectors || selectors.length === 0) return undefined;
  const properties: ProductProperty[] = [];
  for (const selector of selectors) {
    if (!isRecord(selector)) return undefined;
    const domains = typeof selector.publisher_domain === 'string'
      ? [selector.publisher_domain]
      : Array.isArray(selector.publisher_domains)
        ? selector.publisher_domains.filter((d): d is string => typeof d === 'string')
        : [];
    if (domains.length === 0) return undefined;
    for (const domain of domains) {
      const publisher = PUBLISHERS.find(candidate => candidate.domain === domain);
      if (!publisher) return undefined;
      const wantedIds = selector.selection_type === 'by_id' && Array.isArray(selector.property_ids)
        ? new Set(selector.property_ids)
        : undefined;
      const wantedTags = selector.selection_type === 'by_tag' && Array.isArray(selector.property_tags)
        ? new Set(selector.property_tags)
        : undefined;
      for (const property of publisher.properties) {
        if (wantedIds && !wantedIds.has(property.propertyId)) continue;
        if (wantedTags && !property.tags.some(tag => wantedTags.has(tag))) continue;
        properties.push({
          publisherDomain: publisher.domain,
          propertyId: property.propertyId,
          identifier: { type: property.identifierType, value: property.identifierValue },
          tags: property.tags,
        });
      }
    }
  }
  return properties;
}

/** Whether a catalog product's property set is large enough for a buyer to
 * select a subset of it. */
export function productSellsSelectableProperties(product: unknown): boolean {
  return (productProperties(product)?.length ?? 0) > 1;
}

/** `example.com` matches the base domain plus `www` and `m`; `*.example.com`
 * matches every subdomain but not the base. Other identifier types compare
 * exactly (case-insensitively). */
function identifierMatches(
  entry: { type: string; value: string },
  property: { type: string; value: string },
): boolean {
  if (entry.type !== property.type) return false;
  const wanted = entry.value.trim().toLowerCase();
  const actual = property.value.trim().toLowerCase();
  if (entry.type !== 'domain' && entry.type !== 'subdomain') return wanted === actual;
  if (wanted.startsWith('*.')) {
    const base = wanted.slice(2);
    return actual.endsWith(`.${base}`) && actual.length > base.length + 1;
  }
  return actual === wanted || actual === `www.${wanted}` || actual === `m.${wanted}`;
}

// ── Application ──────────────────────────────────────────────────

export interface PropertyListApplicationInput {
  product: unknown;
  targeting: PackageTargeting | undefined;
  /** Path of the package's targeting overlay, for `error.field`. */
  path: string;
  session: SessionState;
  ctx: TrainingContext;
  account?: AccountRef;
  now?: Date;
}

export type PropertyListApplicationOutcome =
  | { error: TaskErrorShape }
  | { application?: PackagePropertyApplication };

function unsupported(path: string, field: string, message: string): { error: TaskErrorShape } {
  return {
    error: {
      code: 'UNSUPPORTED_FEATURE',
      message,
      field: `${path}.${field}`,
      recovery: 'correctable',
    },
  };
}

/**
 * Resolve and apply the package's property lists against the selected product.
 * Returns the effective property set and receipts, nothing when the package
 * carries no property list, or an error that rejects the whole request.
 */
export async function applyPropertyListTargeting(
  input: PropertyListApplicationInput,
): Promise<PropertyListApplicationOutcome> {
  const { product, targeting, path, session, ctx, account } = input;
  const include = targeting?.property_list;
  const exclude = targeting?.property_list_exclude;
  if (!include && !exclude) return {};

  const productRecord = isRecord(product) ? product : {};
  const support = isRecord(productRecord.overlay_support) ? productRecord.overlay_support : {};
  const inventory = productProperties(product);
  if (include) {
    // property_targeting_allowed: false is fixed inventory; only the exclude
    // list may narrow it.
    if (productRecord.property_targeting_allowed !== true || support.property_list !== true) {
      return unsupported(path, 'property_list', 'The selected product does not allow property-list targeting.');
    }
  }
  if (exclude && support.property_list_exclude !== true) {
    return unsupported(path, 'property_list_exclude', 'The selected product does not support property-list exclusion.');
  }
  // The product declares support but its inventory is not one this seller can
  // enumerate (a controller-seeded product): accept the reference as bound
  // targeting without computing an effective set.
  if (!inventory) return {};

  const now = input.now ?? new Date();
  const references: Array<{ effect: 'include' | 'exclude'; field: string; ref: ListReference }> = [];
  if (include) references.push({ effect: 'include', field: 'property_list', ref: include });
  if (exclude) references.push({ effect: 'exclude', field: 'property_list_exclude', ref: exclude });

  const matchedByReference: Array<Set<ProductProperty>> = [];
  const listApplications: Array<Record<string, unknown>> = [];
  for (const { effect, field, ref } of references) {
    let resolved: PropertyListCacheEntry;
    try {
      resolved = await resolvePropertyList(ref, session, ctx, account, now);
    } catch (error) {
      const kind = error instanceof PropertyListResolutionError ? error.kind : 'unavailable';
      return {
        error: kind === 'not_found'
          ? {
            code: 'REFERENCE_NOT_FOUND',
            message: 'The referenced property list was not found or is not accessible.',
            field: `${path}.${field}`,
            recovery: 'correctable',
          }
          : {
            code: 'SERVICE_UNAVAILABLE',
            message: 'The referenced property list could not be fetched; retry with backoff.',
            field: `${path}.${field}`,
            recovery: 'transient',
          },
      };
    }
    // Each receipt is evaluated independently against the same pre-list
    // inventory, so overlapping lists and their order never change a count.
    const matched = new Set<ProductProperty>();
    let matchedEntries = 0;
    for (const entry of resolved.identifiers) {
      const hits = inventory.filter(property => identifierMatches(entry, property.identifier));
      if (hits.length === 0) continue;
      matchedEntries += 1;
      for (const hit of hits) matched.add(hit);
    }
    matchedByReference.push(matched);
    listApplications.push({
      list_type: 'property',
      effect,
      agent_url: ref.agent_url,
      list_id: ref.list_id,
      resolved_at: resolved.resolvedAt,
      evaluated_at: now.toISOString(),
      summary: {
        matched: matchedEntries,
        unmatched: resolved.identifiers.length - matchedEntries,
      },
    });
  }

  let effective = new Set(inventory);
  let emptiedBy: string | undefined;
  for (const [index, { effect, field }] of references.entries()) {
    const matched = matchedByReference[index];
    effective = effect === 'include'
      ? new Set([...effective].filter(property => matched.has(property)))
      : new Set([...effective].filter(property => !matched.has(property)));
    if (effective.size === 0 && emptiedBy === undefined) emptiedBy = field;
  }
  if (effective.size === 0) {
    return {
      error: {
        code: 'PRODUCT_UNAVAILABLE',
        message: emptiedBy === 'property_list_exclude'
          ? 'The property exclusion list removes every property the selected product sells.'
          : 'The property list matches none of the properties the selected product sells.',
        field: `${path}.${emptiedBy ?? 'property_list'}`,
        recovery: 'correctable',
      },
    };
  }
  return {
    application: {
      effectiveProperties: [...effective].map(property => ({
        publisher_domain: property.publisherDomain,
        property_id: property.propertyId,
      })),
      listApplications,
    },
  };
}

/** Seller-computed package extension carrying the effective inventory. Lives
 * under the `training_agent` namespace of `ext`, because the package schema has
 * no first-class field for it. */
export function packageExtWithPropertyApplication(
  ext: Record<string, unknown> | undefined,
  application: PackagePropertyApplication | undefined,
): Record<string, unknown> | undefined {
  if (!application) return ext;
  const namespace = isRecord(ext?.training_agent) ? ext.training_agent : {};
  return {
    ...ext,
    training_agent: {
      ...namespace,
      effective_properties: structuredClone(application.effectiveProperties),
      list_applications: structuredClone(application.listApplications),
    },
  };
}
