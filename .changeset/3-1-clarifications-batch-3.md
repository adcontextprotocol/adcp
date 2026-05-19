---
"adcontextprotocol": minor
---

spec(3.1): pre-GA clarifications batch #3 — per-format error attribution on `build_creative` + sales-guaranteed submitted-vs-sync contract.

Two real spec clarifications surfaced during the 3.1 cluster work.

**#4556 — Per-format error attribution on `BuildCreativeError`.** The multi-format `build_creative` contract is **atomic** (already documented on `BuildCreativeMultiSuccess`: "all formats must succeed or the entire request fails") — so the issue's framing of "partial success with some manifests + some errors" is non-conformant. What the spec was missing is the per-format attribution convention on the error response, so buyers can identify *which* format(s) caused the batch to fail and retry only the failing subset. Added normative guidance on `BuildCreativeError.errors[]`:

- `error.field` carries `target_format_ids[N]` (zero-based index) — required when the error is format-scoped, mirrors the JSONPath-lite convention used elsewhere
- `error.details.format_id` carries the resolved `format_id` value — required when the error is format-scoped, lets buyers dispatch on format identity without re-parsing `field`
- Whole-batch errors (auth, governance denial, transport-level) MAY omit both
- Sellers SHOULD emit one error per failing format rather than collapsing — keeps per-format recovery routing unambiguous
- Per-format `correctable` errors are scoped to the named format only; buyers may retry just that format with corrected input

This is the spec-level diagnostic surface for the agentic self-correction loop the issue identifies — the atomicity rule stays, but buyers no longer have to retry the whole batch to figure out which format failed.

**#3822 — Sales-guaranteed submitted-vs-sync contract.** The skill ↔ storyboard contradiction surfaced during matrix-blind fixture runs: an SDK skill in adcp-client (`build-seller-agent`) instructed sales-guaranteed agents to return a task envelope for every `create_media_buy`. The `sales_guaranteed` compliance storyboard runs **multiple** create_media_buy paths and only one expects `submitted` — four shared scenarios (measurement_terms_rejected, pending_creatives_to_start, inventory_list_targeting, invalid_transitions) expect synchronous `media_buy_id` returns against the non-guaranteed fixture products listed first in the storyboard. A blind agent following the skill fails 5 of 5 grader steps.

Resolution at the spec layer: added a `### When to return Submitted vs synchronous Success (normative)` section to `docs/media-buy/task-reference/create_media_buy.mdx` documenting that the choice is **per-call**, driven by per-product `delivery_type` + the seller's `requires_io_approval` capability — not a uniform per-seller rule. Conformant SDK skills MUST NOT instruct agents to return `submitted` for every `create_media_buy` regardless of input. Cross-references the `sales-guaranteed` specialism storyboard fixture pattern (non-guaranteed products listed first so open-brief `get_products` calls resolve to synchronous-create paths). Names the issue explicitly so future readers / future SDK skill audits land on the correct contract.

The SDK skill itself lives in adcp-client and will need a follow-up fix there; this PR closes the spec-side ambiguity that allowed the bad skill to ship.

Files:
- `static/schemas/source/media-buy/build-creative-response.json` — `BuildCreativeError` description + `errors` field gain per-format attribution convention
- `docs/media-buy/task-reference/create_media_buy.mdx` — new "When to return Submitted vs synchronous Success" section after the Submitted Response shape

Closes #4556. Refs #3822 (spec-side resolution; SDK-side skill fix tracked in adcp-client).
