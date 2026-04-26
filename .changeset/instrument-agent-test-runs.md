---
---

Add `agent_test_runs` table and wire-up instrumentation so Addie can surface staleness-aware agent-testing prompts (#2299 Stage 2). Adds `agent_testing` block to `MemberContext` with `last_test_at`, `last_outcome`, and `total_tests_30d` fields hydrated from the new table. Write calls added to `evaluate_agent_quality` and `run_storyboard` handlers.
