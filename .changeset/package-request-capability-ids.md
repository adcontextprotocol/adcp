---
"adcontextprotocol": minor
---

Add `capability_ids[]` to `PackageRequest` (the `packages[]` item shape on `create_media_buy`) as a V2 path equivalent to `format_ids[]`. Lets buyers reading the V2 mental model (`Product.format_options[]`) author a `create_media_buy` call without translating back through `v1_format_ref[]`.

Symmetric with the V2 path that `creative-manifest` already exposes (manifest carries a single `capability_id`; package-side carries an array since one package may activate multiple `format_options` entries).

Additive optional field. When both `capability_ids` and `format_ids` are sent, `capability_ids` wins and the seller routes by it; the resolving seller ignores `format_ids` (V2-native buyer SDKs SHOULD still emit it as a v1-compat hint for v1-only sellers further down the wire). When neither is sent, the package defaults to all formats supported by the product (unchanged from v1 behavior). Sellers MUST reject with `UNSUPPORTED_FEATURE` when an entry doesn't match a `format_options[]` entry, when the product is v1-only (no `format_options[]` at all), or when the product's `format_options[]` entries don't publish `capability_id` values.

Closes #4842.
