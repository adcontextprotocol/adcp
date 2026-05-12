---
---

fix(registry): rehost external `logo_url` values as same-origin assets

Brand identity writes (PUT `/api/me/member-profile/brand-identity` + the two Addie tools) now download external `logo_url` bytes server-side via `safeFetch` and store them as a `brand_logos` row before writing the manifest. The manifest URL becomes our own `/logos/brands/<domain>/<uuid>`, same-origin from then on.

Why: many publishers and ad-tech sites ship `Cross-Origin-Resource-Policy: same-origin` (Cloudflare's default for the Free plan, Vercel's `vercel.json` examples, every Fly-fronted site that doesn't override). When a brand's `logos[0].url` points to such a site, `<img src>` on `agenticadvertising.org` shows a broken-image icon even though the URL is publicly fetchable in a tab — the browser enforces CORP before paint. Members signing up via the dashboard didn't see this because the file-upload path already produces same-origin URLs; members whose brand was auto-enriched (Brandfetch / scraped from contact-website) or who pasted a direct URL from their site landed on a broken logo with no diagnostic.

Behavior:

- **Fallback-safe.** Network errors, non-2xx, oversized body (>5 MB), or unsupported content-type each log a warning and keep the original URL in the manifest. The pre-existing `checkLogoUrlIsImage` already ensured the URL is reachable and image/*, so the fallback URL is still a sane value — it just renders broken when CORP blocks it. Paired with the `member-card.js` `onerror` fallback (added in this PR), end users see the initial-letter tile instead of the broken icon.
- **Idempotent.** URLs already on our `BASE_URL` host are passed through untouched; re-saving the same profile is a no-op rather than rehosting our own asset back into itself.
- **Dedup on `(domain, sha256)`.** If the same image was already uploaded for this brand, the rehost reuses that row instead of inserting a duplicate.
- **SSRF-safe.** Uses `safeFetch` (private-IP rejection at TCP-connect time) rather than raw `fetch`/`axios`. A malicious `logo_url` cannot pivot to an internal service.
- **Attribution.** When `uploadedBy` is threaded through (the brand-identity route does), the `brand_logos` row gets the caller's user id and email; Addie tools that don't pass it still rehost, just without user attribution.

**Backfill** for existing rows: `server/src/scripts/rehost-external-brand-logos.ts` walks every `brands` row with a manifest, finds external URLs at every shape the resolver reads (`brands[*].logos[*]`, `brands[*].logo`, `logos[*]`, `logo`), and rewrites each in place via the same `rehostExternalLogo` path. Default dry-run, `--apply` to write, `--domain <x>` to scope. Run via `fly ssh console -a adcp-docs -C 'node /app/dist/scripts/rehost-external-brand-logos.js --apply'`.

The backfill writes via raw `UPDATE` rather than `editDiscoveredBrand` so it doesn't emit a `brand_revisions` entry per row — a sweep across hundreds of brands shouldn't flood the audit log with identical "rehosted logos" rows, and the byte-level provenance is preserved on the new `brand_logos` row's `uploaded_by_email` / `upload_note`. Operator should log the script run if forensics later need a who-changed-this-manifest answer.

Touches: `server/src/services/brand-logo-service.ts` (new `rehostExternalLogo`), `server/src/services/brand-identity.ts` (calls rehost after domain canonicalization), `server/src/routes/member-profiles.ts` (threads `uploadedBy`), `server/src/scripts/rehost-external-brand-logos.ts` (backfill), `server/public/member-card.js` (img `onerror` → placeholder), `server/tests/integration/brand-orphan-adoption.test.ts` (mock new export).
