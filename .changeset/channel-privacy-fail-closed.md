---
---

**fix(admin): fail-closed on write-time channel privacy check (#3003)**

Closes the pre-existing security gap flagged during PR #3000 review.

**Before:** all seven admin-settings PUT endpoints guarded their
`is_private` requirement with `if (channelInfo && !channelInfo.is_private)`.
When `getChannelInfo` returned `null` (bot not a member, Slack 5xx,
throttle, archived channel, wrong scope), the `channelInfo && ...`
short-circuit silently skipped the check and the write was accepted.

- For the six private-required endpoints (billing, escalation, admin,
  prospect, error, editorial), the downstream `sendChannelMessage(...,
  { requirePrivate: true })` gate at send time covered most exposure.
- The announcement endpoint inverts the check (requires public) and
  has no downstream gate, so a `null` return accepted a private
  channel id that would silently never receive the public post.

**After:** new `verifyChannelPrivacyForWrite(channelId, expected)`
helper in `slack/client.ts` returns a discriminated result:

- `{ ok: true }` — proceed
- `{ ok: false, reason: 'wrong_privacy', actual, expected }` —
  channel confirmed wrong kind; pick another channel
- `{ ok: false, reason: 'cannot_verify' }` — Slack can't describe
  this channel; invite the bot and retry

All seven endpoints now go through a `requireChannelPrivacy` wrapper in
`settings.ts` that surfaces distinct error messages for each branch so
the admin knows whether to pick another channel or retry after inviting
the bot. Local-dev behavior (no ADDIE_BOT_TOKEN) is unchanged —
`isSlackConfigured()` short-circuits.

Closes #3003.

**Tests:** five new `verifyChannelPrivacyForWrite` cases in
`slack-channel-privacy.test.ts` (ok both directions, wrong_privacy
both directions, cannot_verify both directions) plus eight
supertest route tests in the new
`admin-settings-privacy-gate.test.ts` covering the billing (private-
required) and announcement (public-required) endpoints across all
three outcomes + the Slack-not-configured short-circuit. Full
announcement + privacy suite 206/206 pass; server typecheck clean.
