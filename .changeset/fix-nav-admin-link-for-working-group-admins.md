---
---

Show the "Admin" link in the account dropdown for admins whose status comes from the `aao-admin` working group (not just `ADMIN_EMAILS`), and for dev admin users. The injected `window.__APP_CONFIG__.user.isAdmin` that `nav.js` reads was only checking `ADMIN_EMAILS`, so anyone promoted via the aao-admin working group — and the `admin@test.local` dev user — lost their Admin menu item even though `requireAdmin` still let them in. Added `enrichUserWithAdmin` (same rules as `requireAdmin`) and called it everywhere the app config is built (`serveHtmlWithConfig`, both in-class and shared variants; `/api/config`).
