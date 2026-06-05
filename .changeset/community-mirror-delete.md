---
"adcontextprotocol": minor
---

Registry: add `DELETE /api/registry/mirrors/:platform` to retire a community mirror.

Completes the #2176 community-mirror lifecycle with a moderator/admin-gated retire endpoint, closing the post-supersession deprecation window. Because buyers cache the mirror URL and fall back to it until the platform self-adopts, deletion refuses a mirror that has not published a `superseded_by` migration signal unless `?force=true` is passed — so live fallback traffic isn't yanked out from under buyers. After deletion the serving route returns 404, the documented "no mirror" state. The publish/delete authorization check is factored into a shared helper.
