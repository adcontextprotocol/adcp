# Price adjustment resolution vectors

These vectors pin the deterministic resolution rule for `price_adjustments` on
a binding fixed-price pricing option:

1. Two row kinds. **Index** rows (`kind: index`, `factor`) multiply and compound
   in declared order; **premium** rows (`kind: fee|discount`, `rate` or
   `amount`) add. `indexed price = base x product of firing factors`;
   `resolved price = indexed price + premium deltas`.
2. Premium `rate` rows are a percentage of the **indexed** price; premium
   `amount` rows are fixed and not indexed. Premiums never compound with each
   other, so their order does not matter.
3. Selection rows (`format_option`, `placement_selection`) fire at most once per
   dimension: the first applicable row in declared order. `always` rows each
   fire. Matching is full-identity equality after resolution.
4. `valid_from` (inclusive) / `valid_until` (exclusive) bound a row to a window
   evaluated at the purchase `start_time`. A flight that crosses a window
   boundary of a row that would otherwise apply is rejected with
   `INVALID_REQUEST`; a flight may end exactly on a `valid_until`.
5. Each index step applies `running +/- round(running x |factor - 1|)` and each
   premium rate delta is rounded the same way, half away from zero, to the
   option's price precision: the greatest of the currency minor-unit exponent,
   4 for `cpm`/`vcpm`/`cpc`/`cpcv`/`cpv`/`cpp`, and the fewest decimal places
   that exactly represent `fixed_price` and each amount, by numeric value.
   The resolved price is the exact sum and never falls below zero.
6. Omitted or default selections match no selection row and pay the base rate.
7. A buyer-supplied `pricing` that differs from the resolved result is rejected
   with `INVALID_REQUEST` carrying the resolved price and breakdown; a changed
   table requires a new `pricing_option_id`.
8. An accepted snapshot carries `base_fixed_price`, the resolved `fixed_price`,
   a `price_breakdown` of declared adjustments plus each fired row (an index as
   a fee or discount rate, a premium as its currency amount), and the retained
   table, so a verifier can re-resolve it.

The `dutch_tv_*` cases are a fictional linear TV rate card: a net base price
multiplied by month, market, spot-length and target-audience indices, plus a
first-in-break premium. Resolvers MUST use exact decimal or integer arithmetic;
the tie cases fail under binary floating point or currency-only rounding. SDK
suites consume this file to check their own resolvers.
