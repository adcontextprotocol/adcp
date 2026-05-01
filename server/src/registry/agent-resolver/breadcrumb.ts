/**
 * Trace breadcrumb builder for the AAO `/api/registry/agents/resolve`
 * endpoint.
 *
 * Per spec §"Trace / freshness on the resolve endpoint":
 *
 * - One entry per upstream HTTP call (capabilities → brand_json → jwks).
 * - Privacy-filtered: query strings stripped, IPs not echoed, request
 *   headers not echoed, redirect chains not echoed (disallowed anyway),
 *   string fields HTML-escaped before reflection.
 * - On failure, the trace renders up to the failed step (marked
 *   `ok: false` with the matching `request_signature_*` error code in
 *   `error.code`); subsequent steps are absent (not nulled).
 * - Aggregate `freshness` ∈ `{fresh, stale, unknown}` derived from
 *   per-step age vs declared TTL.
 */
import escapeHtml from "escape-html";
import type { AgentResolverErrorCode } from "./errors.js";

export type TraceStepName = "capabilities" | "brand_json" | "jwks";

export interface TraceStep {
  step: TraceStepName;
  url: string;
  method: "GET" | "MCP_CALL";
  status: number | null;
  etag: string | null;
  last_modified: string | null;
  cache_control: string | null;
  fetched_at: string;
  age_seconds: number;
  bytes: number;
  from_cache: boolean;
  ok: boolean;
  error?: { code: AgentResolverErrorCode; message?: string };
}

export type Freshness = "fresh" | "stale" | "unknown";

/**
 * Strip query string from a URL (privacy). On parse failure, return the
 * input unchanged after HTML-escaping — never echo malformed bytes raw.
 */
function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return escapeHtml(url);
  }
}

function escapeMaybe(value: string | null): string | null {
  return value === null ? null : escapeHtml(value);
}

export class BreadcrumbBuilder {
  private readonly steps: TraceStep[] = [];

  /** Append a successful step. `fetched_at` defaults to now. */
  record(input: {
    step: TraceStepName;
    url: string;
    method: "GET" | "MCP_CALL";
    status: number;
    etag?: string | null;
    last_modified?: string | null;
    cache_control?: string | null;
    bytes: number;
    from_cache: boolean;
    fetched_at?: string;
  }): void {
    const fetched_at = input.fetched_at ?? new Date().toISOString();
    const age_seconds = ageSeconds(fetched_at);
    this.steps.push({
      step: input.step,
      url: stripQuery(input.url),
      method: input.method,
      status: input.status,
      etag: escapeMaybe(input.etag ?? null),
      last_modified: escapeMaybe(input.last_modified ?? null),
      cache_control: escapeMaybe(input.cache_control ?? null),
      fetched_at,
      age_seconds,
      bytes: input.bytes,
      from_cache: input.from_cache,
      ok: input.status >= 200 && input.status < 300,
    });
  }

  /** Append a failed step. */
  recordFailure(input: {
    step: TraceStepName;
    url: string;
    method: "GET" | "MCP_CALL";
    status: number | null;
    code: AgentResolverErrorCode;
    message?: string;
    bytes?: number;
    fetched_at?: string;
  }): void {
    const fetched_at = input.fetched_at ?? new Date().toISOString();
    this.steps.push({
      step: input.step,
      url: stripQuery(input.url),
      method: input.method,
      status: input.status,
      etag: null,
      last_modified: null,
      cache_control: null,
      fetched_at,
      age_seconds: ageSeconds(fetched_at),
      bytes: input.bytes ?? 0,
      from_cache: false,
      ok: false,
      error: {
        code: input.code,
        message: input.message ? escapeHtml(input.message).slice(0, 200) : undefined,
      },
    });
  }

  build(): { trace: TraceStep[]; freshness: Freshness } {
    return {
      trace: this.steps,
      freshness: computeFreshness(this.steps),
    };
  }
}

function ageSeconds(fetchedAt: string): number {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function computeFreshness(steps: TraceStep[]): Freshness {
  if (steps.length === 0) return "unknown";
  let allHaveTtl = true;
  let anyStale = false;
  for (const s of steps) {
    if (!s.ok) continue;
    const ttl = parseMaxAge(s.cache_control);
    if (ttl === null) {
      allHaveTtl = false;
      continue;
    }
    if (s.age_seconds > ttl) anyStale = true;
  }
  if (!allHaveTtl) return "unknown";
  return anyStale ? "stale" : "fresh";
}

/** Parse `max-age=N` from a `Cache-Control` header. Returns null when
 * absent / malformed. We don't try to interpret `s-maxage` or
 * `must-revalidate` here — `max-age` is the only directive the spec uses
 * for freshness aggregation. */
export function parseMaxAge(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(?:^|[,\s])max-age=(\d+)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
