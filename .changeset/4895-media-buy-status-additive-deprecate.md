---
"adcontextprotocol": minor
---

spec(media-buy): add `media_buy_status` field on create_media_buy and update_media_buy success responses; deprecate top-level `status` (#4895).

Under MCP flat-on-the-wire serialization, the envelope task-status (`status`, drawn from `task-status.json`) and the body-level `MediaBuyStatus` (`status`, drawn from `media-buy-status.json`) share the same root key on `CreateMediaBuySuccess` and `UpdateMediaBuySuccess`. The two enums overlap on `completed | canceled | rejected` and diverge elsewhere — a `MediaBuyStatus: 'active'` is silently destroyed when the envelope stamps a TaskStatus at the same path, and no validator catches it.

WG-recommended Option E (additive-deprecate, 3.1 minor → 3.2 removal of legacy `status` (#4906) → 4.0 nested cascade (#4905)) per the issue triage. **Strictly additive in 3.1 — no schema is renamed and no `required[]` constraint changes.**

- **`media-buy/create-media-buy-response.json`** (`CreateMediaBuySuccess` branch) — adds `media_buy_status: $ref media-buy-status.json` alongside the existing `status` field. The legacy `status` is marked `deprecated: true` (description) and slated for removal in 3.2 (#4906). Both fields are optional in 3.1; neither was in `required[]` before and neither becomes required now. The `CreateMediaBuySubmitted` branch is unchanged — its `status: { const: "submitted" }` is the TaskStatus discriminator, not a MediaBuyStatus.
- **`media-buy/update-media-buy-response.json`** (`UpdateMediaBuySuccess` branch) — symmetric: adds `media_buy_status`, marks legacy `status` as deprecated. Both optional.

**Not in scope** (deliberate — see below): `get-media-buys-response.json` `media_buys[].status`, `get-media-buy-delivery-response.json` `media_buy_deliveries[].status`, and `core/media-buy.json` `status`. These fields live nested inside arrays at depth ≥ 1, so the envelope `status` at the response root does not collide with them on the wire. The nested-vocabulary inconsistency in 3.1 (one buyer call returns `media_buy_status` at root, the next returns `status` inside an array) is mildly annoying but the price of keeping the change strictly additive — renaming a nested field that 3.0 sellers already emit would require either a `required[]` swap (breaking) or a double-fielded transition (schema churn for no wire-collision payoff). Resolve in 4.0 alongside the legacy-`status` removal, when a clean cascade rename is on the table.

The synthetic `cancel_media_buy` response (issue body called this out as a separate scope question) is performed via `update_media_buy` with cancel intent — there is no dedicated `cancel_media_buy` tool. Inherits the rename from `UpdateMediaBuySuccess` for free. No separate schema change.

Storyboards swept:

- `protocols/media-buy/state-machine.yaml` — three `field_present path: "status"` assertions against `update-media-buy-response.json` updated to `path: "media_buy_status"`. Under additive-deprecate, 3.1-conformant sellers SHOULD emit `media_buy_status`; the assertion documents the canonical-field expectation.
- `protocols/media-buy/scenarios/pending_creatives_to_start.yaml` — two `field_value` assertions checking MediaBuyStatus values against `create-media-buy-response.json` and `update-media-buy-response.json` updated to `path: "media_buy_status"`.
- `protocols/media-buy/scenarios/create_media_buy_async.yaml` — left as `path: "status"`: this checks the `submitted`-arm TaskStatus discriminator, not a MediaBuyStatus.

Docs:

- `docs/media-buy/task-reference/update_media_buy.mdx` — the cancellation success-response example shows the canonical `media_buy_status` form.
- `docs/reference/whats-new-in-3-1.mdx` — migration note in Final-spec clarifications batch.

Adopter impact:

- **Sellers (3.1+):** SHOULD emit `media_buy_status` on `create_media_buy` and `update_media_buy` success responses. MAY continue to emit the legacy top-level `status` during the deprecation window — both fields are valid in 3.1.
- **Buyers (3.1+):** MUST prefer `media_buy_status` when present. MAY fall back to the legacy `status` during the deprecation window for compatibility with sellers still on the legacy form.
- **3.0 sellers and buyers:** continue to work unchanged. The schema remains backward-compatible — no required-field swap, no rename, no breakage. The `get-media-buys-response`, `get-media-buy-delivery-response`, and `core/media-buy.json` surfaces are untouched, so the nested `status` field 3.0 emitters already produce continues to validate.
- **3.2:** the deprecated top-level `status` on the success branches of `create-media-buy-response.json` and `update-media-buy-response.json` is removed (#4906). The deprecation window is intentionally short — storyboard certification already forces 3.1-conformant sellers off the legacy field, so carrying it longer would just mean SDK consumers hold two fields in generated types for no operational benefit. After 3.2, top-level `status` on these responses unambiguously carries envelope TaskStatus only.
- **4.0:** the nested `status` cascade lands (#4905) — `media_buys[].status` on `get-media-buys-response`, `media_buy_deliveries[].status` on `get-media-buy-delivery-response`, and `status` on `core/media-buy.json` rename to `media_buy_status`. Genuinely breaking (a `required[]` swap), held to the major.
- SDK regen required for `@adcp/client`, `adcp-go`, and the Python client. The `@adcp/client` transport precedence fix (adcontextprotocol/adcp-client#1898) already drafts the consumer-side logic.

Related:

- #4876 — envelope `status` REQUIRED (beta.2).
- #4897 — companion governance schema rename (separate PR).
- adcontextprotocol/adcp-client#1898 — SDK-side audit and transport precedence fix.
