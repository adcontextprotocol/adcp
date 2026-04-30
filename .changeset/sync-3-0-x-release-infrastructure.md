---
---

Sync `3.0.x` branch's release-pipeline workflow files with `main` so the patch line has the same CI infrastructure that `main` got via #3420 (release-train setup) and #3597 (App-token swap). The workflow files were stale on `3.0.x` because the branch was force-reset to `v3.0.1^{commit}` (pre-#3420) during the post-#3436 cleanup.

- `release.yml` — add `3.0.x` to push branches; swap `GITHUB_TOKEN` → App token in `actions/checkout@v6` and `changesets/action@v1`.
- `release-docs.yml` — swap `GITHUB_TOKEN` → App token in `actions/checkout@v6`, `peter-evans/create-pull-request@v8`, and `gh pr merge --auto`.
- `forward-merge-3.0.yml` — restore the file (it lives on main but must also exist on `3.0.x` because `push: branches: [3.0.x]` triggers read the workflow from the pushed commit's tree).
- `training-agent-storyboards.yml` — add `3.0.x` to PR + push triggers so storyboard non-regression runs on patch PRs.
- `build-check.yml` — add `3.0.x` to PR + push triggers.
- `changeset-check.yml` — add `3.0.x`; broaden the skip condition from `!= 'changeset-release/main'` to `!startsWith('changeset-release/')` so Version Packages PRs from any release line skip correctly.
- `codeql.yml` — add `3.0.x` to PR + push triggers.

Without these updates, `3.0.x` PRs (like the cherry-picks of #3461/#3462 in this same PR) wouldn't fire required CI, and pushes to `3.0.x` wouldn't trigger `release.yml` to open a Version Packages PR for `3.0.2`.
