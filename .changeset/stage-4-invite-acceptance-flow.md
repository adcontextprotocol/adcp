---
---

Prospect-facing invite acceptance flow. `/invite/:token` landing page + `GET /api/invite/:token` (public metadata) + `POST /api/invite/:token/accept` (authed, issues Stripe invoice, joins WorkOS org, records agreement, stores billing address). Completes the admin-invites-replace-direct-invoices chain. The prospect gets one link, signs in, confirms billing, and the invoice goes out.
