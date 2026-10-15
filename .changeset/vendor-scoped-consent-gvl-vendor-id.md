---
"adcontextprotocol": minor
---

Add vendor-scoped consent to the universal macro contract. `macro-declaration` and `macro-translation-target` gain an optional integer `gvl_vendor_id` (`minimum: 1`, `x-added-in: 3.3.0`), valid only when `universal_semantic` is `GDPR_CONSENT`, so a source token such as `${GDPR_CONSENT_755}` keeps the IAB Global Vendor List id of the receiving vendor through translation. `enums/universal-macro.json` adds `ADDTL_CONSENT` (Google Additional Consent string). `docs/creative/universal-macros.mdx` adds three rules: a translator with no vendor id for a vendor-scoped target emits an empty value and never a placeholder (`{GDPR}` still passes), a vendor-scoped consent macro appears at most once per URL after translation, and `gvl_vendor_id` round-trips unchanged. `universal-macro-translation.json` gains vectors for the round trip to `${GDPR_CONSENT_755}` and for a missing id producing an empty value, never `XXX`.

Closes #8195.
