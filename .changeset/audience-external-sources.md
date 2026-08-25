---
"adcontextprotocol": minor
---

Add external audience source references on `sync_audiences` (#6540), the runtime leg of the audience-activation surface (experimental, `media_buy.audience_activation`). An audience carries either inline member deltas or a `source` reference (`core/audience-source.json`): `dataset` (the seller reads a grantee-identified share — Snowflake, Databricks D2D, BigQuery authorized views) or `platform_segment` (binds a vendor-distributed segment to an `audience_id`). Data never transits AdCP. Responses echo the source with `access_status` and `columns_read`; counts anchor to `last_synced_at` (required once counts populate). Normative lifecycle rules: transport fixed at creation (cross-transport upserts → `CONFLICT`), loss of source access never changes audience status (frozen membership stays targetable; `suspended` reserved for consent/policy causes), access expiry is not deletion. New error code `SOURCE_ACCESS_FAILED` with `error.field`-keyed recovery.
