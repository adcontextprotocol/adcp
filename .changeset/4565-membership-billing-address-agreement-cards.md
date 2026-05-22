---
"adcontextprotocol": patch
---

Membership dashboard: surface billing address and membership agreement as first-class actions, independent of the invoice-request flow. The address card writes through a new `PUT /api/organizations/:orgId/billing-address` endpoint; the agreement card reuses the existing `POST /api/organizations/:orgId/pending-agreement` write. Both cards are visible to non-subscriber company orgs so prospects can complete prerequisites before invoicing — previously the only path to enter either was inside the invoice modal, which required both to be set simultaneously.

`getPendingInvoices` now drops Stripe draft invoices with no line items or zero `amount_due` — abandoned subscription attempts left phantom $0 drafts that surfaced as "pending invoice" and confused users. `/dashboard/membership` now serves `dashboard-membership.html` directly (was 301-redirecting to `/organization#membership`, which has a summary but no invoice management). Closes #4564, #4565, #4573. Refs escalations #347, #348.
