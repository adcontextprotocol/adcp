---
---

Stop paging on routine Slack API conditions in `server/src/slack/client.ts`. Two specific call sites that fired `:rotating_light: System error: slack-client` alerts today get downgraded to `warn` when the underlying Slack error is a known third-party state, not a server failure:

- `getSlackUser`: `user_not_found` (deactivated/deleted users, stale message references) → `warn`. The function already returns `null` for the caller to handle.
- `inviteToChannel`: `not_in_channel`, `channel_not_found`, `is_archived`, `user_is_restricted`, `user_is_ultra_restricted`, `user_disabled` → `warn`. Caller already gets `{ ok: false, error }` and decides what to do; bot-not-in-channel is normal Slack behavior, not a system failure.

Other paths in the file still log at `error` for unknown failures. Follows the convention added in the `logger` JSDoc.
