---
---

Add automated Slack user group badges for AgenticAdvertising.org members. When a WorkOS organization membership is created, updated, or deleted, the server now adds or removes the member from a dedicated `@aao-members` Slack user group so members are visually identifiable in workspace conversations. The user group is created automatically on first use if it doesn't exist; the group ID and handle can be pinned via `SLACK_MEMBER_USER_GROUP_ID` / `SLACK_MEMBER_USER_GROUP_HANDLE` env vars. Closes #2340.

**Note:** Existing members at deploy time are not backfilled automatically — they will be added to the group when their next membership event fires, or a workspace admin can manually add them to the `@aao-members` group in Slack.

**Scope addition required:** the bot token needs `usergroups:read` + `usergroups:write` scopes — a workspace admin must approve the updated app manifest before this feature activates.
