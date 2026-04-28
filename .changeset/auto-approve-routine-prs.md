---
---

Add `auto-approve-routine-prs.yml` workflow that posts an approving review on routine-authored PRs (branches `claude/*` or `auto/*`) once all CI checks are green. Uses the AAO Triage Bot GitHub App as a separate approver identity so the routine's PRs (opened under the project owner's PAT) can satisfy the "1 approving review" branch protection rule without admin-merge. Opt-out via `do-not-auto-approve` label.
