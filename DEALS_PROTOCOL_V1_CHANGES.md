# Deals Protocol v1 – List of Changes

This document lists all changes made to add the Deals protocol (Phase 1) to the adcp repository.

---

## 1. New enum schemas (`static/schemas/source/enums/`)

| File | Description |
|------|-------------|
| `transaction-type.json` | PMP, PG, AP |
| `deal-state.json` | DRAFT, PROPOSED, ACCEPTED, SCHEDULED, LIVE, PAUSED, REJECTED, CANCELLED, COMPLETED |
| `deal-deployment-status.json` | PENDING, ACTIVE, FAILED, DISABLED |
| `deal-visibility.json` | PRIVATE, INVITE_ONLY, PUBLIC |

---

## 2. New core schemas (`static/schemas/source/core/`)

| File | Description |
|------|-------------|
| `deal.json` | Logical deal: deal_id, product_id, transaction_type, buyer_seat_id, state, version, accepted_version, terms, deployments[], visibility |
| `deal-terms.json` | Versioned terms: transaction_type, floor, bid_cap, commitment_units, makegood_rules, start_time, end_time |
| `deal-deployment.json` | Per-destination activation: deployment_id, platform_type, platform_name, account_id, platform_deal_id, deployment_status, error, updated_at |
| `deal-destination.json` | Activation destination: platform_type (DSP/SSP), platform_name, account_id, mode (CREATE_AND_SYNC, BIND_EXISTING) |

---

## 3. Extended existing schemas

### `static/schemas/source/core/product.json`

- **Added optional properties:**  
  `supported_transaction_types` (array of transaction-type),  
  `transaction_terms_by_type` (object),  
  `requires_channel_split` (boolean),  
  `deal_capabilities` (object with supports_bid_cap, supports_reject_over_under, supports_deal_level_reporting, supports_reason_codes, supports_multi_destination_activation).

### `static/schemas/source/core/product-filters.json`

- **Added optional property:**  
  `transaction_type` (ref to transaction-type enum) for filtering products by deal type (PMP, PG, AP).

---

## 4. New deals protocol schemas (`static/schemas/source/deals/`)

| Request | Response |
|---------|----------|
| `create-deal-request.json` | `create-deal-response.json` |
| `list-deals-request.json` | `list-deals-response.json` |
| `update-deal-terms-request.json` | `update-deal-terms-response.json` |
| `transition-deal-state-request.json` | `transition-deal-state-response.json` |
| `activate-deal-request.json` | `activate-deal-response.json` |
| `get-deal-activation-status-request.json` | `get-deal-activation-status-response.json` |
| `list-deal-mappings-request.json` | `list-deal-mappings-response.json` |
| `get-deal-metrics-request.json` | `get-deal-metrics-response.json` |
| `get-deal-diagnostics-request.json` | `get-deal-diagnostics-response.json` |

---

## 5. Schema registry and capabilities

### `static/schemas/source/index.json`

- **Core schemas:** Registered `deal`, `deal-terms`, `deal-deployment`, `deal-destination`.
- **Enums:** Registered `transaction-type`, `deal-state`, `deal-deployment-status`, `deal-visibility`.
- **Protocols:** Added `deals` protocol block with tasks: create-deal, list-deals, update-deal-terms, transition-deal-state, activate-deal, get-deal-activation-status, list-deal-mappings, get-deal-metrics, get-deal-diagnostics.

### `static/schemas/source/protocol/get-adcp-capabilities-response.json`

- **supported_protocols:** Added `"deals"` to the enum.
- **New top-level property:** `deals` (object), only when deals is in supported_protocols, with:
  - `supported_transaction_types` (required array: PMP, PG, AP),
  - `features` (optional: supports_bid_cap, supports_reject_over_under, supports_deal_level_reporting, supports_reason_codes, supports_multi_destination_activation).

---

## 6. Build and skills

### `scripts/build-schemas.cjs`

- **Bundling:** Added bundle patterns for `deals/*-request.json` and `deals/*-response.json`.
- **Skills:** Added `{ protocol: 'deals', skillName: 'adcp-deals' }` to the skills array.

### `skills/adcp-deals/`

- **New directory:** `skills/adcp-deals/` with `SKILL.md` (skill description and task summary).
- **Generated:** `skills/adcp-deals/schemas/` is populated by the schema build (no manual files added).

---

## 7. Documentation

### New docs (`docs/deals/`)

| File | Purpose |
|------|---------|
| `index.mdx` | Deals protocol overview, discovery via get_products, lifecycle, activation, monitoring, design principles |
| `specification.mdx` | Normative spec: scope, transport, deal states, transitions, activation, visibility, task summary, product/filter extensions |
| `task-reference/index.mdx` | Task reference index and schema URLs |
| `task-reference/create_deal.mdx` | create_deal task |
| `task-reference/list_deals.mdx` | list_deals task |
| `task-reference/update_deal_terms.mdx` | update_deal_terms task |
| `task-reference/transition_deal_state.mdx` | transition_deal_state task |
| `task-reference/activate_deal.mdx` | activate_deal task |
| `task-reference/get_deal_activation_status.mdx` | get_deal_activation_status task |
| `task-reference/list_deal_mappings.mdx` | list_deal_mappings task |
| `task-reference/get_deal_metrics.mdx` | get_deal_metrics task |
| `task-reference/get_deal_diagnostics.mdx` | get_deal_diagnostics task |

### `docs.json`

- **Navigation:** Added “Deals Protocol” group (for both default nav versions that include Media Buy and Creative) with:
  - `docs/deals/index`
  - `docs/deals/specification`
  - Task Reference subgroup with all 9 task-reference pages above.

### `README.md`

- **Protocols table:** Added Deals row: “PMP, PG, AP deal lifecycle, activation, diagnostics” with key tasks.
- **Repository structure:** Added `deals/` under `docs/`.

---

## 8. Design decisions (no separate get_product / get_deal)

- **Single-product detail:** Use **get_products** (Media Buy) with filters that target one product (e.g. product_id). No separate get_product task.
- **Single-deal fetch:** Use **list_deals** with `deal_ids: ["<deal_id>"]`. No separate get_deal task.

---

## Summary

- **New files:** 4 enums, 4 core schemas, 18 deals request/response schemas, 1 skill SKILL.md, 12 doc pages.
- **Modified files:** product.json, product-filters.json, index.json, get-adcp-capabilities-response.json, build-schemas.cjs, docs.json (2 nav blocks), README.md.
- **Build:** `npm run build:schemas` runs successfully and generates bundled schemas and `skills/adcp-deals/schemas/`.
