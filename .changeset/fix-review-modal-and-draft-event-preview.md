---
---

Fix editorial review modal (#2539) so reviewers see the full submission — the pending-content API now returns `subtitle`, `external_url`, and `external_site_name`; the modal renders link-type submissions, falls back to an explicit "no body" placeholder, and scrolls long articles via `max-height: 90vh`.

Let admins preview draft events via `/events/:slug` (#2536). The public endpoint now 404s only for non-admins when an event is still in draft; admins get the full detail page with a `draft_preview` flag and an in-page "Draft preview — not yet published" banner that points them to admin → events to change status.
