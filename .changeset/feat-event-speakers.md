---
---

Add event speakers (#2552). Admins can attach an ordered roster of speakers to an event — name, title, company, bio, headshot URL, and link URL — via a new section in the `/admin/events` edit modal. The roster renders as cards on the public `/events/:slug` page (initials fallback when no headshot), and is surfaced by both `GET /api/events/:slug` and `GET /api/admin/events/:id`. Writes go through `PUT /api/admin/events/:id` with replace-all semantics inside a transaction.
