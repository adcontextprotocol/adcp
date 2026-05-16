---
---

Route OAuth-required agent failures to the click-to-authorize flow instead of `#aao-errors`.

`/api/discover-agent` and Addie's `evaluate_agent_quality`, `recommend_storyboards`,
`run_storyboard`, and `run_storyboard_step` were treating `AuthenticationRequiredError`
as a system fault and `logger.error`-ing it, so every probe of an OAuth-only seller
platform paged the error Slack channel every five minutes.

Now those handlers detect the typed `AuthenticationRequiredError` (and the string forms
`comply()` returns inside step results), demote the log to `warn`, and surface a
`[Click here to authorize this agent](…)` link that points at `/api/oauth/agent/start`.
The shared logic lives in `server/src/routes/helpers/agent-oauth-prompt.ts`.
