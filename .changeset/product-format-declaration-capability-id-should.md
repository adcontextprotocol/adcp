---
"adcontextprotocol": minor
---

`product-format-declaration.json` `capability_id`: sellers SHOULD publish a stable `capability_id` on every `format_options[]` entry (not just when structurally required to disambiguate). Pairs with the buyer-side `PackageRequest.capability_ids[]` added in 3.1 so sellers reading the 3.1 release notes see the obligation alongside the capability. Products without `capability_id` remain conformant; V2 buyers get `UNSUPPORTED_FEATURE / capability_ids_not_published` and fall back to `format_ids[]`.
