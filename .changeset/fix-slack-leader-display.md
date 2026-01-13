---
"adcontextprotocol": patch
---

fix: display Slack profile name for chapter leaders without WorkOS accounts

Leaders added via Slack ID that haven't linked their WorkOS account now display
their Slack profile name (real_name or display_name) instead of the raw Slack
user ID (e.g., U09BEKNJ3GB).

The getLeaders and getLeadersBatch queries now include slack_user_mappings as an
additional name source in the COALESCE chain.
