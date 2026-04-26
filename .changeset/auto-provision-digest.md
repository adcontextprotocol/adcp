---
---

feat(notifications): daily digest of new auto-provisioned members for org admins

The consent receipt for the `auto_provision_verified_domain` default. With auto-add on (which it is by default), org membership grows quietly when verified-domain emails sign in — owners had no signal that their seat list was changing. This adds a daily Slack digest that lists the new auto-joined members per org and links to the team page where the owner can review or flip the toggle off.

## Mechanics

- New per-org watermark `organizations.last_auto_provision_digest_sent_at`. Migration 437.
- New `findOrgsWithNewAutoProvisionedMembers()` and `listNewAutoProvisionedMembers(orgId, since)` queries find members where `provisioning_source = 'verified_domain'` and `created_at > watermark`. Skips personal workspaces and orgs with `auto_provision_verified_domain = false`.
- `server/src/scheduled/auto-provision-digest.ts` runs the check every 24 hours (5-minute startup delay so it doesn't fire during boot's noisy window). Uses the same Slack DM dispatch helper (`sendToOrgAdmins`) that the seat-request reminder job uses, so multi-admin orgs get a group DM and single-admin orgs get a direct DM.
- Watermark is only updated after a successful Slack delivery. If no admins are mapped to Slack, or delivery fails, the watermark stays put and the next run retries — eventually surfaces the news once an admin's Slack mapping shows up.

## Tests

- `server/tests/integration/membership-webhook.test.ts` — 31 → 37 tests. Six new cases cover: candidates filtered to verified-domain since watermark, opt-out flag honored, NULL watermark = beginning of time, members returned chronologically with non-verified-domain sources excluded, and `markAutoProvisionDigestSent` updating the timestamp.

## Future

- Email fallback for orgs without Slack mappings (defer — Slack is the primary admin surface today).
- Per-org cadence preference (defer — daily is the right default for a low-volume notification).
- "What's in this digest" preview accessible from the team page (defer — wire into the next admin UI cycle).
