---
---

Server: migrate the cleanly-mappable write sites in `routes/admin/domains.ts` to canonical writers. Three "admin create prospect" mirrors → `linkDomain`; admin add-domain-to-org → `upsertDomainFromWorkos` + conditional `setPrimaryDomain`; admin Set Primary endpoint → `setPrimaryDomain`. Adds `requireVerified` opt-out to `setPrimaryDomain` so admin tools can promote a hand-imported unverified row. Stage 3c of #4159. Admin DELETE (different reselection policy) and bulk domain-health sync stay inline.
