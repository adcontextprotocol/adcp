---
---

Server-only: Fix Addie using wrong bot token to send messages.

Addie was using SLACK_BOT_TOKEN (AAO bot) to send messages, which
failed with channel_not_found because Addie's DM channels are only
accessible via ADDIE_BOT_TOKEN.
