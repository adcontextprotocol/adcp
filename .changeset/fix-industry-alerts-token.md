---
"adcontextprotocol": patch
---

Remove AAO bot dependency; use Addie bot for all Slack operations

- Consolidate to single Slack bot (Addie) instead of dual-bot setup
- ADDIE_BOT_TOKEN is now primary, with SLACK_BOT_TOKEN fallback for migration
- Remove useAddieToken parameter from sendChannelMessage and getThreadReplies
- Remove getSlackUserWithAddieToken helper function
- Update all callers to use simplified API
