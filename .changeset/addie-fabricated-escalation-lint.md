---
---

fix(addie): ban fabricated ticket numbers and "team has been notified" claims

Addie fabricated "Done — the team has been notified (ticket #228)" in a real
conversation when no escalate_to_admin tool call was made. Fixes two gaps:

1. **New hallucination-detect patterns** — extracted HALLUCINATION_PATTERNS and
   detectHallucinatedAction to standalone `hallucination-detect.ts` module (testable
   without DB deps). Added three new patterns covering ticket/issue creation claims,
   "team has been notified" (active and passive voice), and "I've flagged/escalated
   this" — all mapped to escalate_to_admin (and create_github_issue / send_member_dm
   where applicable). Patterns are anchored with verb-of-action or first-person
   subjects to avoid false positives on bare ticket number references.

2. **constraints.md** — expanded the "Never Claim Unexecuted Actions" section to
   explicitly name escalate_to_admin with its specific fabrication patterns, removing
   reliance on the vague "Any other state-changing operation" catch-all.

3. **Unit tests** — new `claude-client-hallucination.test.ts` covering all three new
   pattern groups, false-positive avoidance cases, and failed-tool does-not-clear behavior.

Bumps CODE_VERSION to 2026.05.1.

Closes #3720.
