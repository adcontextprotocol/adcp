---
"adcontextprotocol": minor
---

Add the parameterized `GDPR_CONSENT_<gvl_id>` universal macro family so the receiving vendor's IAB Global Vendor List ID survives translation and declared macro processing. Retain unscoped `GDPR_CONSENT` for resolvers that do not require a vendor ID, require empty consent when a vendor-scoped target has no known ID, and reject multiple scoped consent occurrences per translated URL. Publish 3.3 translation vectors covering vendor ID preservation, missing-vendor fallback, consent diagnostics, and duplicate rejection.

Add optional `ADDTL_CONSENT` for the CMP-provided Google Additional Consent string alongside TCF consent. Require opaque value preservation and consent diagnostics, and cover native translation, existing native token preservation, missing mappings, frozen values, and empty unavailable values in the 3.3 vectors.
