---
---

Close two gaps from the first live v2 run of the issue-triage routine:

1. **Concurrency race.** Cron + manual + bridge can all fire near-simultaneously and walk the same `claude-triaged`-less queue, producing duplicate triage comments on the same issue. Add a pre-work check: if any `## Triage` comment was posted on this issue in the last 10 minutes, skip. One-API-call distributed lock.

2. **Synthesis coverage gaps.** LLM sampling variance + per-expert prompt scope freedom meant single runs missed angles that a second run then surfaced (the two racing comments on #2915 were genuinely complementary — not identical). Add a coverage checklist per bucket: before writing the comment, verify the synthesis touches each applicable dimension (operator reality, codebase coherence, industry precedent, migration cost, governance) and loop back to the relevant expert if a material dimension is missing. For RFC / epic / cross-cutting issues, consider spawning 2× per expert type in parallel.
