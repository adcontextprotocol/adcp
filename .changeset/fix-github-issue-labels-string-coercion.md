---
---

Fix `draft_github_issue` and `list_github_issues` crashing with `labels.join is not a function` when the LLM passes `labels` as a comma-separated string instead of an array. Extracts a shared `coerceStringArray` helper (`server/src/addie/mcp/input-coercion.ts`) that normalizes unknown values into a clean string array — splitting strings on commas, trimming, deduping, and capping at 20 items to prevent pathological inputs from ballooning downstream URLs. Also applied to `suggest_prospects` (`lusha_keywords`), which had the same antipattern.
