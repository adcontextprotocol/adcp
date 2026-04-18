---
---

Pre-3.0 vocabulary alignment across the compliance catalog.

**`domains/` → `protocols/`.** Renamed the compliance folder, specialism YAML field, and schema enum to match the wire term `supported_protocols`. Eliminates the overloaded use of "domain" (which elsewhere in the codebase means DNS domain).

- Folder: `static/compliance/source/domains/` → `protocols/`. Published path `/compliance/{version}/protocols/{protocol}/`.
- Specialism YAML field: `domain:` → `protocol:` (21 files).
- Schema enum: `enums/adcp-domain.json` → `enums/adcp-protocol.json`. $refs updated in `tasks-list-request.json`, `mcp-webhook-payload.json`, and the schema registry index.
- Build script, docs, server consumers updated.

**Transitional aliases for `@adcp/client@5.x` compatibility.** The build emits both `protocols` (canonical) and `domains` (deprecated alias) keys in `index.json`, and physically writes both `protocols/{id}/` and `domains/{id}/` directories. Specialism entries in `index.json` include both `protocol:` and `domain:` fields. Drop after `@adcp/client@6.x` ships — that version reads `protocols` directly.

**Reclassify `audience-sync`** under `media-buy` (was `governance`) so it sits alongside its required tools (`sync_audiences`, `list_accounts`). Fresh-builder test rated `audience-sync` the worst specialism for orientation — the misclassification was the blocker. Catalog includes a migration note for agents that currently list only `governance` in `supported_protocols`.

**Normalize storyboard category IDs.** Mechanical rule: `category = specialism_id.replace('-', '_')`; variants use `{category}/{variant}` path form. Renames: `media_buy_guaranteed_approval` → `sales_guaranteed`, `media_buy_non_guaranteed` → `sales_non_guaranteed`, `media_buy_proposal_mode` → `sales_proposal_mode`, `media_buy_catalog_creative` → `sales_catalog_driven`, `media_buy_broadcast_seller` → `sales_broadcast_tv`, `social_platform` → `sales_social`, `property_governance` → `inventory_lists`, `campaign_governance_delivery` → `governance_delivery_monitor`, `campaign_governance_conditions` → `governance_spend_authority`, `campaign_governance_denied` → `governance_spend_authority/denied`, `media_buy_generative_seller` → `creative_generative/seller`. Agents implementing the comply-test-controller must update scenario labels they return.

**`accounts` is a foundation, not a protocol.** Documented in the catalog: `sync_accounts`, `list_accounts`, and `sync_governance` are prerequisites every media-buy/creative/signals agent implements implicitly. Intentionally absent from `supported_protocols`.

**Discoverability.** Surface each specialism's `required_tools` in `/compliance/{version}/index.json` so agents find tool families without reading the full storyboard YAML. Stable specialisms must declare at least one `required_tool` or the build fails.

**Catalog docs.** Added a "Naming conventions" section covering the four casings (wire `snake_case`, specialism IDs `kebab-case`, storyboard `id:`/`category:` snake_case, prose titles). Added `enumDescriptions` to `signal-catalog-type.json` defining `marketplace`, `owned`, and `custom`. Rewrote the "Choose a skill" section in `build-an-agent.mdx` to link each SDK's skills directory instead of pretending skills are aligned across languages.

**Wire-field rename in this PR.** `filters.domain`/`filters.domains` on `tasks-list-request` renamed to `filters.protocol`/`filters.protocols`; `sort.field` enum value `"domain"` → `"protocol"`. The `domain` property on `mcp-webhook-payload.json` renamed to `protocol`. No active consumers found.

**`compliance_testing` removed from `supported_protocols` enum.** It was a feature flag masquerading as a protocol (forcing special-case carve-outs in the runner, docs, and schema). Agents now declare support by including the existing `compliance_testing: { scenarios: [...] }` capability block on `get_adcp_capabilities` — the block's presence is the signal. Training agent and docs updated.

**Follow-ups flagged for a separate PR.**
- Auto-imply protocols from declared specialisms (claiming `sales-guaranteed` implies `media_buy`), making `supported_protocols` additive-only. 3.0 would deprecate + warn; removal would land in 4.0 per AdCP's major-version removal policy (consistent with the v2 sunset pattern).

Closes #2285, #2287.
