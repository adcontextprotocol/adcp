---
---

Rewrite the issue-triage routine prompt (v2) around expert consultation. The routine now spawns bucket-specific expert subagents (ad-tech-protocol, adtech-product, code-reviewer, prompt-engineer, user-engagement, education, internal-tools, dx, docs, security) from `.claude/agents/`, synthesizes their input, and lands one of four outcomes: clarify (ask maintainers), flag-for-review (surface to @bokelley), execute PR, or defer (post-cycle work, silent). Drop the silent-triage default and the NONE-author PR gate — drive-by bugs can now become draft PRs when small and correct; CODEOWNERS still gates merge. Relevance check uses milestones + active PRs + recent merges + issue text + current-context snapshot, not a single source.
