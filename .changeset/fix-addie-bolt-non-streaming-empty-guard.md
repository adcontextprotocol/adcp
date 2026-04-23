---
---

Fix `Addie Bolt: Failed to send response` errors on the non-streaming path when sanitization strips Claude's response to empty text. Mirrors the streaming-fallback guard in PR #2947: if `slackText` is empty, fall back to an image-only message (when images are present) or a rephrase prompt (when nothing is left). Slack rejects `section` blocks with empty `mrkdwn` text as `invalid_blocks`, which previously surfaced as a swallowed error and a silent UX.
