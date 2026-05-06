---
---

Auto-populate `member_profiles.primary_brand_domain` from a verified WorkOS email domain when the profile field is null and the domain is claimable. Closes the surprise where SSO members hit "Set your primary brand domain first" on the publish-agent path even though their email domain was the obvious brand identity. Existing brand-claim values are never clobbered. Backfill script `server/scripts/backfill-primary-brand-domain.ts` catches profiles created before this change. Publish-path error message is now actionable instead of terse.
