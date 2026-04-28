---
---

Surface assessment rubric dimensions and human-review appeal path in the certification dashboard. Completed module cards now show a collapsible "About this assessment" panel with per-module scoring dimensions (lazy-loaded from the module API), a link to `/ai-disclosure#review`, and a "Request human review" CTA backed by a new `POST /api/me/certification/review-request` endpoint that routes intake to `certification@agenticadvertising.org` via Resend.
