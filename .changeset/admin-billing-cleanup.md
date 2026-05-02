---
---

Two small admin-billing cleanups:

1. **Remove the dead invoice modal in `server/public/admin-accounts.html`.** Its only entry point (`openInvoiceForAccount`) was never invoked — the prospect-billing flow runs through `send_payment_request` (admin-tools) → invite → recipient signs in and invoices in their own session, so the inline modal was orphaned. Drops ~290 lines of HTML + JS.

2. **`docker-compose.yml` passes `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` through from `.env.local`** instead of hard-overriding to empty. The prior override killed billing-product rendering in dev and forced contributors to mock the products endpoint to test discount/invoice paths. Override in your shell env if a specific session is hanging on Stripe sync.
