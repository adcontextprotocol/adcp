---
---

Tighten `/api/invoice-request` to require auth + org membership + signed agreement. Drops the free-text companyName/contactName/contactEmail inputs (which created orphan Stripe customers that webhooks couldn't link back to an org). Company name now comes from the org record, contact from the session. Billing address is stored on the org for future pre-fill. `createAndSendInvoice` also prefers the org's existing Stripe customer over dedup-by-email, fixing Stefan-style splits where auto-provisioned customers lacked org metadata.
