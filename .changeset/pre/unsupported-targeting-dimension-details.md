---
"adcontextprotocol": minor
---

Add `error-details/unsupported-targeting-dimension.json` as the recommended details shape for `UNSUPPORTED_FEATURE` when a targeting dimension is unsupported for the product or seller, or has been removed (`unsupported_dimension`, optional `supported_dimensions`, `deprecated`, `replacement_dimension`, `product_id`, `package_index`). `error.field` SHOULD point at the targeting path; recovery stays `correctable`. No new error code is added: adapters currently minting `UNSUPPORTED_TARGETING_DIMENSION` or `DEPRECATED_TARGETING_DIMENSION` should migrate to `UNSUPPORTED_FEATURE` plus these details. Closes #6978.
