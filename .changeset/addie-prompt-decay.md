---
---

Implements #3282: decay/suppression for Addie's suggested-prompts rules engine. Without this, every activation rule fires indefinitely until the gating signal flips — owners who deliberately ignore the "List my company in the directory" prompt see it forever.

- New migration `436_addie_prompt_telemetry.sql` creates `addie_prompt_telemetry (workos_user_id, rule_id, shown_count, last_shown_at, suppressed_until)` keyed on `(workos_user_id, rule_id)`.
- New DB layer `server/src/db/addie-prompt-telemetry-db.ts` exposes `getTelemetryForUser` (read into a Map) and `recordPromptsShown` (upsert with auto-suppression: 5 shows → 30-day suppress).
- `MemberContext.prompt_telemetry` hydrated in both Slack and web flows so the evaluator stays sync and benefits from the existing 30-min cache.
- Evaluator skips rules whose `suppressed_until > now` before running their predicate — no behaviour change for users without telemetry rows.
- New `pickPrompts()` returns parallel `{prompts, ruleIds}`; existing `buildSuggestedPrompts()` kept as a thin wrapper.
- All 4 call sites (Slack Assistant, Slack App Home, Web Home, plus the legacy `getDynamicSuggestedPrompts` wrappers) record telemetry fire-and-forget after picking.
- 6 new tests for suppression behaviour and the `pickPrompts` API. No "acted on" tracking — when the gating signal flips, the rule's `when()` returns false naturally.
- Out of scope: dismissal UI (no Slack/web button surfaces yet), per-rule decay configurations.
