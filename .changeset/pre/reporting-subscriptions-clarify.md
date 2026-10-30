---
"adcontextprotocol": minor
---

Settle the reporting-subscription ambiguities the TypeScript and Python SDK implementations hit. Each rule below is what both SDKs now compute.

- **Mapped dimensions on the wire.** Offerings gain experimental `standard_dimensions` (the breakdown in the standard vocabulary) and `unmapped_dimensions` (native dimensions with no mapping), so a buyer resolves `match` from the wire exactly as the seller does. Sellers advertising `media_buy.reporting_subscriptions` MUST publish `standard_dimensions` on every offering. The documented worst-case capabilities size moves to 91,804,421 bytes.
- **`match: exact` without `dimensions`.** Every candidate qualifies and the lowest `offering_id` wins.
- **`period_timezone`.** An `account_timezone` offering uses it in place of the account's zone. A `utc` offering matches only a UTC alias. A `source_timezone` or fixed `billing_cycle` offering matches only its own published zone. A buyer-configured `billing_cycle` offering never matches a subscription.
- **Period arithmetic.** Years, months, and days are civil time. Hours, minutes, and seconds are exact elapsed time, so `PT24H` differs from `P1D` across DST. Zero-length periods are never owed.
- **Cutovers across different offerings.** E is computed per incoming offering: a continuing offering hands off at its own boundary, and a new one starts at the latest outgoing end.
- **Authorization chains.** `authorized_at` is the start of the current authorization chain. A re-grant within `status_retention_days` continues the chain, so withheld periods stay owed; a later re-grant starts a new one.
- **Reactivation.** Turning an inactive subscription back on is a fresh start. The readback lists `inactive_intervals` so a buyer can recompute after losing local state.
- **`scope_resolved_at`.** For subscription obligations it is the period end.
- **Per-offering exceptions.** `gaps[]` and `timezone_cutovers[]` entries can carry `offering_id` when offerings' boundaries differ, and timezone cutovers carry `previous_timezone`.
