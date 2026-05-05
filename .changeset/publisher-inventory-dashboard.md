---
---

Read-only publisher inventory dashboard for AAO-hosted domains. Adds
`GET /api/dashboard/inventory` (authenticated, scoped to the caller's WorkOS
org) that returns per-domain aggregate stats (agent count, property count,
public/verified status) for all hosted_properties rows owned by the org.
Wired into a new `/dashboard/inventory` HTML page.

Bulk-write operations (batch-edit domains, cross-domain merge) deferred
pending merge-strategy design and domain_verified security gating.
