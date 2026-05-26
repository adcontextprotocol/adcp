---
---

fix(addie): deliver cost-cap message in Slack streaming path (#4555)

When a user's daily Claude API usage cap fires, the cap message was generated but never reached Slack. The streaming path in `handleUserMessage` (bolt-app.ts) collected a `done` event with `flag_reason: 'cost_cap_exceeded'` but never called `say()` or passed `markdown_text` to `streamer.stop()` — the streamer closed with an empty buffer, leaving the user with no response.

Fix: check for `flag_reason === 'cost_cap_exceeded'` before the normal `streamer.stop()` call; when the flag is present, stop the stream with `markdown_text: response.text` so the cap message is delivered inline. The catch-block fallback is updated to use the cap message text instead of the generic apology for the same case.

Also: rename "AAO team" → "AgenticAdvertising.org team" in the cap-exceeded copy, and "The cap resets in" → "You can try again in" for clarity.
