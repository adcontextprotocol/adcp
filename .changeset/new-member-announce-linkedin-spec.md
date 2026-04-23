---
---

Update `specs/new-member-announcements.md` (Workflow B, follow-up to PR #2246):

- LinkedIn posting is treated as a permanent human step, not a v1 shortcut — LinkedIn's API does not grant posting scopes for company pages or personal profiles without partner status we don't have.
- Announcement state is now **per-channel**. `announcement_published` `org_activities` rows are written once per channel (`metadata.channel = "slack" | "linkedin"`) and an org is "fully announced" only when both exist.
- Editorial review flow updated: `Approve & Post to Slack` posts + records the Slack row; the review message then exposes a **Mark posted to LinkedIn** action (also available on the admin members page) so admins who post the LinkedIn copy manually can close the loop.
- "What exists vs build" table reflects the pieces already shipped in #2246 (`profile_published` emit, admin members announce-ready columns) and flags the LI mark-posted action as the next build item.
