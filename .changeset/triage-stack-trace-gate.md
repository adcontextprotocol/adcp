---
---

Tighten the issue-triage routine for runtime-crash issues. Adds (1) a
Step 2.5 stack-trace gate that mandates `debugger` + `code-reviewer`
before the surface bucket panel, (2) a `runtime-crash` overlay bucket
in the routing matrix, (3) a symptom-coherence check inside Step 5
("if this PR merges, does the reporter's symptom stop?"), (4) a new
"Cross-repo escalation" section requiring shim + sibling-repo tracker
when the crashing frame is in a sibling SDK (and not docs-only as the
sole response), and (5) a Step 3 tiebreaker line — "a stack trace is
never a spec question." Catches the failure mode where #3423 produced
PR #3426 (docs-only spec clarification) while leaving the consuming
crawler unguarded.
