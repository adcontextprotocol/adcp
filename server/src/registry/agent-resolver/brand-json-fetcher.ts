/**
 * Fetch and parse a brand.json document for the resolver.
 *
 * 32 KB body cap per spec §"SSRF and rate-limit hardening". JSON parse
 * errors map to `request_signature_brand_json_unreachable` (we treat
 * "structurally invalid" the same as "couldn't reach it" for verifier
 * purposes — both leave us without a trust root).
 */
import { AgentResolverError } from "./errors.js";
import {
  strictGet,
  etldPlusOne,
  type StrictFetchOptions,
  type StrictFetchResult,
} from "./safe-fetch-strict.js";

export const BRAND_JSON_MAX_BYTES = 32 * 1024;

export interface BrandAgentEntry {
  type?: string;
  url: string;
  id?: string;
  jwks_uri?: string;
  description?: string;
}

export interface AuthorizedOperator {
  domain: string;
  brands?: string[];
  countries?: string[];
}

export interface ParsedBrandJson {
  agents: BrandAgentEntry[];
  authorized_operators: AuthorizedOperator[];
  raw: Record<string, unknown>;
}

export interface BrandJsonFetchResult {
  parsed: ParsedBrandJson;
  fetch: StrictFetchResult;
  brand_url: string;
}

export async function fetchBrandJson(
  brandUrl: string,
  opts: Omit<StrictFetchOptions, "maxBytes" | "hostBucketKey"> & {
    rateLimiter?: StrictFetchOptions["rateLimiter"];
  },
): Promise<BrandJsonFetchResult> {
  const u = new URL(brandUrl);
  const result = await strictGet(brandUrl, {
    maxBytes: BRAND_JSON_MAX_BYTES,
    hostBucketKey: etldPlusOne(u.hostname),
    rateLimiter: opts.rateLimiter,
    timeoutMs: opts.timeoutMs,
    acceptHeader: "application/json",
  });
  if (result.status < 200 || result.status >= 300) {
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      {
        brand_url: brandUrl,
        http_status: result.status,
        last_attempt_at: new Date().toISOString(),
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.body.toString("utf8"));
  } catch {
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      {
        brand_url: brandUrl,
        reason: "brand.json is not valid JSON",
        last_attempt_at: new Date().toISOString(),
      },
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      {
        brand_url: brandUrl,
        reason: "brand.json must be a JSON object",
        last_attempt_at: new Date().toISOString(),
      },
    );
  }
  const obj = raw as Record<string, unknown>;
  const agents = parseAgents(obj.agents);
  const authorized_operators = parseAuthorizedOperators(obj.authorized_operators);
  return {
    parsed: { agents, authorized_operators, raw: obj },
    fetch: result,
    brand_url: brandUrl,
  };
}

function parseAgents(value: unknown): BrandAgentEntry[] {
  if (!Array.isArray(value)) return [];
  const out: BrandAgentEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.url !== "string") continue;
    out.push({
      type: typeof a.type === "string" ? a.type : undefined,
      url: a.url,
      id: typeof a.id === "string" ? a.id : undefined,
      jwks_uri: typeof a.jwks_uri === "string" ? a.jwks_uri : undefined,
      description: typeof a.description === "string" ? a.description : undefined,
    });
  }
  return out;
}

function parseAuthorizedOperators(value: unknown): AuthorizedOperator[] {
  if (!Array.isArray(value)) return [];
  const out: AuthorizedOperator[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.domain !== "string") continue;
    out.push({
      domain: a.domain.toLowerCase(),
      brands: Array.isArray(a.brands) ? a.brands.filter((x): x is string => typeof x === "string") : undefined,
      countries: Array.isArray(a.countries) ? a.countries.filter((x): x is string => typeof x === "string") : undefined,
    });
  }
  return out;
}
