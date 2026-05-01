/**
 * Fetch and parse a JWKS document for the resolver.
 *
 * 16 KB body cap per spec §"SSRF and rate-limit hardening". The resolver
 * does NOT extend or override `Cache-Control` — `/api/registry/agents/jwks`
 * propagates the upstream header byte-for-byte so a rotated-out key
 * disappears on the operator's TTL, not AAO's.
 */
import { AgentResolverError } from "./errors.js";
import {
  strictGet,
  etldPlusOne,
  type StrictFetchOptions,
  type StrictFetchResult,
} from "./safe-fetch-strict.js";

export const JWKS_MAX_BYTES = 16 * 1024;

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  adcp_use?: string;
  [k: string]: unknown;
}

export interface JwkSet {
  keys: Jwk[];
}

export interface JwksFetchResult {
  jwks: JwkSet;
  fetch: StrictFetchResult;
  jwks_uri: string;
}

export async function fetchJwks(
  jwksUri: string,
  opts: Omit<StrictFetchOptions, "maxBytes" | "hostBucketKey"> & {
    rateLimiter?: StrictFetchOptions["rateLimiter"];
  },
): Promise<JwksFetchResult> {
  const u = new URL(jwksUri);
  const result = await strictGet(jwksUri, {
    maxBytes: JWKS_MAX_BYTES,
    hostBucketKey: etldPlusOne(u.hostname),
    rateLimiter: opts.rateLimiter,
    timeoutMs: opts.timeoutMs,
    acceptHeader: "application/jwk-set+json, application/json",
  });
  if (result.status < 200 || result.status >= 300) {
    throw new AgentResolverError(
      "request_signature_jwks_unreachable",
      {
        jwks_uri: jwksUri,
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
      "request_signature_jwks_unreachable",
      {
        jwks_uri: jwksUri,
        reason: "JWKS is not valid JSON",
        last_attempt_at: new Date().toISOString(),
      },
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentResolverError(
      "request_signature_jwks_unreachable",
      {
        jwks_uri: jwksUri,
        reason: "JWKS must be a JSON object",
        last_attempt_at: new Date().toISOString(),
      },
    );
  }
  const obj = raw as Record<string, unknown>;
  const keys = Array.isArray(obj.keys) ? obj.keys.filter(isJwkLike) : [];
  return { jwks: { keys }, fetch: result, jwks_uri: jwksUri };
}

function isJwkLike(value: unknown): value is Jwk {
  return !!value && typeof value === "object" && typeof (value as Jwk).kty === "string";
}
