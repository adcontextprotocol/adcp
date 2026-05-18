---
"adcontextprotocol": patch
---

Billing address modal: the Country field is now a select of ISO-3166-1 alpha-2 codes instead of a free-text input, matching what the server validator and Stripe `customer.address.country` require. Previously typing "Singapore" produced a generic "Please provide line1, city, state, postal_code, and country (each ≤ 200 chars)" error even when every field was populated, because the validator silently rejected non-alpha-2 values.

The server now uses `validateBillingAddress(input)` which returns a discriminated `{ok, address|error}` result, so `POST /api/organizations/:orgId/billing/invoice-request` and `PUT /api/organizations/:orgId/billing-address` return the specific failure (`Country must be a 2-letter ISO code (e.g. US, GB, SG)`, `Please provide city, postal code`, etc.) instead of a single misleading message. `sanitizeBillingAddress` is kept as a thin wrapper for backward compatibility.
