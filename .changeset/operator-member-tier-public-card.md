---
---

`/api/registry/operator?domain=X` now surfaces the queried member's public
level info when the profile owner has opted their member card into public
visibility (`is_public=true`). The `member` object grows three optional
fields:

- `is_founding_member` (boolean) — present whenever the profile is public
  (true or false; absent for private profiles)
- `membership_tier` (raw enum, e.g. `company_icl`, `company_leader`) —
  present only when the org also has a resolvable tier
- `membership_tier_label` (human-readable, e.g. `Partner`, `Leader`) —
  matches the AAO pricing page; presence mirrors `membership_tier`

Private profiles still return only `{ slug, display_name }`. Tier and
founding-member status reflect billing/cohort state and follow the existing
profile-card visibility toggle rather than introducing a second one. Fields
are absent (not `null`) when not applicable, so existing consumers see no
shape change.

Also fixes the `company_icl` label in `tierLabel()` from `Member` to
`Partner` so it matches the public pricing page and the dashboard (which
already used `Partner`). Founding Member is orthogonal to tier — founding
orgs typically display both badges (e.g. Scope3 shows `Partner` +
`Founding Member`).
