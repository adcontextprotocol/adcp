/**
 * Strict wrapper around `safeFetch` for the AAO agent resolver.
 *
 * Adds, on top of the existing SSRF-safe dispatcher in
 * `server/src/utils/url-security.ts`:
 *
 * - Streaming body cap with byte counter (does NOT trust `Content-Length`).
 * - Hard `maxRedirects: 0` — redirects are disallowed across the resolver.
 * - Per-stage deadline (4 s) and total deadline (10 s) via `AbortSignal.timeout`.
 * - Per-host token-bucket rate limit on eTLD+1 (10 req/s/host by default).
 * - Pre-flight rejection of agent URLs over 2 KB (length check before any
 *   network I/O).
 * - Pre-flight rejection of bracketed-IPv6 zone-IDs (`[fe80::1%eth0]`) and
 *   unparseable hosts.
 * - Explicit deny list for cloud metadata IPs over and above the link-local
 *   block already enforced by `safeFetch`.
 * - Public Suffix List computation via the pinned `tldts` snapshot — the
 *   library ships a dated dataset, no runtime fetch.
 *
 * Returns `{ body: Buffer; status: number; headers: Headers; bytes: number }`
 * — the caller is expected to interpret `body` as text or JSON.
 */
import { getDomain } from "tldts";
import { safeFetch } from "../../utils/url-security.js";
import { AgentResolverError } from "./errors.js";
import { TokenBucketRateLimiter } from "./cache.js";

export const MAX_AGENT_URL_BYTES = 2048;
export const DEFAULT_PER_STAGE_TIMEOUT_MS = 4000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 10000;
export const DEFAULT_PER_HOST_RPS = 10;

const CLOUD_METADATA_HOSTS = new Set([
  // AWS / GCP / Azure share this address.
  "169.254.169.254",
  // AWS IPv6 metadata endpoint.
  "fd00:ec2::254",
  // Alibaba Cloud.
  "100.100.100.200",
]);

export interface StrictFetchResult {
  body: Buffer;
  status: number;
  headers: Headers;
  bytes: number;
}

export interface StrictFetchOptions {
  maxBytes: number;
  /** eTLD+1 of the URL host. Caller computes once and passes it in so the
   * rate limiter and the trace agree on the bucket key. */
  hostBucketKey: string;
  /** Override per-call timeouts (test injection). */
  timeoutMs?: number;
  rateLimiter?: TokenBucketRateLimiter;
  acceptHeader?: string;
}

/**
 * Validate an agent_url query parameter pre-flight. Per spec §"SSRF and
 * rate-limit hardening": HTTPS only, ≤2 KB, parseable host, no zone-IDs,
 * not a cloud-metadata host. Throws `AgentResolverError` for surface-able
 * cases so the route can propagate them with the right detail fields.
 */
export function validateAgentUrlInput(raw: string): URL {
  if (typeof raw !== "string") {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "agent_url query parameter is required" },
      400,
    );
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_AGENT_URL_BYTES) {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "agent_url exceeds 2048 byte cap" },
      414,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "agent_url is not a parseable URL", agent_url: raw },
      400,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "agent_url must be https://", agent_url: raw },
      400,
    );
  }
  // Bracketed-IPv6 with zone-id (`[fe80::1%25eth0]`) is link-local on its
  // face. Node's URL parser preserves the encoded `%25`. Reject anything
  // that smells like a zone-id rather than relying on downstream filters.
  if (parsed.hostname.includes("%")) {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "IPv6 zone-id not allowed", agent_url: raw },
      400,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(hostname)) {
    throw new AgentResolverError(
      "request_signature_invalid_agent_url",
      { reason: "cloud metadata host blocked", agent_url: raw },
      400,
    );
  }
  return parsed;
}

/**
 * Compute eTLD+1 of `hostname` from the pinned PSL snapshot bundled with
 * `tldts`. For raw IP literals there is no eTLD+1 — return the hostname
 * itself so the rate-limiter still has a stable bucket key.
 */
export function etldPlusOne(hostname: string): string {
  // `tldts.getDomain` returns null for IP literals and unknown TLDs; in
  // both cases the hostname itself is the right key.
  const d = getDomain(hostname, { allowPrivateDomains: false });
  return (d ?? hostname).toLowerCase();
}

/**
 * Body cap with streaming counter. Reads the response stream chunk by chunk,
 * aborting (and tearing down the underlying socket) the moment the byte
 * counter would exceed `maxBytes`. Does NOT trust `Content-Length` because
 * a hostile origin can lie.
 */
async function readWithCap(
  response: Response,
  maxBytes: number,
): Promise<{ body: Buffer; bytes: number }> {
  const cl = response.headers.get("content-length");
  if (cl !== null) {
    const declared = Number.parseInt(cl, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Cancel the stream so the underlying socket is freed promptly.
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new AgentResolverError(
        "request_signature_oversize_response",
        {
          reason: `Content-Length ${declared} exceeds cap ${maxBytes}`,
          http_status: response.status,
        },
      );
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { body: Buffer.alloc(0), bytes: 0 };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    // Streamed read so a 10 GB attacker payload never lands in memory.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new AgentResolverError(
          "request_signature_oversize_response",
          {
            reason: `streamed body exceeds cap ${maxBytes}`,
            http_status: response.status,
          },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return { body: Buffer.concat(chunks, bytes), bytes };
}

/**
 * Strict GET. Single hop, no redirects, body capped, host rate-limited.
 *
 * Caller passes `hostBucketKey` (eTLD+1 of the URL host) so the rate limiter
 * and the trace agree on the bucket key without re-parsing.
 */
export async function strictGet(
  url: string,
  opts: StrictFetchOptions,
): Promise<StrictFetchResult> {
  if (opts.rateLimiter && !opts.rateLimiter.consume(opts.hostBucketKey)) {
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      {
        reason: "per-host rate limit exceeded",
        http_status: 429,
      },
      429,
    );
  }
  const headers: Record<string, string> = {
    Accept: opts.acceptHeader ?? "application/json",
    "User-Agent": "AAO-AgentResolver/1.0",
  };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PER_STAGE_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await safeFetch(url, {
      method: "GET",
      headers,
      maxRedirects: 0,
      signal,
    });
  } catch (err) {
    // safeFetch throws on private IPs, redirect-with-no-location, etc.
    // Map these to surface-friendly resolver errors. We do NOT surface the
    // raw error message — it can contain DNS / IP fragments the spec says
    // we MUST not echo.
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      { reason: classifyFetchFailure(err) },
    );
  }
  // Reject any redirect status — we set maxRedirects:0, so safeFetch will
  // return the 3xx as-is. We refuse to follow.
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new AgentResolverError(
      "request_signature_brand_json_unreachable",
      { reason: "upstream returned redirect", http_status: response.status },
    );
  }
  const { body, bytes } = await readWithCap(response, opts.maxBytes);
  return { body, bytes, status: response.status, headers: response.headers };
}

function classifyFetchFailure(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("private") || msg.includes("internal")) return "blocked private network";
    if (msg.includes("timeout") || (err as { name?: string }).name === "TimeoutError") return "timeout";
    if (msg.includes("redirect")) return "redirect refused";
    if (msg.includes("dns")) return "dns resolution failed";
  }
  return "fetch failed";
}
