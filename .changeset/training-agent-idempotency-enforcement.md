---
---

Enforce idempotency replay/conflict/expired semantics in the training agent (closes #2346).

The hosted training agent at `https://test-agent.adcontextprotocol.org` declares
`adcp.idempotency.replay_ttl_seconds = 86400` in `get_adcp_capabilities` but
previously ignored `idempotency_key` on mutating requests — two `create_media_buy`
calls with the same key and same payload created two distinct resources, and key
reuse with a different payload succeeded instead of returning `IDEMPOTENCY_CONFLICT`.
Buyer SDKs integrating against this reference agent shipped without testing their
retry/conflict paths.

A new middleware (`server/src/training-agent/idempotency.ts`) now implements the
behavior documented in `docs/building/implementation/security.mdx` and validated
by `static/compliance/source/universal/idempotency.yaml`:

- Schema validation of `idempotency_key` presence and format (`^[A-Za-z0-9_.:-]{16,255}$`)
  runs before the cache lookup on all 26 mutating tools.
- Canonical-payload hash (RFC 8785 JCS via the `canonicalize` package +
  SHA-256) excludes `idempotency_key`, `context`, `governance_context`, and
  `push_notification_config.authentication.credentials`. Hash comparison uses
  `timingSafeEqual` on the decoded digests.
- Same key + equivalent canonical payload → cached response returned verbatim
  with `replayed: true` on the envelope (omitted on fresh executions).
- Same key + different canonical payload within TTL → `IDEMPOTENCY_CONFLICT`
  (error body carries code + message only — no cached payload, hash, or field
  pointer; schema-shape leaks would turn key-reuse into a read oracle).
- Past TTL (with ±60s skew) → `IDEMPOTENCY_EXPIRED` and evict so the key can
  be reused on a subsequent fresh request.
- Only successful responses are cached; errors re-execute on retry. Tools that
  return `{ errors: [...] }` in-body are also not cached.
- Cache is scoped by `(auth principal, account scope, idempotency_key)`. The
  public sandbox token would otherwise pool every caller into one oracle;
  per-account partitioning closes the cross-caller probe surface
  (security.mdx §"three-state response").
- Per-principal cap (10k entries) with opportunistic sweep of expired entries
  on overflow; when the cap is still hit, responds with `RATE_LIMITED` rather
  than silently dropping the insert (which would let a retry re-execute).
