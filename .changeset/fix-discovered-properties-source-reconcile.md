---
---

Add `source` column to `discovered_properties` to enable property-removal reconciliation in the hosted-property sync. Previously, the sync could only do additive upserts because it could not distinguish its own rows from crawler-written rows. Now, rows written by the hosted sync carry `source='aao_hosted'` and are reconciled (deleted when removed from the manifest) inside a domain-scoped advisory-lock transaction, preventing concurrent sync races.
