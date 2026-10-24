# Price adjustment resolution vectors

These vectors pin the deterministic resolution rule for `price_adjustments` on
a binding fixed-price pricing option. A table is optional: a fully priced offer
is an equally supported path, and its price applies only to what was quoted.

1. **One running total, declared order.** Starting at `fixed_price`, each
   firing row applies to the running total in the seller's declared order. A
   `rate` row adds (`fee`) or subtracts (`discount`) `round(running x rate)`; an
   `amount` row adds or subtracts its amount, and later rate rows apply to the
   total including it. A 10% fee then a 10% fee is x1.21, not x1.20.
2. **Index cards are rates.** There is no separate index row kind: a factor
   `f > 1` is a fee `rate` of `f - 1` and a factor `f < 1` is a discount `rate`
   of `1 - f`, applied in the same sequence. A fee `rate` may be 1 or more
   (factor 2.5 is a fee rate of 1.5).
3. Selection rows (`format_option`, `placement_selection`) fire at most once per
   dimension: the first applicable row in declared order. `always` rows each
   fire. Matching is full-identity equality after resolution.
4. `valid_from` (inclusive) / `valid_until` (exclusive) bound a row to a window
   evaluated at the purchase `start_time`. A flight that crosses a window
   boundary of a row that would otherwise apply is rejected with
   `INVALID_REQUEST`; a flight may end exactly on a `valid_until`.
5. Every delta rounds half away from zero to the option's price precision: the
   greatest of the currency minor-unit exponent, 4 for
   `cpm`/`vcpm`/`cpc`/`cpcv`/`cpv`/`cpp`, and the fewest decimal places that
   exactly represent `fixed_price` and each amount, by numeric value. The
   resolved price is the exact running total and never falls below zero.
6. Omitted or default selections match no selection row and pay the base rate.
7. A buyer-supplied `pricing` that differs from the resolved result is rejected
   with `INVALID_REQUEST` carrying the resolved price and breakdown; a changed
   table requires a new `pricing_option_id`.
8. An accepted snapshot carries `base_fixed_price`, the resolved `fixed_price`,
   a `price_breakdown` of declared adjustments plus each fired row in declared
   order (a rate below 1 as its rate, otherwise as its currency amount), and the
   retained table, so a verifier can re-resolve it.
9. **Quotes stay bound to their terms** (`quote_binding_cases`). A table applies
   only to the account it was returned for and expires with the quote: the
   proposal or offer `expires_at`, or the discovery response's validity.
10. **Accepted terms** (`accepted_terms_cases`). The accepted terms retain the
    table under `terms_digest`, so a change the agreement already permits is
    priced from it without a re-quote. The table grants no change right: a
    change not permitted by `change_terms[]` is `ACTION_NOT_ALLOWED` whatever
    the table says.

The `dutch_tv_*` cases are a fictional linear TV rate card: a net base price
multiplied by month, market, spot-length and target-audience indices (written as
fee and discount rates), plus a first-in-break premium. Resolvers MUST use exact
decimal or integer arithmetic; the tie cases fail under binary floating point or
currency-only rounding. SDK suites consume this file to check their own
resolvers.
