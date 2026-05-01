/**
 * AAO hosted agent resolver — orchestrator.
 *
 * Implements the verifier algorithm from `specs/capabilities-brand-url.md`
 * §"Verifier algorithm" and serves the wire shape from §"Hosted resolver".
 *
 * Two public entry points:
 *
 * - `resolveAgent(agentUrl, opts)` — full discovery chain plus trace. Used
 *   by `/api/registry/agents/resolve`.
 * - `getAgentJwks(agentUrl, opts)` — JWKS plus the upstream
 *   `Cache-Control` header for byte-for-byte propagation. Used by
 *   `/api/registry/agents/jwks`.
 *
 * Per spec, the JWKS endpoint MUST propagate upstream `Cache-Control`
 * byte-for-byte and never extend TTLs. We surface the upstream header to
 * the route handler so it can wire that into the response.
 *
 * Trust posture: the resolver MUST itself enforce required-when (round-2
 * security note) — when signing is declared without `key_origins`, return
 * `request_signature_key_origin_missing` rather than silently passing.
 */
import escapeHtml from "escape-html";
import { fetchCapabilities } from "./capabilities-fetcher.js";
import { fetchBrandJson } from "./brand-json-fetcher.js";
import { fetchJwks, type Jwk } from "./jwks-fetcher.js";
import {
  validateAgentUrlInput,
  etldPlusOne,
  DEFAULT_PER_HOST_RPS,
} from "./safe-fetch-strict.js";
import {
  checkOriginBinding,
  findAgentEntries,
  resolveJwksUri,
  extractIdentity,
  declaredSigningPurposes,
  checkKeyOrigins,
  findMissingKeyOrigin,
  type OriginBinding,
} from "./consistency.js";
import { AgentResolverError } from "./errors.js";
import { BreadcrumbBuilder, type Freshness, type TraceStep } from "./breadcrumb.js";
import { TtlCache, TokenBucketRateLimiter } from "./cache.js";

/** Brand.json TTL — bounded by the JWKS revocation polling interval per
 * spec open question #2. 5 min is the same default the SDK uses for
 * `createRemoteJWKSet` in `jose`. */
const BRAND_JSON_TTL_MS = 5 * 60 * 1000;
/** Capabilities TTL — short, since `last_updated` is meaningful but we
 * don't depend on it for trust. */
const CAPABILITIES_TTL_MS = 5 * 60 * 1000;

interface SharedDeps {
  brandJsonCache: TtlCache<{
    parsed: import("./brand-json-fetcher.js").ParsedBrandJson;
    fetch: import("./safe-fetch-strict.js").StrictFetchResult;
    brand_url: string;
    cached_at: string;
  }>;
  capabilitiesCache: TtlCache<import("./capabilities-fetcher.js").CapabilitiesFetchResult>;
  rateLimiter: TokenBucketRateLimiter;
}

const deps: SharedDeps = {
  brandJsonCache: new TtlCache({ defaultTtlMs: BRAND_JSON_TTL_MS }),
  capabilitiesCache: new TtlCache({ defaultTtlMs: CAPABILITIES_TTL_MS }),
  rateLimiter: new TokenBucketRateLimiter({
    capacity: DEFAULT_PER_HOST_RPS,
    refillPerSecond: DEFAULT_PER_HOST_RPS,
  }),
};

/** Test-only dependency injection. Production callers don't pass `deps`. */
export interface ResolverOptions {
  rateLimiter?: TokenBucketRateLimiter;
  brandJsonCache?: SharedDeps["brandJsonCache"];
  capabilitiesCache?: SharedDeps["capabilitiesCache"];
  /** Bypass the in-process cache. */
  fresh?: boolean;
  /** Per-stage timeout override. */
  timeoutMs?: number;
}

