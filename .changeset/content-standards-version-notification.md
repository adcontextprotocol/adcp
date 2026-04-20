---
---

docs(governance): tighten content-standards versioning language for 3.0 GA

Closes #2397. Doc-only; no schema changes.

- `docs/governance/content-standards/index.mdx` — requires continuous-policy findings to be emitted via the buy's `push_notification_config` when configured and to be retrievable via the buy's status surface regardless. Makes it explicit that 3.0 has no mid-flight re-pin mechanism: buyers adopt a newer standards version by canceling and re-creating the buy, with the heavyweight-path caveats (new approval, fresh pacing, potential makegoods). `standards_version` on `update_media_buy` and partial re-pin are out of scope for 3.0.
- `docs/governance/overview.mdx` — narrows the "policy updates mid-flight" bullet so it no longer reads as overriding the content-standards pinning rule, and cross-links to the versioning section.
- `docs/governance/campaign/tasks/sync_plans.mdx` — reciprocal one-line pointer from the plan-level re-evaluation paragraph to the content-standards pinning rule, so readers arriving from either side see the same disambiguation.
