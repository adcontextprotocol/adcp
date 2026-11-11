---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): `subscription_coverage.excluded[]` entries gain an optional `offering_id`, matching `gaps[]` and `timezone_cutovers[]`. When an account's covered offerings have different period boundaries, the seller lists one exception per offering, each with that offering's cutover instants. An entry without `offering_id` still applies to every offering. Before, an exception's `from` had to be one account-wide instant even when offerings cut over at different boundaries.