export interface AgentResolution {
  agent_url: string;
  brand_url: string;
  operator_domain: string;
  agent_entry: {
    type?: string;
    url: string;
    id?: string;
    jwks_uri?: string;
  };
  jwks_uri: string;
  jwks: { keys: Jwk[] };
  signing_keys_pin: null;
  identity_posture: {
    per_principal_key_isolation?: boolean;
    key_origins?: Record<string, string>;
  };
  consistency: {
    origin_binding: OriginBinding;
    key_origin_match: boolean;
    issues: { purpose: string; expected_origin: string; actual_origin: string }[];
  };
  aao_signed: false;
  resolved_at: string;
  upstream_fetched_at: string;
  cache_until: string;
  source: "live" | "cached";
  freshness: Freshness;
  trace: TraceStep[];
  /** Echoed by the JWKS route into `X-AAO-Upstream-JWKS-URI`. */
  upstream_jwks_uri: string;
  /** Header name → value for the JWKS pass-through (Cache-Control etc.). */
  jwks_response_headers: Record<string, string>;
  /** Server-asserted age (seconds) used for `X-AAO-Resolver-Age`. */
  resolver_age_seconds: number;
}

function getDeps(opts: ResolverOptions): SharedDeps {
  return {
    brandJsonCache: opts.brandJsonCache ?? deps.brandJsonCache,
    capabilitiesCache: opts.capabilitiesCache ?? deps.capabilitiesCache,
    rateLimiter: opts.rateLimiter ?? deps.rateLimiter,
  };
}

