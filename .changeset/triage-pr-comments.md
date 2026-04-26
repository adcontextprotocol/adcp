---
---

Triage workflow now fires on PR comments as well as issue comments. The previous `github.event.issue.pull_request == null` filter routed PR feedback into a non-existent "auto-fix" workflow, so review comments on PRs sat unactioned until someone manually invoked `/triage`. The routine now receives an `is_pr: true` flag plus a `pr` block (head_ref, base_ref, draft, state) and a MODE directive telling it to treat new PR comments as actionable feedback (apply a follow-up commit on the PR's head branch, or post a reply if the comment is a question). Self-loop guard widened to also skip comments containing "Fixed by Claude Code" so PR-fix replies don't re-trigger.
