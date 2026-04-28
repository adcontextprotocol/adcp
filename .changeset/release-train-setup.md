---
---

Stand up the release-train infrastructure for 3.0.x patches and 3.1.0-beta development:

- `.github/workflows/release.yml` — add `3.0.x` to the trigger branches list (alongside `main` and the existing `2.6.x` precedent). `changesets/action` will now auto-open Version Packages PRs on `changeset-release/3.0.x` for patch cuts.
- `.github/workflows/forward-merge-3.0.yml` — new workflow that opens a PR back to `main` whenever `3.0.x` is updated. Direction is one-way; merge conflicts fail fast and require human resolution.
- `.github/workflows/build-check.yml`, `.github/workflows/training-agent-storyboards.yml` — extend trigger branch lists to fire CI on `3.0.x` PRs and pushes.
- `.changeset/pre.json` — enter pre mode for the 3.1 cycle. Every Version Packages cut on `main` now produces `3.1.0-beta.N` instead of `3.1.0`. Safety net against accidental minor merges shipping as 3.1.0 stable.
- `.agents/playbook.md` § Release lines — documents branch naming (`<major>.<minor>.x`), cherry-pick convention, patch eligibility rules, pre/exit semantics, and the GITHUB_TOKEN recursion friction tracked in #3417.
- `.agents/shortcuts/cut-patch.md` — new runbook for cutting a 3.0.X patch end-to-end.
- `.agents/shortcuts/cut-beta.md` — new runbook for cutting a 3.1.0-beta.N and exiting pre mode for 3.1.0 stable.

`3.0.x` branch was created from the `v3.0.1` tag prior to this PR (`gh api repos/.../git/refs -X POST -f ref=refs/heads/3.0.x -f sha=$(git rev-parse v3.0.1^{commit})`).