export async function resolveAgent(
  agentUrlRaw: string,
  opts: ResolverOptions = {},
): Promise<AgentResolution> {
  const d = getDeps(opts);
  const breadcrumb = new BreadcrumbBuilder();
  const parsedAgentUrl = validateAgentUrlInput(agentUrlRaw);
  const agentUrl = parsedAgentUrl.toString();
  const startedAt = new Date();

  // Step 1: capabilities.
  let capsResult: import("./capabilities-fetcher.js").CapabilitiesFetchResult;
  try {
    capsResult = opts.fresh
      ? await fetchCapabilities(agentUrl, { timeoutMs: opts.timeoutMs })
      : ((): import("./capabilities-fetcher.js").CapabilitiesFetchResult => {
          const cached = d.capabilitiesCache.get(agentUrl);
          if (cached) return { ...cached, from_cache: true };
          return null as never;
        })() ?? (await fetchCapabilities(agentUrl, { timeoutMs: opts.timeoutMs }));
    if (!capsResult.from_cache) d.capabilitiesCache.set(agentUrl, capsResult);
  } catch (err) {
    breadcrumb.recordFailure({
      step: "capabilities",
      url: agentUrl,
      method: "MCP_CALL",
      status: null,
      code: err instanceof AgentResolverError ? err.code : "request_signature_capabilities_unreachable",
      message: err instanceof Error ? err.message : undefined,
    });
    throw attachTrace(err, breadcrumb);
  }
  breadcrumb.record({
    step: "capabilities",
    url: agentUrl,
    method: "MCP_CALL",
    status: 200,
    bytes: capsResult.bytes,
    from_cache: capsResult.from_cache,
    fetched_at: capsResult.fetched_at,
    cache_control: capsResult.cache_control,
  });

  // Step 2: brand_url (verifier algorithm step 2 — surface presence here).
  const brandUrl = pickBrandUrl(capsResult.data);
  if (!brandUrl) {
    throw attachTrace(
      new AgentResolverError("request_signature_brand_url_missing", {
        agent_url: agentUrl,
      }),
      breadcrumb,
    );
  }

  // Step 4: brand.json fetch (origin binding check needs `authorized_operators`).
  let brandFetch: import("./brand-json-fetcher.js").BrandJsonFetchResult & { from_cache: boolean; cached_at?: string };
  try {
    const cached = opts.fresh ? undefined : d.brandJsonCache.get(brandUrl);
    if (cached) {
      brandFetch = { ...cached, from_cache: true };
    } else {
      const fetched = await fetchBrandJson(brandUrl, {
        rateLimiter: d.rateLimiter,
        timeoutMs: opts.timeoutMs,
      });
      d.brandJsonCache.set(brandUrl, {
        ...fetched,
        cached_at: new Date().toISOString(),
      });
      brandFetch = { ...fetched, from_cache: false };
    }
  } catch (err) {
    breadcrumb.recordFailure({
      step: "brand_json",
      url: brandUrl,
      method: "GET",
      status: err instanceof AgentResolverError && err.detail.http_status ? err.detail.http_status : null,
      code: err instanceof AgentResolverError ? err.code : "request_signature_brand_json_unreachable",
      message: err instanceof Error ? err.message : undefined,
    });
    throw attachTrace(err, breadcrumb);
  }
  breadcrumb.record({
    step: "brand_json",
    url: brandUrl,
    method: "GET",
    status: brandFetch.fetch.status,
    etag: brandFetch.fetch.headers.get("etag"),
    last_modified: brandFetch.fetch.headers.get("last-modified"),
    cache_control: brandFetch.fetch.headers.get("cache-control"),
    bytes: brandFetch.fetch.bytes,
    from_cache: brandFetch.from_cache,
  });

  // Step 3: origin binding.
  const origin = checkOriginBinding(agentUrl, brandUrl, brandFetch.parsed.authorized_operators);
  if (origin.binding === "mismatch") {
    throw attachTrace(
      new AgentResolverError("request_signature_brand_origin_mismatch", {
        agent_url: agentUrl,
        agent_etld1: origin.agent_etld1,
        brand_url_etld1: origin.brand_url_etld1,
      }),
      breadcrumb,
    );
  }

  // Step 5: agents[] lookup.
  const lookup = findAgentEntries(agentUrl, brandFetch.parsed);
  if (lookup.matches.length === 0) {
    throw attachTrace(
      new AgentResolverError("request_signature_agent_not_in_brand_json", {
        agent_url: agentUrl,
        brand_url: brandUrl,
      }),
      breadcrumb,
    );
  }
  if (lookup.matches.length > 1) {
    throw attachTrace(
      new AgentResolverError("request_signature_brand_json_ambiguous", {
        agent_url: agentUrl,
        brand_url: brandUrl,
        matched_count: lookup.matches.length,
        matched_entries: lookup.matches.map((m) => ({ url: m.url, id: m.id })),
      }),
      breadcrumb,
    );
  }
  const agentEntry = lookup.matches[0];

  // Step 6: jwks_uri (publisher pin not implemented in this MVP — we don't
  // currently load adagents.json on this path. The spec leaves the pin as
  // an override for sell-side webhooks; resolution falls back to the
  // operator brand.json entry. Bypassed purposes is empty by default.)
  const jwksUri = resolveJwksUri(agentEntry, agentUrl);

  // Step 7: required-when (round-2: AAO MUST itself enforce this) BEFORE
  // we even fetch the JWKS — saves a network hop on a config error.
  const identity = extractIdentity(capsResult.data);
  const declaredPurposes = declaredSigningPurposes(capsResult.data);
  if (declaredPurposes.size > 0) {
    const missing = findMissingKeyOrigin(declaredPurposes, identity?.key_origins);
    if (missing) {
      throw attachTrace(
        new AgentResolverError("request_signature_key_origin_missing", {
          purpose: missing.purpose,
          posture: missing.posture,
        }),
        breadcrumb,
      );
    }
  }

  // Step 8 (and 7 cont.): JWKS fetch + key_origins consistency check.
  const jwksResult = await (async () => {
    try {
      return await fetchJwks(jwksUri, {
        rateLimiter: d.rateLimiter,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      breadcrumb.recordFailure({
        step: "jwks",
        url: jwksUri,
        method: "GET",
        status: err instanceof AgentResolverError && err.detail.http_status ? err.detail.http_status : null,
        code: err instanceof AgentResolverError ? err.code : "request_signature_jwks_unreachable",
        message: err instanceof Error ? err.message : undefined,
      });
      throw attachTrace(err, breadcrumb);
    }
  })();
  breadcrumb.record({
    step: "jwks",
    url: jwksUri,
    method: "GET",
    status: jwksResult.fetch.status,
    etag: jwksResult.fetch.headers.get("etag"),
    last_modified: jwksResult.fetch.headers.get("last-modified"),
    cache_control: jwksResult.fetch.headers.get("cache-control"),
    bytes: jwksResult.fetch.bytes,
    from_cache: false,
  });

  // Step 7 consistency check — runs after we have the resolved jwks_uri.
  const keyOriginCheck = checkKeyOrigins(identity?.key_origins, jwksUri, {
    bypassedPurposes: new Set<string>(),
  });
  if (!keyOriginCheck.match && keyOriginCheck.issues.length > 0) {
    const first = keyOriginCheck.issues[0];
    throw attachTrace(
      new AgentResolverError("request_signature_key_origin_mismatch", {
        purpose: first.purpose,
        expected_origin: first.expected_origin,
        actual_origin: first.actual_origin,
      }),
      breadcrumb,
    );
  }

  const operatorDomain = etldPlusOne(new URL(brandUrl).hostname);
  const built = breadcrumb.build();
  const resolvedAt = startedAt.toISOString();
  const upstreamFetchedAt = capsResult.fetched_at;
  const cacheUntil = new Date(Date.now() + BRAND_JSON_TTL_MS).toISOString();
  const source: "live" | "cached" =
    capsResult.from_cache && brandFetch.from_cache ? "cached" : "live";

  // Pass-through headers for the JWKS endpoint. We propagate Cache-Control
  // byte-for-byte (no rewriting), Content-Type, ETag, and Last-Modified.
  const jwksHeaders = jwksResult.fetch.headers;
  const passthroughHeaders: Record<string, string> = {};
  const cc = jwksHeaders.get("cache-control");
  if (cc) passthroughHeaders["Cache-Control"] = escapeHtml(cc);
  const etag = jwksHeaders.get("etag");
  if (etag) passthroughHeaders["ETag"] = escapeHtml(etag);
  const lm = jwksHeaders.get("last-modified");
  if (lm) passthroughHeaders["Last-Modified"] = escapeHtml(lm);

  const resolverAge = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(jwksResult.fetch.headers.get("date") ?? resolvedAt)) / 1000),
  );

  return {
    agent_url: agentUrl,
    brand_url: brandUrl,
    operator_domain: operatorDomain,
    agent_entry: {
      type: agentEntry.type,
      url: agentEntry.url,
      id: agentEntry.id,
      jwks_uri: agentEntry.jwks_uri,
    },
    jwks_uri: jwksUri,
    jwks: jwksResult.jwks,
    signing_keys_pin: null,
    identity_posture: {
      per_principal_key_isolation: identity?.per_principal_key_isolation,
      key_origins: identity?.key_origins,
    },
    consistency: {
      origin_binding: origin.binding,
      key_origin_match: keyOriginCheck.match,
      issues: keyOriginCheck.issues,
    },
    aao_signed: false,
    resolved_at: resolvedAt,
    upstream_fetched_at: upstreamFetchedAt,
    cache_until: cacheUntil,
    source,
    freshness: built.freshness,
    trace: built.trace,
    upstream_jwks_uri: jwksUri,
    jwks_response_headers: passthroughHeaders,
    resolver_age_seconds: resolverAge,
  };
}

