---
---

Addie now sees the shared agent infrastructure:

- The weekly `.agents/current-context.md` snapshot is injected into her cached system prompt under a `# Current AdCP Context` heading, so she can answer roadmap questions with current signal instead of guessing.
- The expert personas under `.claude/agents/` (ad-tech-protocol-expert, adtech-product-expert, code-reviewer, etc.) are summarized into a `# Expert Panel` reference block — Addie knows which voice is appropriate for deep questions.
- New `ModelConfig.depth` tier (default `claude-opus-4-7[1m]`, overridable via `CLAUDE_MODEL_DEPTH`) routes `requires_depth` turns to the same model the AdCP triage routines use, keeping protocol answers consistent across surfaces. `requires_precision` (billing/financial) remains on `ModelConfig.precision` (Opus 4.6) unchanged.
