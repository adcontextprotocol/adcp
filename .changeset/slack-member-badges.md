---
---

Ship two independent Slack member-identity layers for AgenticAdvertising.org:

**1. `@aao-members` Slack user group (WorkOS webhook sync)**
Adds/removes members from a Slack user group on `organization_membership.*` events, enabling member-wide @-mentions. The group is auto-created on first use; group ID and handle are overridable via `SLACK_MEMBER_USER_GROUP_ID` / `SLACK_MEMBER_USER_GROUP_HANDLE` env vars. Requires `usergroups:read` + `usergroups:write` scopes on the bot token.

**2. Member photo-badge overlay infrastructure (gated by `auto_apply_aao_badge` toggle, default OFF)**
Composites a small circular AgenticAdvertising.org badge onto a member's Slack profile photo (bottom-right, ~28%, white ring). Key pieces:
- `sharp`-based compositing in `server/src/slack/photo-badge.ts`; placeholder SVG badge ships now, final asset drops in via `server/public/assets/aao-member-badge.png` swap later
- `users.profile.get` to fetch the current photo URL; `users.setPhoto` to upload the composited result (requires `SLACK_ADMIN_USER_TOKEN` with `users:write`)
- DB columns `original_photo_url`, `badge_photo_applied_at`, `badge_opt_out` on `slack_user_mappings` (migration 448)
- Auto-applied on `organization_membership.created/updated`; reverted on `deleted` and membership inactivation
- Admin-settings toggle `auto_apply_aao_badge` (default OFF — no production effect until flipped)
- Admin backfill endpoint: `POST /api/admin/slack/apply-member-badge-backfill?dry_run=true`
- Per-user opt-out: `POST /api/admin/slack/:slackUserId/badge-opt-out` + `/aao badge off` slash command
- Daily reconcile job (`member-badge-reconcile`) re-applies the badge if the user has updated their own photo

Both layers ship together and close #2340. The badge asset swap and `auto_apply_aao_badge` toggle-flip are ops decisions that do not block the merge.

**Note:** Existing members at deploy time are not backfilled automatically for the user group — they join on their next membership event or via the admin backfill endpoint. The photo badge backfill requires the toggle to be ON first.
