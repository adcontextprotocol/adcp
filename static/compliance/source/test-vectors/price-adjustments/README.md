# Price adjustment resolution vectors

These vectors pin the deterministic resolution rule for `price_adjustments` on
a binding fixed-price pricing option:

1. Matching is full-identity equality after resolution. Different encodings of
   one placement match; the same format option ID under a different `scope`
   does not.
2. At most one row fires per dimension: the first matching row in declared
   order. A multi-value selection never fires one row once per value.
3. Firing rows apply in declared array order to a running total that starts at
   `fixed_price` (the base rate, already net of the option's own declared
   breakdown). Rate rows apply to the running total at their position
   (`10% + 10%` multiplies by `1.21`), so order is observable.
4. After every row the total is rounded half away from zero to the option's
   price precision: the greater of the currency minor-unit precision and the
   most decimal places among `fixed_price` and row amounts. The total never
   falls below zero; such a purchase is rejected, never clamped.
5. Omitted or default selections match no row and pay the base rate.
6. A buyer-supplied `pricing` that differs from the resolved result is
   rejected with `INVALID_REQUEST`; a changed table requires a new
   `pricing_option_id`.
7. An accepted snapshot carries `base_fixed_price`, the resolved `fixed_price`,
   a `price_breakdown` of declared adjustments plus fired rows, and the
   retained table, so a verifier can re-resolve it.

Resolvers MUST use exact decimal or integer arithmetic. The
`rounds_half_away_from_zero_per_step` case (`1.15 x 1.10 = 1.265 -> 1.27`) and
the sub-cent `cpv` case fail under binary floating point or currency-only
rounding. SDK suites consume this file to check their own resolvers.
