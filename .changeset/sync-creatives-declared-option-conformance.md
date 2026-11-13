---
"adcontextprotocol": minor
---

State that a seller accepts a creative that conforms to the format option it targets (adcp#8918).

- `sync_creatives` gains a "Format conformance" rule. A seller MUST NOT refuse, with a conformance code (`CREATIVE_SIZE_MISMATCH`, `CREATIVE_VALUE_NOT_ALLOWED`, `CREATIVE_VALIDATION_FAILED_GENERIC`, or `VALIDATION_ERROR` / `INVALID_REQUEST` against the assets), a creative on the grounds of a declared parameter that the creative satisfies, and MUST NOT enforce a narrower value than the one declared.
- A closed set narrows a slot only when declared. With no `cta_values`, the `cta` slot takes free text and `CREATIVE_VALUE_NOT_ALLOWED` does not apply.
- Any other narrowing parameter the option omits sets no limit through that parameter. Under `technical_requirements_complete: true` the seller holds no undeclared limit either, so a creative that conforms to every parameter is accepted. Without that assertion the omitted constraint stays undeclared, as before.
- Refusals outside format conformance are unchanged: `CREATIVE_REJECTED` for content, brand-safety and accessibility review, `POLICY_VIOLATION` for seller advertising policy, and validation codes for corrupt or unfetchable assets.
- The `CREATIVE_VALUE_NOT_ALLOWED` description and the `cta_values` descriptions on the `native_in_feed` and `image` canonicals now say the same. The canonical-formats and creative-formats docs carry the rule beside technical completeness.
- New compliance scenario `media_buy_seller/declared_format_option_acceptance` (3.3, required by `media_buy_seller`, gated on `creative.has_creative_library`). It seeds a `native_in_feed` option that declares a 336x280 `main_image`, a 90-character title limit, no `cta_values` and `technical_requirements_complete: true`, then expects `sync_creatives` to accept a creative built exactly to it, with a free-text CTA and no icon.

This tightens a seller obligation in the 3.3 beta. A seller that refused declared sizes or enforced an undeclared CTA list was already contradicting its own declaration; it now fails the new scenario.
