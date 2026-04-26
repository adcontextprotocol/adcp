---
---

Release-docs workflow now commits the v$VERSION snapshot directly to main on `release: published` events instead of opening a PR with `--auto` merge that stalled on REVIEW_REQUIRED. Snapshots are deterministic from the release tag (git archive of `docs/`, link rewrite, `docs.json` patch) so there's nothing for a human to review. The `workflow_dispatch` path still opens a PR for manual snapshot runs where review may be wanted.