export async function getAgentJwks(
  agentUrl: string,
  opts: ResolverOptions = {},
): Promise<{
  jwks: { keys: Jwk[] };
  jwksUri: string;
  passthroughHeaders: Record<string, string>;
  resolverAgeSeconds: number;
}> {
  const resolution = await resolveAgent(agentUrl, opts);
  return {
    jwks: resolution.jwks,
    jwksUri: resolution.jwks_uri,
    passthroughHeaders: resolution.jwks_response_headers,
    resolverAgeSeconds: resolution.resolver_age_seconds,
  };
}

/**
 * Pull the trust-root `brand_url` from a capabilities response. Prefers
 * the new top-level field (this spec); falls back to
 * `sponsored_intelligence.brand_url` ONLY when the top-level is missing
 * AND `sponsored_intelligence` is the only block declared (the rendering
 * pointer happens to be the same artifact today, so the SI-only case can
 * still resolve. Multi-protocol agents must populate the top-level).
 */
function pickBrandUrl(capabilities: Record<string, unknown>): string | null {
  if (typeof capabilities.brand_url === "string" && capabilities.brand_url.length > 0) {
    return capabilities.brand_url;
  }
  return null;
}

/** Attach the current trace + freshness to a thrown AgentResolverError so
 * the route handler can render the failure-shape body. */
function attachTrace(err: unknown, breadcrumb: BreadcrumbBuilder): unknown {
  if (err instanceof AgentResolverError) {
    const built = breadcrumb.build();
    Object.assign(err.detail, {
      trace: built.trace,
      freshness: built.freshness,
    });
  }
  return err;
}
