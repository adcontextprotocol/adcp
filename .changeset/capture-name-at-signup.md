---
---

fix(signup): capture first/last name reliably so credentials never read "undefined undefined"

Three coordinated changes that close the gap behind escalation #382 (Tom Hespos's credential, plus 12 other learners with email-fallback names):

1. **Auth callback now applies the Slack-name fallback that the WorkOS webhook already had.** When `users.first_name` would be inserted as NULL, we now look at the user's `slack_user_mappings.slack_real_name` (or `slack_display_name`) and split it into first/last. 8 of the 11 nameless users on prod already have a Slack mapping with the right name — next time they sign in, they're silently backfilled.

2. **Onboarding gates on a name.** When the callback fallbacks still produce no name (no Slack mapping, no WorkOS profile), `/onboarding.html` now shows a "What should we call you?" step before the rest of the flow. Submits to the existing `PUT /api/me/name`.

3. **`PUT /api/me/name` pushes back to WorkOS.** Previously we only wrote to our `users` table and `organization_memberships`; WorkOS itself kept NULL, which meant the next webhook could overwrite us. Now WorkOS becomes the source of truth.

The Slack-fallback cascade is extracted into `server/src/utils/resolve-user-name.ts` and used by both the auth callback (`server/src/http.ts`) and the WorkOS user-update webhook (`server/src/routes/workos-webhooks.ts`), so the two paths can't drift.
