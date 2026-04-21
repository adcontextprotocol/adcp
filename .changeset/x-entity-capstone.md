---
"adcontextprotocol": patch
---

spec + tooling: complete the `x-entity` annotation rollout (#2660 phase 4, capstone)

Annotates the final three domains (property/, collection/, sponsored-intelligence/), ships the mechanical annotation script as a committed artifact, and wires a coverage counter into build output. Closes #2660.

Registry addition:
- `offering` — brand-published offering (campaign, promotion, product set, service). `offering_id` in core/offering.json, sponsored-intelligence/si-get-offering-*, sponsored-intelligence/si-initiate-session-request, and as a catalog item-type id when `core/catalog.json::type` is `offering`.

Shared-type annotations (propagate via `$ref`):
- `core/offering.json::offering_id` → `offering`
- `core/property-id.json` (root) → `property`
- `core/property-list-ref.json::list_id` → `property_list`
- `core/collection-list-ref.json::list_id` → `collection_list`

Domain leaves:
- **sponsored-intelligence/**: 10 annotations (session_id, offering_id, media_buy_id on initiate-session)
- **property/**: 8 annotations on list_id across CRUD + validation + webhook schemas
- **collection/**: 6 annotations on list_id across CRUD schemas

Tooling shipped (DX expert recommendations):
- `scripts/add-x-entity-annotations.mjs` — committed, config-driven patch script (reads `scripts/x-entity-field-map.json`). Overlay maps handle domain-specific ambiguities (list_id, plan_id, pricing_option_id).
- `scripts/x-entity-field-map.json` — canonical field→entity map, extensible for future PRs.
- Coverage counter in `npm run build:compliance` and `npm run test:storyboard-context-entity` output — honest signal counting annotations across domains and registry usage, without inflating the denominator with catalog-item-internal ids or dedup keys.
- `npm run check:x-entity-gaps` — advisory-only lister of un-annotated id-shaped fields per domain, for authors adding new schemas.

Closes [issue #2660](https://github.com/adcontextprotocol/adcp/issues/2660). Follow-up #2685 remains open for the inline-vs-registry `governance_policy` schema-shape split.
