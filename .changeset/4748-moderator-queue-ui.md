---
---

feat(admin): brand-logo moderation queue UI (closes part of #4748)

Second wedge from #4748. PR #4754 added the Slack notification + SLA hint; this PR gives moderators a place to actually drain the queue.

**New surfaces**

- `GET /admin/brand-logos` — authenticated page (HTML+JS at `server/public/admin-brand-logos.html`) listing every pending logo upload across all brands, with inline preview, uploader metadata, tags, optional note, and Approve / Reject / Delete actions. Approve / reject call the existing per-domain review endpoint, so the moderator workflow doesn't fork.
- `GET /api/brand-logos/pending` — moderator-only list endpoint. Wraps the existing `BrandLogoDatabase.getPendingLogos()` helper. Limit clamped to [1, 200]; negative offset coerced to 0.
- `GET /api/brand-logos/:id/preview` — moderator-or-owner image bytes for any review_status. The public CDN path (`/logos/brands/:domain/:id`) is strictly approved-only by design — without this route moderators couldn't see what they're reviewing. Falls back to `isVerifiedBrandOwner` check so a verified owner can preview their own pending uploads too. `Cache-Control: private, max-age=60` since the bytes are pre-moderation.

**Auth model**
- Page is `requireAuth` only — non-moderators load the page but the API 403s, and the UI renders a friendly "ask an admin to add you to brand-registry-moderators" message rather than a 404.
- API endpoints enforce membership in the `brand-registry-moderators` WG via the existing `isRegistryModerator` helper (newly exported from `brand-logo-auth.ts` for cross-brand use).

**Sidebar nav**

Added under the Registry section: `🖼️ Brand Logo Review` → `/admin/brand-logos`.

**Tests**

8 unit tests in `brand-logos-moderator-queue.test.ts` cover:
- Non-moderator 403 on the list endpoint.
- Moderator gets the wire shape with `preview_url` / `review_url` / `brand_view_url`.
- Limit/offset coercion.
- Preview endpoint: moderator serves any-status bytes; non-moderator owner fallback works; non-moderator non-owner 403s; non-uuid 400s; missing logo 404s.

**Still open on #4748**

- Per-user pending-queue depth alert (abuse signal).
- Per-brand reserved-slot logic when verified owner uploads after community-pending fills the cap.
- Approve/reject notifications threaded under the original Slack notify message.
