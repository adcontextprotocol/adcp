---
"adcontextprotocol": minor
---

spec(errors): register `STALE_RESPONSE` for cache-fallback served when an upstream is unreachable (#4899)

The existing error vocabulary covered the binary "upstream unreachable, no response" case (via `SERVICE_UNAVAILABLE`) but had no registered code for the **degraded-but-functional** case: an upstream or sub-agent is unreachable now, but the seller has a cached prior response and serves that cache instead of returning empty. Without a standard code, every seller either invents a discriminator (`STALE_CACHE` / `CACHED_FALLBACK` / `DEGRADED_RESPONSE` / ...) or returns `SERVICE_UNAVAILABLE` with a populated payload — internally contradictory, since the call did succeed from the caller's POV.

This change:

- Adds `STALE_RESPONSE` to `static/schemas/source/enums/error-code.json`. Recovery: `transient`. Emitted **alongside** a populated success payload as a non-fatal advisory in `errors[]`; transport-level success markers stay flipped to success (HTTP 200, MCP `isError: false`, A2A `succeeded`). Sibling to the existing per-asset advisory family (`PIXEL_TRACKER_LOSSY_DOWNGRADE`, `FORMAT_DECLARATION_V1_LOSSY_MULTI_SIZE`).
- Adds `error-details/stale-response.json` — required `served_from_cache: true` + `cache_age_seconds`, optional `freshness_target_seconds`, `upstream: {url, name}`, and `original_error: {code, message}`. Multi-upstream cases emit one `STALE_RESPONSE` entry per stale upstream (mirroring the per-asset advisory precedent), not one aggregated entry.
- Adds the System-errors-table row in `docs/building/by-layer/L3/error-handling.mdx` with the distinction from `SERVICE_UNAVAILABLE` (empty payload + fatal).
- Adds the disposition entry in `scripts/error-code-drift-dispositions.json` (`held-for-next-minor`, `target_version: 3.1`).

**Normative wire rules.** Sellers MUST emit `STALE_RESPONSE` only when the response payload is non-empty AND derived from a cache entry past the surface's freshness target. When no cached entry exists or the cache hit is within freshness target, sellers MUST NOT emit this code. Buyers MUST treat as non-fatal and SHOULD surface staleness to operators or end users where relevant; `cache_age_seconds` is the informational knob for the buyer's retry policy.

Closes #4899.
