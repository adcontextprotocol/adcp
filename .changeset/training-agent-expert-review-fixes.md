---
---

Training agent: apply code-reviewer + protocol-expert feedback before merge.

- **`update_media_buy` response emits `targeting_overlay`** (task-handlers.ts:2269).
  Was the last response path still emitting legacy `targeting`; the create
  and get paths already used the spec field. Mentioned by both reviewers as
  the remaining drift after the rename landed.
- **`sync_catalogs` discovery response emits `type`** instead of `catalog_type`
  (catalog-event-handlers.ts:295). Per `static/schemas/source/core/catalog.json`
  the only correct field is `type`; `catalog_type` is our legacy name. We
  still accept both on input for pragmatic backcompat.
- **`acquire_rights` expired-dates error uses spec code `INVALID_REQUEST`** with
  `field: campaign.end_date` and `recovery: correctable`. Previously returned
  lowercase `invalid_request`; the spec error-code enum is uppercase and the
  richer fields give agents something to act on.

Also filed two upstream policy-ambiguity issues surfaced by the review:
- #2680 — CPM governance projection on `acquire_rights` (1M default is
  hidden policy; needs spec clause).
- #2681 — expired-campaign-dates rejection is sensible but unspecified.

Storyboards hold at 39/56 clean, 308 passing. Above CI floor (27/271).
