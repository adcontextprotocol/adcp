---
"adcontextprotocol": minor
---

Reporting subscriptions (experimental): the wire now carries everything a buyer needs to compute owed periods without asking.

- `authorization.regranted_at`: the latest re-grant within the current authorization chain. Withheld periods are due at it plus `delivery_sla`, and unbackfilled gaps end at the first boundary at or after it.
- `flight_history` on media buys (`core/media-buy.json`, `get_media_buys`): every retroactive flight edit, with the `start_time` and `stop_time` in force before it, retained while the buy's obligations are. Retroactive edits stay allowed. A buyer reads the flight in force at any `scope_resolved_at` from the wire.
- `packages[].reporting_delivery_offering_ids` on `get_media_buys`: the package's offering set, fixed at confirmation, so selection resolves per package.
- `available_from` and `withdrawn_at` on reporting delivery offerings. Withdrawal is a resolution change at `withdrawn_at`, and a withdrawn offering stays in the catalog while obligations that resolved it are retained.
- Clarifications: `delivery_config_generations[].offering_id` for subscription versions resolving several offerings; `offering_id` joins the consumer-status chain identity; `next_expected_at` counts only periods the coverage rule owes; a period's owed set is final once its end is before `ledger_as_of`.
- The coverage vectors now use only wire inputs. Cases carry the buy's `flight_history` in place of the buyer-retained `prior_flights`, offerings carry `available_from` and `withdrawn_at` as published, `non_wire_inputs` is gone, and the vector test validates both against the AdCP schemas.
