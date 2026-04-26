---
---

ci(migrations): close the parallel-merge gap in duplicate-number detection

The "No duplicate migration numbers" workflow correctly detected collisions when a single PR's check ran against a stale view of main. But two PRs whose checks ran in parallel against *different* snapshots of main could both pass legitimately — which is how #3235 + #3244 both landed with migration 433 (and #2793 + #2800 both landed with 419 in 2026-02).

Three layered fixes:

1. **`merge_group` trigger** so the check runs on the real merge commit when GitHub merge queue is enabled — the only way to fully serialize the check.

2. **Daily scheduled run** as a safety net for when merge queue isn't on. If a duplicate slips through, the workflow goes red on `main` within 24 hours; branch protection then blocks subsequent merges until the duplicate is renumbered.

3. **Filesystem invariant test** in `server/tests/unit/migrate.test.ts` that scans the migrations directory and asserts no duplicate version numbers / malformed filenames. Runs locally on `npm test:unit` and on every CI run, regardless of workflow timing — catches duplicates the moment a developer's working tree has them.

The error message is also clearer about the rebase-and-renumber recovery procedure, including the `IF NOT EXISTS` requirement so re-running on systems that already applied the old number is a no-op.

The recommended **branch-protection setting** ("Require branches to be up to date before merging") is documented inline in the workflow comments — that's the GitHub-config-level fix for the parallel-PR case when merge queue isn't available.
