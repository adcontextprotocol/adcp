---
"adcontextprotocol": patch
---

Extend `check:platform-agnostic` lint to cover enum and const values; fix `brand.json` platform-agnosticism violation.

**Lint extension (`tests/check-platform-agnostic.cjs`):** adds enum/const-value scanning alongside the existing property-name check. Uses a path-qualified `ENUM_VALUE_ALLOWLIST` so the same vendor token can be legitimate in one enum (e.g., `roku` in `enums/genre-taxonomy.json`) but a violation in another. Pre-compiles vendor-token regexes. Skips `examples` arrays (user-data samples, not normative definitions). Title/description text intentionally excluded — vendor names in prose are permitted per spec-guidelines.

**Schema fix (`static/schemas/source/brand.json`):** removes the single-value enum `["openai_agentic_checkout_v1"]` from `product_catalog.agentic_checkout.spec` and replaces it with a free-form `string`. The enum encoded a specific vendor's checkout API version as a normative discriminator, violating the platform-agnosticism rule in `docs/spec-guidelines.md`. Non-breaking: existing data using `"openai_agentic_checkout_v1"` remains valid.

**Note:** `openai_product_feed` in `brand.json`'s `feed_format` enum is contested (see #2439): one expert treats it as a violation; another treats it as a canonical feed-schema identifier parallel to `google_merchant_center`. It is allowlisted pending @bokelley's decision.

Closes #2439.
