---
"adcontextprotocol": minor
---

Brand protocol gains `verify_brand_claims` — the bulk variant of `verify_brand_claim`. Same four claim types (`subsidiary`, `parent`, `property`, `trademark`), same per-claim semantics, one MCP round-trip and one rate-limit slot for up to 100 claims. Use when a caller (crawler refreshing a brand portfolio, creative-clearance pipeline batch, inventory-onboarding scan) needs to verify many claims against one brand-agent and per-call overhead dominates.

**Sibling tool, not a mode flag.** `verify_brand_claim` stays as-is for one-off verifications; `verify_brand_claims` is the dedicated bulk surface. Cleaner schemas (no single-vs-bulk discriminator inside one tool), cleaner capability advertisement (each tool is advertised independently in `supported_tasks`), cleaner error semantics (per-result errors don't mix with single-target failures).

**Order is preserved.** Agents MUST return `results[]` in the same order as the request's `claims[]` (positional zip-by-index). Callers pass a position-indexed batch and consume results by index.

**Partial-failure semantics.** Per-claim failures (`UNSUPPORTED_CLAIM_TYPE` for one item, `AMBIGUOUS_MATCH` on one trademark query) ride on a per-result `error` field and do NOT fail the batch. Top-level `errors[]` is reserved for batch-level failures (auth, rate-limit, malformed request, over-cap claim count) — when set, `results` is absent. The two are mutually exclusive at the wire.

**Caching.** Top-level `Cache-Control: max-age` represents the lowest-common max-age across the batch. Per-result staleness varies by status; callers needing finer cache control should split batches by expected volatility or re-verify volatile claims individually.

**Rate-limiting.** A bulk call consumes one rate-limit slot per call, not per result. A batch of 100 hits the per-`{caller, query-target}` limit once. Agents SHOULD size bulk limits in calls/window when bulk is advertised.

**Trust model unchanged and unshortened.** Mutual assertion still requires calling both sides — a `subsidiary` result returning `owned` inside a bulk batch still requires a separate `parent` call against the leaf-side agent. Bulk is round-trip economy, not a trust-model shortcut.

**Schema additions:**
- `brand/verify-brand-claims-request.json` — `claims[]` array with the per-item discriminator on `claim_type`. Max batch size 100; agents MAY enforce lower.
- `brand/verify-brand-claims-response.json` — success arm carries `results[]` aligned to the request; per-result success mirrors `verify-brand-claim-response.json` success arm, per-result error carries an `error` field. Error arm carries batch-level `errors[]`.

**No changes to `verify_brand_claim`.** Single-target tool ships unchanged; the bulk variant is purely additive. Capability advertisement is per-tool — agents MAY ship one, the other, or both. A `supported_claim_types` declaration applies to both tools when both are advertised.
