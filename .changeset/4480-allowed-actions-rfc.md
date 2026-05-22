---
"adcontextprotocol": minor
---

feat(media-buy): allowed_actions on products, available_actions on buys, structured ACTION_NOT_ALLOWED rejection

Adds a structured action vocabulary for `update_media_buy` capability discovery. Buyers can pre-flight which mutations are valid on a given buy in its current state instead of learning by mid-flight rejection. Composes with #4425's `requires` predicate grammar for caller-side requirement expression.

**Schema additions**

- `media-buy-valid-action` enum extended with finer-grained values: `extend_flight`, `shorten_flight`, `update_flight_dates`, `increase_budget`, `decrease_budget`, `reallocate_budget`, `update_targeting`, `update_pacing`, `update_frequency_caps`, `replace_creative`, `update_creative_assignments`, `remove_creative`, `remove_packages`. The coarse legacy values (`update_budget`, `update_dates`, `update_packages`, `sync_creatives`) are retained for 3.x backwards compatibility and removed in 4.0.
- `media-buy-action-mode` enum (new): `self_serve`, `conditional_self_serve`, `requires_proposal`, `requires_approval`.
- `action-not-allowed-reason` enum (new): `wrong_status`, `not_supported_on_product`, `not_supported_on_buy`, `mode_mismatch`.
- `sla-window` core object (new): optional `response_max` + `completion_max` ISO 8601 durations.
- `product-allowed-action` core object (new): `action` + `modes[]` + optional `allowed_statuses[]` + optional `sla` + optional `terms_ref`. Advisory template.
- `media-buy-available-action` core object (new): `action` + singular `mode` + optional `sla` + optional `terms_ref`. Authoritative per-buy resolution.
- `allowed_actions[]` on `product`: array of `product-allowed-action`.
- `available_actions[]` on `get_media_buys`, `create_media_buy`, and `update_media_buy` responses: array of `media-buy-available-action`. The existing `valid_actions[]` field is deprecated in favor of `available_actions[]`; sellers SHOULD populate both during the 3.x deprecation window, consumers MUST prefer `available_actions[]` when both are present, and `valid_actions[]` is removed in 4.0.
- `ACTION_NOT_ALLOWED` error code: populated with `attempted_action`, `reason`, and `currently_available_actions` in `error.details` so buyer SDKs can offer recovery without a separate `get_media_buys` round-trip. Typed details schema at `error-details/action-not-allowed.json`.
- `enumMetadata` on `media-buy-valid-action`: each entry carries `update_fields` (dotted paths into `update_media_buy` body) so SDKs and codegen can dispatch from schema metadata rather than parsing the field-mapping table. Legacy coarse values additionally carry `deprecated: true` and `rollup` (the finer-grained values that supersede them) so SDKs can hide deprecated values when rollup targets are present in the same payload.
- `allowed_actions[]` and `available_actions[]` arrays are uniquely keyed by `action`; sellers MUST NOT emit two entries with the same `action` value. Predicate evaluators consuming dotted paths like `available_actions.extend_flight.sla.response_max` MUST index by `action`.

**Documentation**

`docs/media-buy/task-reference/update_media_buy.mdx` adds the normative action → field mapping table (each action's exact `update_media_buy` fields), the mode table, and the relationship between flat `valid_actions[]` and structured `available_actions[]`.

**Composition with #4425**

The `requires` predicate grammar in #4425 queries `available_actions[]` as a first-class field. Field-level constraint metadata (bounds, max deltas) is out of scope for v1 and the natural home is `requires` rather than a parallel grammar. Duration predicates (e.g. `lte` on SLA `response_max`) extend the predicate vocabulary; tier-based SLA expression (`fast` / `standard` / `slow`) remains a possible alternative if the WG prefers to stay inside `equals`/`in`.

Refs #4480, #4425.
