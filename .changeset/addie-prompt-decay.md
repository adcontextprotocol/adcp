---
---

Implements #3282: decay/suppression for Addie's suggested-prompts rules engine. Without this, every activation rule fires indefinitely until the gating signal flips — owners who deliberately ignore the "List my company in the directory" prompt see it forever.

- New migration `436_addie_prompt_telemetry.sql` creates `addie_prompt_telemetry (workos_user_id, rule_id, shown_count, last_shown_at, suppressed_until)` keyed on `(workos_user_id, rule_id)`.
- New DB layer `server/src/db/addie-prompt-telemetry-db.ts`: `getTelemetryForUser` reads into a Map; `recordPromptsShown` does one bulk upsert via `unnest($2::text[])` for all rules in the batch.
- **Counting is bucketed by UTC day**: shown_count only increments if `last_shown_at < CURRENT_DATE`. Without this a Slack user who opens App Home and starts a few Assistant threads in one workday would burn through the suppression threshold without ever consciously reading the prompt.
- Default thresholds: 5 distinct days of shows → 30-day suppression. Tunable via `recordPromptsShown` options.
- **Persona prompts are exempt** (`decay: false` on `PromptRule`). Personas are stable entry points, not nudges — suppressing "Prove the outcomes" for a `data_decoder` would leave them with strictly worse fallbacks. Their rule IDs are excluded from `recordPromptsShown` so no telemetry is written.
- `MemberContext.prompt_telemetry` hydrated in both Slack and web flows; benefits from the existing 30-min context cache so the evaluator stays synchronous. Cache means in-memory `suppressed_until` can be up to 30 min stale, which is fine given suppression is 30 days.
- New `pickPrompts()` returns parallel `{prompts, ruleIds}` for telemetry recording; existing `buildSuggestedPrompts()` kept as a thin wrapper. All 4 call sites (Slack Assistant, App Home, Web Home, legacy wrappers) record fire-and-forget after picking.
- 8 new tests covering suppression behaviour, the `pickPrompts` API, and persona-exempt logic.

Out of scope: dismissal UI (no Slack/web button surface yet), per-rule decay configurations, "acted on" tracking (when the gating signal flips, the rule's `when()` returns false naturally).
