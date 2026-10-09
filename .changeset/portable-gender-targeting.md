---
"adcontextprotocol": minor
---

Add experimental core gender audience targeting for AdCP 3.3 (`media_buy.gender_targeting`): female, male, and non_binary value sets; explicit independent unknown handling; product-scoped native/signals capabilities; exact gender-only and mixed age/gender targeting readback; sex_gender governance classification; and a conformance storyboard. Implementing sellers MUST declare the feature id in experimental_features. Preserve stable age targeting and whole-demographics mutation semantics.

AdCP 3.2 core remains age-only. Buyers MUST NOT send core gender fields on a 3.2 contract; the bilateral 3.2 extension bridge is docs-only guidance and is not included in 3.3 source schemas.

AdCP 3.3 limitation: demographic-reporting-capability.json and canonical by_demographic delivery rows remain age-only. A gender-targeted package has exact targeting readback, but no canonical gendered delivery readback.
