---
---

Two follow-ups to the AdCP issue-triage routine prompt:

1. Add a "silent triage" path: when the routine classifies an issue as RFC / Epic / Feature / Discussion AND the author is an established contributor AND the body is well-structured AND the issue already carries an on-target label, apply `claude-triaged` + matching bucket labels silently without posting a comment. A triage comment that restates the issue and says "ready-for-human" is pure noise — the structured label carries the same signal.

2. Document the `claude-triaged` label as a prerequisite (chicken-and-egg: the prompt requires applying it + forbids creating labels, so the label must pre-exist).
