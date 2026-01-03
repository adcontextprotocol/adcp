---
---

Improve Addie's Slack message understanding

- Fix Addie not seeing forwarded Slack messages (content is in `attachments`, not `text`)
- Add reaction-based confirmations: thumbs up on "should I proceed?" means yes
- Add file share awareness: Addie now sees file metadata when users share files
- Add `fetch_url` tool: Addie can read content from URLs shared in messages
- Add `read_slack_file` tool: Addie can read text files shared in Slack
