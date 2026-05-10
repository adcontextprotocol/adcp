---
---

ci(changeset-check): skip on `forward-merge/*` PRs. Forward-merge PRs bring in commits whose changesets were already consumed by the source branch's Version Packages cut, so `changeset status` finds nothing and fails the check. Mirrors the existing `changeset-release/*` skip rule. Closes #4310's blocker on `Check for changeset`.
