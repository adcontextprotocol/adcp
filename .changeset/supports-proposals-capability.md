---
"adcontextprotocol": minor
---

feat(media-buy): `supports_proposals` capability flag — closes #3844

Adds a wire-level capability flag at `media_buy.supports_proposals` (boolean) so the storyboard runner can gate `proposal_finalize` cleanly, and folds the scenario into `sales-guaranteed.requires_scenarios`.

`get-adcp-capabilities-response.json`:
- New `media_buy.supports_proposals` boolean. A declaration of `true` is a commitment the seller will be graded against (return at least one entry in `proposals[]` for `buying_mode: 'brief'`; honor `action: 'finalize'` to transition draft → committed), not just a feature flag. Full-service guaranteed sellers (premium pubs, broadcast, CTV) declare `true`; auction-based PG, retail SKU, and quoted-rate direct-buy flows declare `false`.

`media-buy/scenarios/proposal_finalize.yaml`:
- Adds `requires_capability: { path: media_buy.supports_proposals, equals: true }`. Sellers that explicitly declare `false` skip the scenario as `capability_unsupported`; sellers that declare `true` (or omit the field per the runner's absence semantics) are graded against it.

`specialisms/sales-guaranteed/index.yaml`:
- Adds `media_buy_seller/proposal_finalize` to `requires_scenarios`. Now safe — capability-gated. Narrative updated to remove the "tracked at #3844" caveat.

`specialisms/sales-proposal-mode/index.yaml` and `enums/specialism.json`:
- Deprecation note for `sales-proposal-mode` updated to point sellers at the migration path: drop the specialism, declare `sales-guaranteed` plus `media_buy.supports_proposals: true`. Storyboard retained through 3.x for backward compat; removed at 4.0.

Refs: #3823 (taxonomy consolidation), #3840 (sales-proposal-mode deprecation), #3844 (this).
