---
---

fix(migrations): renumber duplicate 444 to 445 — unblock deploys

PRs #3258 and #3136 both shipped a `444_*.sql` migration in parallel before the duplicate-detection preflight could fire. Result: every deploy after the second of the two merges fails at the migration-numbering check, blocking the queue.

Renames the later-merged of the two:
- `444_agent_test_runs.sql` → `445_*` (from #3258, merged after #3136)

Idempotent: `444_drop_addie_rules.sql` uses `DROP TABLE IF EXISTS`; `445_agent_test_runs.sql` uses `CREATE TABLE IF NOT EXISTS`. Dev DBs that already pulled the original `444_agent_test_runs.sql` will see the renumbered 445 as a no-op next migrate run; prod's `release_command` was blocked at the duplicate, so it applies fresh as 445.

Same shape as the earlier 436 collision fix (#3300).
