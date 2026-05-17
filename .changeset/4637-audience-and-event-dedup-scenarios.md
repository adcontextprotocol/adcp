---
"adcontextprotocol": minor
---

feat(compliance): audience_buy_flow + event_dedup_flow capability-gated scenarios; training-agent audience_id validation

Two new scenarios in the capability-claim contract pattern (#4637), both added to `sales-non-guaranteed.requires_scenarios`:

- `media_buy_seller/audience_buy_flow` — gated on `media_buy.audience_targeting` presence. Certifies `sync_audiences` → bound `audience_id` in targeting → unbound id rejected → delivery against an audience-targeted buy. Sibling to `performance_buy_flow` on the audience side; the unbound-id rejection is the discriminating assertion.

- `media_buy_seller/event_dedup_flow` — gated on `media_buy.conversion_tracking.multi_source_event_dedup` equals true. Certifies that the same `event_id` from two registered event sources attributes to one conversion, not two. Sellers without `multi_source_event_dedup` grade `not_applicable` — the bit gates the scenario; the cumulative-count check is the assertion.

Training-agent fix: `create_media_buy` now rejects `targeting_overlay.audience_include` / `audience_exclude` entries whose `audience_id` was never registered via `sync_audiences`, with `INVALID_REQUEST` and `error.field` set to the literal JSONPath-lite path of the offending entry. Mirrors the `event_source_id` validation pattern from #4654. `sync_audiences` itself is now wired through the training agent (legacy `/mcp` and v6 `/sales/mcp` via `AudiencePlatform`) so adopters can run the audience scenario against the reference implementation.

Three sibling product-level scenarios (reach, clicks, completed_views) remain blocked on #4651 product-level capability gating RFC.
