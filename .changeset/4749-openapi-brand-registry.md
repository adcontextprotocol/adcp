---
---

docs(openapi): document brand-registry endpoints (closes #4749)

Long-standing gap surfaced by the #4748 docs review: the brand-registry surface had no entries in `static/openapi/registry.yaml`. Adds 9 operations across 7 paths, two new tag groups (`Brand Logos`, `Brand Wiki`), and documents every error code introduced by #4742 / #4743 / #4754 / #4755 / #4757.

**New paths**

- `GET /brands/{domain}/brand.json` — public AAO-hosted brand.json (the URL agents fetch; the one that 404'd `scope3.com` in #4743 before the source_type promotion fix).
- `GET /api/brands/{domain}/ownership` — ownership status driving the brand-viewer claim CTA (#4742).
- `POST /api/brands/{domain}/logos` — logo upload with full error-code matrix: `verified_owner_required` (with `claim_url`), `community_cap_reached`, `pending_queue_full`, plus the `message` + `review_sla_hours` hints on pending responses.
- `GET /api/brands/{domain}/logos` — list logos (caller-visible fields vary by review authority).
- `POST /api/brands/{domain}/logos/{id}/review` — moderator approve/reject/delete.
- `GET /api/brand-logos/pending` — cross-brand moderator queue (#4755).
- `GET /api/brand-logos/{id}/preview` — moderator-or-owner image-byte preview, with the 403/404 oracle collapse documented (#4755 hardening).
- `PUT /api/brands/discovered/{domain}` — community brand wiki edit, with the `enriched → community` side-effect on first content edit (#4743).

**Tags added**

- `Brand Logos` — covers upload/list/review/preview.
- `Brand Wiki` — covers community brand editing.

No code or behavior changes; documentation only. Each path documents the error responses, codes, and Slack-side effects called out in the corresponding PRs.
