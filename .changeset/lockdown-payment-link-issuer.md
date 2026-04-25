---
---

Lock down payment-link and invoice issuance to the authenticated member only.

Removes four direct-issue paths that let an admin-typed `prospect_contact_email` or an LLM-supplied `customer_email` become the Stripe customer of record:

- `POST /api/admin/accounts/:orgId/payment-link` (now 410 Gone)
- `POST /api/admin/prospects/:orgId/payment-link` (now 410 Gone)
- Addie billing tool `create_payment_link` no longer accepts `customer_email`; sources email from the signed-in member context only and stamps `workosUserId` on the checkout session
- Addie billing tools `send_invoice` / `confirm_send_invoice` no longer accept caller-supplied `contact_email`, `company_name`, `contact_name`, or `billing_address`; all four come from the signed-in member's identity and the org row
- Addie admin tool `send_payment_request` actions `payment_link` and `send_invoice` are removed; new `send_invite` action wraps the existing `invite-membership` flow so the recipient signs in and pays as themselves

Admin UI payment-link modals (admin-account-detail.html, admin-accounts.html) are removed; admins use the membership-invite affordance, which already exists. Mirrors the same lockdown the invoice direct-issue path got in PR #2876 / commit 23018ce5e.
