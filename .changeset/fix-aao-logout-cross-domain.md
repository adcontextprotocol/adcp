---
---

Fix: Log out from `adcontextprotocol.org` now actually logs the user out.

Previously, `/auth/logout` on the AdCP domain only cleared the AdCP-side cookies and redirected to `/`. The session bridge would then re-pull the still-valid AAO session and restore the user's cookies, making logout a no-op.

The handler now mirrors the existing `/auth/login` and `/auth/signup` pattern: when on the AdCP domain, it clears AdCP-side cookies and redirects to `https://agenticadvertising.org/auth/logout?return_to=<adcp-url>` so the AAO session is revoked at WorkOS. AAO's logout accepts an AdCP `return_to` (validated via `isAllowedAdcpUrl`) and bounces the user back. After bouncing back, the bridge sees no AAO session, sets `bridge-checked`, and renders the logged-out nav.
