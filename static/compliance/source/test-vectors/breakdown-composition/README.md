# Composed delivery breakdown vectors

Vectors for `get_media_buy_delivery` `breakdown_composition` and
`by_package[].by_composition`. Each file is self-describing and executed by
`tests/breakdown-composition-contract.test.cjs`.

- `positive/`: a seller response (or request) that MUST validate, with an
  `expected` object. A response is either one `by_package` entry or `pages`, the
  pages of one cursor walk. `marginals_reconcile` is `true` when every additive
  metric summed over the rows of a completed walk equals the package totals and
  each composed dimension's marginal `by_*` array, and `not_applicable` for a
  partial walk or when any page sets `suppressed`.
- `negative/`: a request the seller MUST reject. `expected_outcome` is either
  `{ "success": false, "error_code": "..." }` for a seller-side rejection given
  the declared `reporting_capabilities`, or `{ "schema_valid": false }` for a
  payload no conformant request or response schema accepts.

Only count and currency metrics are summed (`impressions`, `spend`, `clicks`).
Rates, ratios, and unique counts are never summed across cells.
