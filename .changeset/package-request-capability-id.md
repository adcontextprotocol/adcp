---
"adcontextprotocol": minor
---

Add `capability_id` to `PackageRequest` and confirmed `Package` response, closing the v2 format-selection gap at the `create_media_buy` boundary.

`Product.format_options[]` (discovery) and creative manifests (fulfillment) already use the v2 `capability_id` path. `PackageRequest` previously forced buyers back through `format_ids[]` (v1 vocabulary) to book a buy, requiring an SDK translation step via `v1_format_ref[]`.

This minor adds `capability_id?: string` as an optional alternative to `format_ids[]` on `PackageRequest`. When present, the seller looks up the product's `format_options[]` entry by `capability_id` and routes accordingly. Existing `format_ids[]`-based requests are unchanged. The confirmed `Package` response echoes `capability_id` when the buyer used the v2 path.

Normative resolution rules and the `VALIDATION_ERROR`-on-miss behavior are documented in the `create_media_buy` task reference.
