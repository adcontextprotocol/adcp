---
---

Fix `create_github_issue` to prompt reauth when the user's GitHub Pipes token is active but missing required scopes.

The Pipes call returns `{ status, accessToken, scopes, missingScopes }`, but the handler only branched on `status !== 'ok'` — so users with a stale connection that lacked `public_repo` (or any scope we now require) silently called GitHub and got a 403 fallback message ("Failed to create issue (403). Use draft_github_issue…") instead of the "Reconnect GitHub" prompt that would actually fix it.

Now: when `status === 'ok' && missingScopes.length > 0`, treat it the same as `needs_reauthorization` and surface the reconnect URL. Also logs `missingScopes` at `info` for observability so we can see which scope(s) Pipes is reporting missing.

Diagnosed from real-user 403s in PostHog `$exception` events on 2026-04-29.
