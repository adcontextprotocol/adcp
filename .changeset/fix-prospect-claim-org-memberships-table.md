---
---

Fix prospect claim in Slack and enforce admin gate. The admin lookup query referenced a non-existent `org_memberships` table (correct name: `organization_memberships`), so every claim attempt 500'd. Renaming the table also surfaced a latent issue: the computed `is_admin` flag was never enforced, so once the query succeeded, any linked Slack user could have claimed a prospect. Both are fixed: the query runs, and non-admins now get an ephemeral "Only AgenticAdvertising.org admins can claim prospects" reply.
