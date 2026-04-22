---
---

Fix authentication shape drift across 9 storyboard fixtures (adcp#2763 cluster follow-up to #2768).

Three `create_media_buy` fixtures used `authentication: { scheme: "HMAC-SHA256" }` (singular `scheme`); the schema requires `{ schemes: ["HMAC-SHA256"], credentials: "..." }`. Six `sync_governance` fixtures registered `governance_agents[]` without any `authentication` block — the schema requires it ("seller must authenticate to governance agent" is a security property). Both gaps are now closed.

Allowlist shrank 44 → 35.
