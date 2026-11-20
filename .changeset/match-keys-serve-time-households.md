---
"adcontextprotocol": patch
---

Match keys (experimental, `media_buy.match_keys`): add optional `scope_resolution` (`graph` or `serve_time`) to `core/match-key.json` so a seller that groups devices into households at request time, mostly from IP address and device signals, can say so instead of declaring a graph. `vendor` now names the party that forms the entity, not a supplier of input data. The compatibility rule adds a fourth condition: both keys declare the same `scope_resolution` (absent means `graph`), so a serve-time household is compatible only with keys from the party that formed it, in practice one seller or one platform. Absent keeps the current meaning; no shipped declaration changes. Docs: new "Households a seller forms at serve time" section in the media-buy specification.
