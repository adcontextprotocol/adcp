---
---

Fix missing `authentication` block on `governance_agents[]` in 6 `sync_governance` fixtures (adcp#2763 cluster follow-up to #2768).

Six fixtures registered governance agents with no authentication — the schema requires `authentication: { schemes: [...], credentials: "..." }`, and "seller must authenticate to governance agent" is a security property, not cosmetic drift. Fixed with the Bearer-token shape already in use in `protocols/media-buy/index.yaml`'s own sync_governance step.

Allowlist shrinks as the 6 stale entries drop.

(Companion 3-fixture `push_notification_config` fix landed separately via `fix-storyboards-push-notification-schemes`; the auth cluster is closed after both PRs.)
