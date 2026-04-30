---
---

Fix Addie's shadow evaluator to use the real assembled prompt (rule files +
tool reference) instead of a one-line system prompt. Add a deterministic
response-shape grader (length cap, default-template signature, banned-ritual
hits, sign-in opener, comprehensive-dump detection) and wire it into the
shadow eval flow so every settled thread now records shape metrics for
shadow vs longest human response. Default model stays Haiku for cost;
`SHADOW_EVAL_MODEL=primary` upgrades to the production Sonnet model for
periodic deep evals.
