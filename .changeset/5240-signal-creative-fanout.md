---
"adcontextprotocol": minor
---

spec(creative): signal-driven creative fan-out (`signal_conditions[]`) + item-selection strategy (`selection_strategy`), folding #5262.

DRAFT RFC for #5240 (Refs, not Closes — per `docs/governance/rfc-process.mdx` an RFC spec PR cannot merge until an accepted WG decision record exists on #5240). Adds a keep-all PRODUCTION axis for signals to `build_creative`, sibling to the catalog fan-out axis (`max_creatives`, #5219) and distinct from the choose-among `variant_axis`. Rides #5280's advisory-pointer contract: signal pointers inform production but MUST NOT hard-block at the build layer; trafficking-compatibility is enforced reject-at-trafficking on the sales side.

Strictly additive — no existing agents break. All new fields optional and gated by new capability flags; agents that don't advertise `supports_signal_fanout` behave exactly as today.

- `media-buy/build-creative-request.json` — optional `signal_conditions: SignalTargeting[]` (reuses `core/signal-targeting.json` verbatim, NOT a new minted signal-ref) and optional `selection_strategy` (new enum).
- `enums/creative-selection-strategy.json` — NEW closed string enum `[audience_relevance, proximity, inventory_priority, random]` (folds #5262; mirrors the closed shape of `creative-quality.json`).
- `protocol/get-adcp-capabilities-response.json` — `creative.multiplicity`: `supports_signal_fanout`, `max_signal_conditions_limit` (clamp like `max_creatives_limit`), `selection_strategies[]`.
- `media-buy/build-creative-response.json` — `BuildCreativeVariantSuccess.creatives[].signal_condition` + top-level `selection_strategy_applied`; `BuildCreativeEstimate.estimate.conditions_total`.
- `enums/error-code.json` — `SIGNAL_TARGETING_INCOMPATIBLE` (recovery: correctable) in enum + `enumDescriptions` + `enumMetadata`. The normative cross-agent trafficking-compat MUST that warrants the RFC.
- `docs/creative/buyer-attached-inputs.mdx`, `docs/creative/task-reference/build_creative.mdx`, `docs/signals/specification.mdx`, `docs/media-buy/task-reference/create_media_buy.mdx` — request/response field docs, the trafficking-compatibility contract narrative, and the reject-at-trafficking note.

Refs #5240, #5262, #5219, #5280.
