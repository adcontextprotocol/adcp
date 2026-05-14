---
---

`/api/registry/operator?domain=X` now surfaces the queried member's AAO
membership tier when the profile owner has opted their member card into public
visibility (`is_public=true`). The `member` object grows two optional fields:
`membership_tier` (raw enum, e.g. `company_leader`) and `membership_tier_label`
(human-readable, e.g. `Leader`). Private profiles still return only
`{ slug, display_name }` — tier reflects billing state and we follow the
profile-card visibility toggle rather than introducing a second one. The
fields are absent (not `null`) for private profiles and for orgs without a
resolvable tier so existing consumers see no shape change.
