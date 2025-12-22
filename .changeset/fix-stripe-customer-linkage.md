---
"adcontextprotocol": patch
---

Fix Stripe customer linkage for pricing table and add invoice.paid webhook handler

- Create Stripe customer with `workos_organization_id` metadata before showing pricing table, preventing the pricing table from creating unlinked customers
- Handle `invoice.paid` webhook event in addition to `invoice.payment_succeeded` to support offline/manual payments
