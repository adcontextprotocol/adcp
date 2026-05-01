---
---

Rename the `/member-hub` page label from "Member hub" to "Your hub" so the personal-dashboard framing matches what the page actually is (it greets "Welcome back, [firstName]" and is entirely about the signed-in user — "member" was reading as organizational). URL stays at `/member-hub` for back-compat. Also fixes Addie's GitHub guidance: `urls.md` and `member-context.ts` now name three distinct surfaces — `/account` (Social-links text field for community profile display), `/member-hub` (Connections card with Connect/Disconnect button), `/connect/github` (session-aware bouncer that starts the OAuth flow on click) — so Addie stops sending users to `/account` when they ask to disconnect. Filed #3705 for the broader Slack ↔ web session-bridging gap (separate concern).
