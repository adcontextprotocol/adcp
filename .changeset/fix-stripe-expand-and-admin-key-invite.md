---
---

Fix two production errors surfaced by Addie's system-error channel:

- `stripe-client.getAllOpenInvoices` was passing a 5-level expand path (`data.lines.data.price.product`), exceeding Stripe's 4-level cap and causing every admin "all open invoices" query to fail. The function also caught and swallowed the error, returning `[]` — so the bug surfaced to admins as "No pending invoices found" instead of a real failure. Now mirrors the `getRevenueEvents` pattern (drop the deep expand, fetch products via `stripe.products.retrieve` with a per-call cache) and propagates errors to the caller. The sole caller (`list_pending_invoices` admin tool) already wraps it in its own try/catch and surfaces structured failures.
- `POST /api/organizations/:orgId/members/by-email` (Path 1, WorkOS user does not exist yet) passed the synthetic `admin_api_key` user id as `inviterUserId` whenever the caller authenticated via `ADMIN_API_KEY`, which WorkOS rejects with `User not found: 'admin_api_key'`. The endpoint already special-cases the static-admin path for membership lookup; now it also omits `inviterUserId` for that path. Audit attribution remains via the existing `inviter_email` field on the audit log entry. Unblocks the Triton incident-script flow.
