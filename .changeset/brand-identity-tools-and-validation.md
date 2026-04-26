---
---

Brand identity hygiene + Addie tooling rework, triggered by two stuck-logo escalations (thehook.es, kyber1.com):

**Member self-service**
- `update_company_logo` — new member tool so a logged-in user can update their own logo or brand color through Addie chat. Was previously admin-only via `update_member_logo`, which forced an escalation for every "fix my logo" request.

**Admin tooling**
- `list_pending_brand_logos`, `list_brand_logos`, `review_brand_logo` — surface the registry approval queue and let aao-admin members approve/reject from any thread. `getPendingLogos` existed in the DB layer but had no caller, so uploads sat invisible until manually escalated.
- Wired `update_member_logo` and `update_member_profile` into the `admin` tool set — they were defined but unreachable from the router, the same shape of gap that hid the new logo-review tools.
- `canReviewBrandLogos` accepts the synthetic `admin_api_key` user so internal tooling can read pending logos via `GET /api/brands/:domain/logos`.

**Validation hardening**
- `checkLogoUrlIsImage` HEAD-fetches saved logo URLs and rejects responses that aren't `image/*`. Catches Google Drive `/view` and Dropbox preview pages that silently return HTML and render as a broken image once stored. Wired into both the member-facing `PUT /api/me/member-profile/brand-identity` and admin/member Addie tools.
- `canonicalizeBrandDomain` strips `https://`, `www.`, `m.`, paths, queries, fragments, and lowercases. Applied on every brand-identity save so members no longer split-brain into separate `kyber1.com` / `www.kyber1.com` registry rows.

**Resolver fixes**
- `resolveBrandFromJson` accepts the singular `logo: {url}` shape and the `brand_colors` alias used by some real-world brand.json publishers (e.g. `house_portfolio` variants). Previously these brands appeared logoless on member surfaces despite declaring a valid logo. `referrals.ts` and `si-chat.ts` switched to the shared resolver instead of inline `brands[0].logos[0]` extraction.

**UI fallback**
- Logo `<img>` elements on the dashboard sidebar and member-profile page now swap to the placeholder when the URL fails to load (broken host, expired link, viewer page). Already-stored bad URLs no longer leave the section visually empty.

**Refactor**
- Extracted shared `updateBrandIdentity` service so the route handler, the new `update_company_logo` member tool, and the existing `update_member_logo` admin tool all run identical transaction logic, validation, and canonicalization.
