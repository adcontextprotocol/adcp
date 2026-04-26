---
---

Guard the non-streaming Addie response path against empty `slackText`. Same fix as #2947 applied to the non-streaming branch at `server/src/addie/bolt-app.ts:1689-1715`: if the model returns nothing (or validation/extraction produces empty text), send a plain apology via `say()` instead of a malformed Slack blocks payload with empty `mrkdwn` text. Closes #2951.
