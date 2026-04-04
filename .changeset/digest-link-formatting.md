---
---

Fix weekly digest editor's note rendering to preserve hyperlinks. Slack-format links (`<url|label>`) are now converted to proper HTML anchor tags in email, preserved as-is in Slack mrkdwn, and rendered as "label (url)" in plain text.
