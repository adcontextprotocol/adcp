---
---

Hosted-property sync now fully reconciles `discovered_properties` rows it owns. Previously the sync was additive-only because `discovered_properties` had no way to distinguish hosted-written rows from crawler-written rows. This fix uses the existing `source_type` column (added in migration 202) — the sync writes `source_type='aao_hosted'` on upsert and deletes stale `aao_hosted` rows on re-sync. Crawler rows (`source_type='adagents_json'`) are never touched. A publisher who removes a property from their hosted manifest will now see it disappear from the publisher page on the next sync rather than persisting indefinitely.
