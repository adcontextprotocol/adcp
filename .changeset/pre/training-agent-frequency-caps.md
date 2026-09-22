---
"adcontextprotocol": patch
---

Add the `media_buy_frequency_cap_updates` compliance scenario covering root-cap
replace and clear through `update_media_buy_frequency_cap`, atomic rejection of
`new_packages` whose product cannot join the shared counter, the resulting-state
rule for clearing a cap while adding packages, and the `ACTION_NOT_ALLOWED`
path when the package mix can no longer change the root cap. The reference
training seller now implements package and shared MediaBuy frequency caps so
the four frequency-cap scenarios execute against it, and the specification
states the `ACTION_NOT_ALLOWED` rule for root-cap changes explicitly.
