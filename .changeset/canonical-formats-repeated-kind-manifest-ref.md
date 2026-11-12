---
"adcontextprotocol": patch
---

Clarify that a seller MUST reject a creative manifest without `format_option_ref` when two or more of the target product's `format_options` share its `format_kind`, and MUST NOT infer the option from which declaration the assets fit (adcp#8625). The `media_buy_seller/canonical_formats` storyboard (now 1.2.0) gains a phase, gated on `media_buy.features.inline_creative_management`, that seeds a product with two image declarations and checks that an inline `create_media_buy` manifest is accepted with `format_option_ref` and rejected without it.
