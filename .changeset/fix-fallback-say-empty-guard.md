---
---

Fix `Addie Bolt: Fallback say() also failed` errors during upstream Anthropic overloads:

- When streaming fails before producing any text, the stream-stop fallback built a Slack `section` block with empty `mrkdwn` text, which Slack rejects as `invalid_blocks`. Now falls back to a plain apology (`say(apology)`) when `slackText` is empty.
- Demote the "fallback also failed" log from `error` to `warn` when the root cause is an already-logged retries-exhausted error, so upstream outages don't page twice.
