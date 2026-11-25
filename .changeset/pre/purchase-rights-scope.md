---
"adcontextprotocol": minor
---

Add experimental `media_buy.purchase_rights` (#8090): an optional `rights[]` array on `product-purchase.json` carries usage and amplification rights inside `commercial_terms`, so `terms_digest` and `accept_proposal` bind them. Rights are priced in the purchase, the media seller grants or warrants them, and exclusivity is per purchase. The array references a new `brand/rights-scope.json` (`uses`, `start_date`, `end_date`, `exclusivity`) hoisted from `brand/rights-terms.json`, which now composes it with `allOf` alongside its pricing fields. `rights-terms` properties and required fields are unchanged, with one tightening: an empty `uses` array is now rejected (`minItems: 1`). Generated types for this experimental surface may change shape. The `right-use` enum gains `paid_amplification` and `content_reuse`, covered by `brand.rights_lifecycle`; the enum is shared, so `rights-constraint` and `generation-credential` also accept them before attested grants exist. No rights grant is minted at acceptance; whether acceptance should mint an attested grant that a `rights-constraint` can cite is open.

Withdrawn before 3.3.0 GA (#8537): everything in this entry shipped only in `3.3.0-beta.1` and was removed after it, because it extends `commercial_terms`, which is held closed until 4.0. It is planned for 4.0 (`purchase_rights_required_in_4_0`).
