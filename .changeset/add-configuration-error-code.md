---
"adcontextprotocol": minor
---

Add `CONFIGURATION_ERROR` to the canonical error-code catalog.

Fills a gap where no existing code represented seller-side deployment misconfiguration — a terminal, non-retryable state that the buyer cannot fix. Distinct from `INVALID_REQUEST` (buyer-fixable), `SERVICE_UNAVAILABLE` (transient), `UNSUPPORTED_FEATURE` (capability mismatch), and `ACCOUNT_SETUP_REQUIRED` (buyer-side onboarding). Aligns the canonical spec with the Python SDK's existing `KNOWN_NON_SPEC_CODES` workaround (adcp-client-python#487).
