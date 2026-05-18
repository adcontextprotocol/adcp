---
"adcontextprotocol": patch
---

Certification: stop silent completion claims and misleading prereq prompts.

Two coupled fixes to the cert tool surface and Sage's prompt rule:

**`complete_certification_module` / `complete_certification_exam`** — every gate-failure return path now starts with a `NOT COMPLETED` sentinel and includes a learner-facing reframe keyed to the gate class (`time`, `evidence`, `state`, `score`). Pairs with a new rule in `addie/rules/constraints.md` that tells Sage to only treat the literal `Module {ID} completed!` / `# Congratulations! The learner passed the capstone!` lines as success, and forbids "complete" / "mastered" / "locked in" / etc. until she sees them. Fixes the failure mode where Sage announced "B2 complete" after the 5-min minimum-session gate had silently rejected her call (real-world example: escalation #341).

**`start_certification_module`** — `checkPrerequisites` now returns per-prereq status (`{ moduleId, status }[]`). When a missing prereq is `in_progress`, the template directs Sage to surface the open work and offer learner agency ("want to wrap that, or talk through where you're stuck?") instead of offering a placement assessment to skip it. The placement-assessment template is preserved for `not_started` prereqs.

Closes #4608 and #4647.
