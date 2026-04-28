---
---

Fix writer anchor-adopt promotion — when a publisher's adagents.json claims a
property whose rid was previously created by community/enrichment/contributed
flows AND anchors via a domain identifier under their own host, promote
`source` → `'authoritative'` and rebind `created_by` →
`'adagents_json:<publisher>'`. Without this, the auth projection's
`WHERE created_by = 'adagents_json:<pub>' AND property_id = ANY(...)` returns
zero rows for properties already in the catalog under a different pipeline,
silently dropping the manifest's `authorized_agents[]` entries.

Found via escalation #287 (wheelrandom.com): valid adagents.json with a
correctly anchored inline property, but registry showed 0 authorizations
because a pre-existing `contributed` catalog row blocked the auth projection.
