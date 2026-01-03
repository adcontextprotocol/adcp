---
---

Fix Addie not seeing forwarded Slack messages

When users forward messages in Slack, the content is in the `attachments` array, not the `text` field. Now extracts forwarded message content and includes it in what Claude sees.
