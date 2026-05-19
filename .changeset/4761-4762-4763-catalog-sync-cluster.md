---
"adcontextprotocol": minor
---

Catalog sync cluster (3.1): three companion proposals for catalog mirroring between AdCP agents and consumers (storefronts, federated marketplaces, registries). Independent and complementary — agents MAY adopt any subset.

**#4762 — `get_signals` wholesale discovery mode**
- `signals/get-signals-request.json` adds `discovery_mode` enum (`brief` default, `wholesale`). Wholesale mode bans `signal_spec` / `signal_ids` and returns the agent's full priced catalog, paginated. Symmetric with `get_products buying_mode: "wholesale"`.
- `signals/get-signals-response.json` adds `incomplete[]` (scopes: `signals`, `pricing`, `catalog`) so partial completion is signalled inline rather than via async/Submitted handoff. `signals` becomes conditionally required (omitted when `unchanged: true`).
- `protocol/get-adcp-capabilities-response.json` adds `signals.discovery_modes`. Agents not declaring `"wholesale"` MAY return `INVALID_REQUEST` for wholesale calls.
- `docs/signals/tasks/get_signals.mdx` documents wholesale enumeration, authorization/provenance preservation for marketplace signals, pricing scope, and capability probing.

**#4761 — `catalog_version` conditional fetch (ETag-style)**
- `media-buy/get-products-request.json` and `signals/get-signals-request.json` add `if_catalog_version` and `if_pricing_version` opaque tokens.
- `media-buy/get-products-response.json` and `signals/get-signals-response.json` add `catalog_version`, `pricing_version`, and `unchanged`. When `unchanged: true`, `products` / `signals` MUST be omitted and `catalog_version` MUST be echoed — encoded as an explicit `oneOf` so the unchanged response is schema-valid without breaking the standard required-payload contract.
- Tokens are opaque and scoped to the request-parameter tuple that produced them. Pre-v3.1 agents that ignore the conditional fields simply return the full payload — semantically correct, just inefficient.
- Pagination interaction: if the catalog mutates mid-pagination, sellers SHOULD return the new `catalog_version` on each page; consumers SHOULD restart from `cursor: null` on a mid-pagination version change.

**#4763 — Per-agent catalog change feed**
- New `specs/catalog-change-feed.md` modeled on `specs/registry-change-feed.md`. UUID-v7 cursor-based event log, one feed per agent, denormalized payloads, optional webhook subscriptions.
- Event types: `product.{created,updated,priced,removed}`, `signal.{created,updated,priced,removed}`, `catalog.bulk_change` (fast-forward for rate-card sweeps).
- `protocol/get-adcp-capabilities-response.json` adds top-level `catalog_change_feed` declaration (`supported`, `retention_window_days` ≥7, `webhooks_supported`, `event_types[]`).
- Endpoints (`GET /catalog/events`, `POST /catalog/subscriptions`) live on the agent itself, not the registry. Authorization scope mirrors wholesale enumeration.

Additive across the board: new optional fields, new conditional schemas, new capability stanzas, new spec doc. No breaking changes; safe in a minor release. Agents MAY implement any combination: conditional-fetch alone for cheap probes against stable catalogs, the full feed for high-frequency mirroring, wholesale-only as a transitional step. Reference implementations land in the prebid salesagent as part of v3.1 conformance prep.

Refs #4761, #4762, #4763.
