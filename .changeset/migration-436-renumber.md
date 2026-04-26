---
---

fix(migrations): renumber organization_membership_provisioning_source from 436 to 438

Hotfix to unblock prod deploys. Two PRs landed migration 436 in parallel:

- `436_addie_prompt_telemetry.sql` (#3270 ish, addie prompt telemetry)
- `436_organization_membership_provisioning_source.sql` (mine, via #3295)

The deploy preflight blocked the boot because the migrate runner crashes on duplicate version numbers. Renumbers mine to 438 (next free; 437 is `437_auto_provision_digest_sent_at.sql`).

Same recovery shape as the 2026-04 catalog/auto-provision 433 collision. The migration is fully idempotent (every `ALTER TABLE` and `CREATE INDEX` uses `IF NOT EXISTS`) so re-running it on systems that already applied it as 436 is a no-op.

Independent of the CI fix landing in #3288 — the parallel-merge gap was in the workflow check, and #3288 plugs it for future PRs but can't retroactively prevent this collision.
