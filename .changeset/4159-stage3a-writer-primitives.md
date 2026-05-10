---
---

Server: introduce `db/organization-domains-db.ts` with two canonical writers — `linkDomain` and `setPrimaryDomain` — and migrate the simpler call sites (prospect, organization-bootstrap, member-profiles bootstrap, bolt-app, me-organization-domains). Stage 3a of #4159. WorkOS webhook and admin/domains.ts still use inline SQL; covered by 3b/3c.
