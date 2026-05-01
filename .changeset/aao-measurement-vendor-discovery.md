---
---

feat(registry): measurement-vendor discovery on `/api/registry/agents` (#3613)

Implements the AAO server-side half of per-metric catalog discovery:
the crawler now ingests each measurement agent's
`get_adcp_capabilities.measurement` block (AdCP 3.x, schema in #3652)
and the public `/api/registry/agents` endpoint exposes filters that
let buyer agents shop for measurement vendors without fanning out per
agent.

**Endpoint extension (not a new endpoint).** Three new query params on
the existing `GET /api/registry/agents`. All three imply
`type=measurement` when present; an explicit non-measurement type
returns 400.

| Param | Match | Notes |
|-------|-------|-------|
| `metric_id=attention_units` | Exact, repeatable | JSONB `@>` containment on `metrics[].metric_id`. |
| `accreditation=MRC` | Exact, repeatable | JSONB containment on `metrics[].accreditations[].accrediting_body`. Vendor-asserted (`verified_by_aao` is always `false`). |
| `q=attention` | Substring on `metric_id` | v1 scope only. Max 64 chars; SQL wildcards rejected outright (not escaped — `q` is a substring search, never a pattern). |

Filtering happens at SQL level via the snapshot table, so no live
fan-out per request. `sources: { registered, discovered }` counts are
recomputed against the filtered set so the
`sum(sources) === count` invariant holds for downstream UIs.

When `?capabilities=true`, the response folds in
`capabilities.measurement_capabilities` next to the existing
`creative_capabilities` and `signals_capabilities` — flat siblings,
no umbrella rename. Backward-compatible.

**Crawler extension.** `CapabilityDiscovery.discoverCapabilities` now
calls `get_adcp_capabilities` when the agent exposes the tool, parses
out the `measurement` block, and persists it to the new
`measurement_capabilities_json` column on `agent_capabilities_snapshot`.
A 10-second timeout matches the existing `tools/list` budget. A
measurement-block fetch failure does not fail the whole discovery —
sales / creative / signals capabilities still land normally.

**Hostile-vendor defense (must-fix items from the security review).**
- Per-field caps enforced at write time, before the JSON is persisted:
  `metrics.length ≤ 500`, `description ≤ 2000`, `metric_id ≤ 256`,
  URI fields ≤ 2048, `accreditations` per metric ≤ 32. A vendor
  publishing a 50 MB description or a 100k-metric catalog is rejected
  with a clear error — visible in the registry panel via
  `discovery_error`, not silently truncated.
- Belt-and-braces 256 KB DB CHECK on the column itself
  (`measurement_capabilities_size_cap` in migration 461) — catches any
  future code path that bypasses the validator.
- Control characters stripped from text fields (keeps `\t` and `\n`,
  drops C0 + DEL).
- Scriptish content (`<script`, `javascript:`, inline event handlers,
  `data:text/html`) rejected after Unicode normalization (NFKC).
- URI fields are `https:` only in production (`http:` allowed in dev).
- `q=` filter rejects user wildcard characters (`%`, `_`) outright;
  remaining ILIKE escaping uses the `ESCAPE '\\'` pattern from
  `catalog-db.ts`.

**Migrations.**

- `461_measurement_capabilities_snapshot.sql` adds the JSONB column,
  the 256 KB CHECK constraint, and a GIN index for containment queries.

**Doc updates.**

- `docs/registry/index.mdx`: filter table, examples, and a
  direct-call-vs-AAO-index decision matrix (folds in #3614 — buyer-agent
  pattern documentation).

**Out of scope (filed as follow-ups).** Description / standard fuzzy
search (v2 of `q`); cache-key collision audit on
`CapabilityDiscovery.cache`; downstream renderer hardening
(`rel="noopener noreferrer"` recommendation for `methodology_url` /
`evidence_url`); the existing dashboard `innerHTML` audit.

Closes #3613, closes #3614.
