---
---

Audit trail for `member_profiles.is_founding_member` (closes #4014).

Adds three columns — `founding_member_source`
(`auto_pre_cutoff` | `manual_grandfather`), `founding_member_granted_at`,
`founding_member_granted_reason` — and backfills auto-grants from `created_at`
plus the one known manual grandfather (Affinity Answers, 2026-05-03).

The admin update paths (HTTP `PUT /api/admin/member-profiles/:id` and the
Addie `update_member_profile` MCP tool) now reject `is_founding_member: true`
without a `founding_member_source`, stamp `granted_at` server-side (callers
can't backdate provenance), and clear the audit metadata on revoke.
Non-admin update paths strip the new fields the same way they strip
`is_founding_member`.

Out of scope (follow-ups): coupling the badge grant to the Stripe pricing
override, and broadening `founding_member_source` beyond the two current
categories.
