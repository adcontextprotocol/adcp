---
"adcontextprotocol": minor
---

Add catalog content macros (`{ITEM_NAME}`, `{ITEM_DESCRIPTION}`, `{ITEM_TAGLINE}`, `{ITEM_PRICE}`, `{ITEM_PRICE_CURRENCY}`) for catalog-driven creative rendering

Extends the catalog-item macro family from ID values (`{SKU}`, `{GTIN}`, `{OFFERING_ID}`, …) to scalar content values, so catalog-driven creatives (sponsored_placement / DPA: Meta DPA, Snap Collection, TikTok Shopping) can substitute a rendered item's `name`, `description`, `tagline`, `price.amount`, and `price.currency` into a template. Each token maps 1:1 to a real, documented catalog field via the existing `catalog_field` dot-notation vocabulary (catalog-field-binding.json ScalarBinding) — no parallel field vocabulary is introduced.

All five are scalar TEXT values and fall under the existing catalog-item substitution-safety rules unchanged (NFC normalization → RFC 3986 percent-encoding to the unreserved set → one-pass nested-expansion prohibition → URL-context scope). No new escaping context is added; conformance vectors for content values are added to `catalog-macro-substitution.json`.

Single-brace `{MACRO}` only. `{{double-brace}}` stays reserved and is NOT adopted — it is one of the downstream ad-server macro syntaxes (`%%...%%`, `${...}`, `[...]`, `{{...}}`) that sales agents MUST neutralize/percent-encode; adopting it would relax a documented substitution-safety guarantee.

Which catalog items render stays seller-declared via the already-shipped `fanout_mode` enum on `sponsored_placement.json` (`single_item` / `per_item` / `multi_item_in_creative`); no buyer-side selection field is added. On ML-optimized DPA surfaces (Meta Advantage+, TikTok Shopping) the platform may override buyer-authored overlay text, so content macros are a buyer-declared hint the seller MAY honor.

`format.supported_macros.items` auto-extends via its `anyOf` universal-enum branch (#5099); no schema edit is needed there. Closes #5277.
