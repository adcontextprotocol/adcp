---
---

Fix `hasValidOAuthTokens` treating near-expiry access tokens as invalid when a refresh token exists. The auth-status endpoint no longer flips `has_auth` from true → false as tokens age, keeping the UI on "Auth configured" instead of flashing back to the OAuth form for agents that can be silently refreshed.
