---
"adcontextprotocol": minor
---

spec(creative): add `list_transformers` task + account-scoped creative transformers, and extend `build_creative` for transformer selection and variant/catalog multiplicity.

A **transformer** is the creative analog of a media-buy product: an agent-offered, account-scoped, selectable unit of build capability (a voice, model, style, or director) with a typed configuration surface and per-account pricing. This makes account-specific render configuration — including custom values like cloned voices that exist only for one credential — discoverable from the agent rather than guessed, hung on a global format, or smuggled through `ext`.

Strictly additive. Existing `build_creative` callers are unaffected (all new request fields are optional; the shipped `BuildCreativeSuccess`/`BuildCreativeMultiSuccess` response shapes are unchanged — a new fifth member is added alongside them).

New:
- `list_transformers` task (creative protocol): account-scoped, brief-filterable, paginated discovery. An `expand_params` mode returns account-scoped enumerable option **values** (e.g. your configured voices) on the same tool — no separate options endpoint.
- Core schemas `transformer.json` and `transformer-param.json`.
- `get_adcp_capabilities` → `creative.supports_transformers` discriminator.

`build_creative` extensions:
- Request: `transformer_id` (select one transformer; target format(s) must be a subset of its `output_format_ids`), `config` (typed bag keyed to the transformer's params — agents MUST reject unknown/out-of-range values), `max_creatives` (catalog/item fan-out: N distinct creatives, one per item, with sampling), `max_variants` + `variant_axis` + `keep_mode` (alternatives per creative).
- Response: a new `BuildCreativeVariantSuccess` member — `creatives[]` each carrying `variants[]`, with a `build_variant_id` namespace (distinct from preview `preview_id` and served `variant_id`), per-leaf pricing receipt, and `items_total`/`items_returned`. Best-of-N is variants + `recommended`/`rank`. You pay for all produced variants (`per_unit` × N); a kept variant lazily earns a `creative_id` on trafficking, which flows to `report_usage`. Per-format atomic; per-item non-atomic.

Pricing rides the existing `per_unit` model + inline receipt + `report_usage` unchanged — transformers carry `pricing_options` (reusing `vendor-pricing-option.json`).

Deprecations (deprecated in 3.1, removed at 4.0; SDKs MUST keep honoring them through 3.1–3.x): `Format.input_format_ids`, `Format.output_format_ids`, `Format.pricing_options`, and the `input_format_ids`/`output_format_ids` discovery filters on `list_creative_formats` — all superseded by `list_transformers`, which carries each transformer's own I/O signature and pricing.
