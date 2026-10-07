# Price adjustment resolution vectors

These vectors pin the deterministic resolution rule for `price_adjustments` on
a binding fixed-price pricing option:

1. Matching is full-identity equality after resolution. Different encodings of
   one placement match; the same format option ID under a different `scope`
   does not.
2. At most one row fires per dimension: the first matching row in declared
   order. A multi-value selection never fires one row once per value.
3. Stacking is additive against the base rate. Each firing row contributes a
   delta computed from `fixed_price` (the base, already net of the option's own
   declared breakdown): an `amount` row its amount, a `rate` row
   `fixed_price x rate`. Fees add and discounts subtract. `10% + 10%` from two
   dimensions adds `20%` of `fixed_price`, and cross-dimension order does not
   change the price.
4. Each rate delta is rounded half away from zero to the option's price
   precision: the greatest of the currency minor-unit exponent, 4 for
   `cpm`/`vcpm`/`cpc`/`cpcv`/`cpv`, and the fewest decimal places that exactly
   represent `fixed_price` and each row amount. Precision is by numeric value
   (`0.0100` is `0.01`). The resolved price is the exact sum and is not rounded
   again; it never falls below zero (such a purchase is rejected, never
   clamped).
5. Omitted or default selections match no row and pay the base rate.
6. A buyer-supplied `pricing` that differs from the resolved result is
   rejected with `INVALID_REQUEST` carrying the resolved price and breakdown; a
   changed table requires a new `pricing_option_id`.
7. An accepted snapshot carries `base_fixed_price`, the resolved `fixed_price`,
   a `price_breakdown` of declared adjustments plus each fired row as its
   currency amount, and the retained table, so a verifier can re-resolve it.

Resolvers MUST use exact decimal or integer arithmetic. The tie cases
(`1.15 x 0.001 = 0.00115 -> 0.0012`, and the 5-decimal `cpv` case) fail under
binary floating point or currency-only rounding. SDK suites consume this file
to check their own resolvers.
