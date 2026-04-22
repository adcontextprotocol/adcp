---
---

ci: prevent migration-number collisions from slipping past the merge queue (closes #2815)

Addresses the class of incident from #2813: #2793 and #2800 both reserved migration 419, passed CI individually, and merged minutes apart — leaving every fresh DB boot broken until a renumber hotfix. Two gaps closed:

**`check-migration-numbers.yml`** — the PR check now takes the union of migration filenames from the PR branch *and* `origin/main`, then hunts duplicates in that union. Previously it only inspected GitHub's speculative merge commit, which goes stale when main moves on in a way that doesn't conflict with the PR's diff. Two PRs reserving the same number would both see a clean local state and pass. With the union check, the second one to run (after the first lands on main) fails immediately. Also dropped the `paths: server/src/db/migrations/**` filter so a rebase after main adds a migration triggers a re-check even if the PR itself doesn't touch migrations.

**`deploy.yml`** — added a `preflight` job that runs the duplicate-number check on the merged main tree. `deploy` now `needs: preflight`, so if somehow a collision does land, the Fly deploy is blocked before we ship a container that crashloops on boot instead of after. Cheap sanity check, ~10s runtime.

Together: pre-merge catches the race, post-merge catches anything pre-merge misses. Both are deterministic shell, no hidden dependencies.
