---
"adcontextprotocol": minor
---

Add optional `custody` to the Reliable Reporting report definition `source`, backed by the new `enums/reporting-custody.json` (`system_of_record` or `upstream_derived`). It says whether the producer's own platform recorded the delivery or the producer derived the figures from the upstream provider and system named in `source`, so a buyer can read "derived from upstream X, final by contractual cutoff" alongside `finality_basis`. The value is fixed per definition by `report_definition_sha256`, so there is no per-revision field, and adding an optional field changes no existing definition digest. Adding `custody` to an existing definition changes its bytes, so a seller publishes it as a new definition version with a new digest, and does not emit it toward consumers that have not adopted the 3.3 schema because `source` is closed. Additive within the experimental `media_buy.reporting_delivery` surface. Closes #8185.
