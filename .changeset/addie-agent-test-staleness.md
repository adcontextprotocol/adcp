---
---

Closes #3254: agent test staleness signal feeding a new builder-persona prompt rule. Reuses the existing `agent_test_history` table (no new schema) and adds a `getLatestTestForUser` query. Hydrates `agent_testing.{last_test_at, last_outcome}` onto MemberContext. New rule `agent.stale_test` (priority 91, decay enabled) fires for `molecule_builder` and `pragmatic_builder` personas when the last test is older than 14 days or never run, with label "Run a fresh agent test." Generic `member.test_my_agent` (priority 50) now suppresses when the high-priority stale rule is firing to avoid duplicate-intent prompts in the top 4. Storyboard runner (`run_storyboard`) now records to `agent_test_history` so its runs count toward the staleness signal alongside `evaluate_agent_quality`.
