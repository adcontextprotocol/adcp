---
---

Stage 2 of persona-driven Addie suggested prompts (#2299) — Piia's flagship example: a learner mid-certification gets a "Continue certification" prompt at the top of Addie's home.

- Adds `MemberContext.certification` (track_id, module_id, status, started_at, last_activity_at) hydrated in both Slack and web flows.
- New `getLatestAttempt(userId)` query (LIMIT 1, prefers in-progress) replaces a full-scan call to `getUserAttempts`.
- New rule `cert.continue_in_progress` at priority **93** (above lapsed at 92 — a concrete unfinished thing beats generic re-engagement when both signals are present).
- **Decay-exempt** like persona prompts: re-engaging a stalled learner is exactly the high-value case; don't auto-suppress.
- **Freshness guard**: only fires when `started_at` is within the last 45 days. Past that, the learner has likely moved on and the lapsed-re-engagement rule (or low-login) handles re-entry better than nudging about an abandoned artifact.
- Gates `persona.ladder_or_simple_starter` ("Start with the Academy") to skip when the learner is already mid-cert — "Continue certification" is the more accurate prompt at that point.

Out of scope (filed for follow-up): dynamic per-module label like "Continue A1" — needs `PromptRule.label`/`prompt` to accept a function, which is a broader refactor.
