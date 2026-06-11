---
---

docs(media-buy): clarify optimization_goal priority precedence when no goal is priority 1

`core/optimization-goal.json` already states priority is ordinal ("1 is highest priority; higher numbers are secondary"), but was silent on the present-but-no-1 case, so a literal-reading seller could reject `[2, 3]` while a relative-ordering seller treats `2` as primary. States the only internally-consistent reading: when priorities are present but no goal is `priority: 1`, the goal with the lowest priority value is primary (e.g., `2` and `3` mean `2` is primary).

Description/docs clarification of already-published ordinal-precedence semantics — no structural schema change and no wire-contract change, so no version bump (applies to 3.0 via the living docs). Touches the `optimization-goal.json` top-level `description` and a normative rule in `optimization-reporting.mdx`. Closes #5447.
