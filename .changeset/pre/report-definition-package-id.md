---
"adcontextprotocol": minor
---

spec(reporting): report definitions at contract_version 1.2 require a package_id dimension on media-buy reporting (experimental, #8971).

Reliable Reporting (`media_buy.reporting_delivery`, experimental) adds report-definition `contract_version` `1.2` in `core/reporting-report-definition.json`. A `1.2` definition keeps every `1.1` rule, including `restatement_policy.official_correction_mode`. When its `dimensions` include `media_buy_id`, they MUST also include `package_id`, so every row carries the buyer-visible package. A definition without `media_buy_id`, whose rows aggregate across media buys (an account-level summary, for example), is exempt at every version. Definitions at `1.0` and `1.1` keep validating unchanged; a grader SHOULD report one that includes `media_buy_id` but not `package_id` as an advisory finding.

The version is declared in the definition and pinned by the offering's `report_definition_uri` and SHA-256, as for `1.1`, so no capability or request field changes. Callers pinned below 3.3 accept only `1.0` and `1.1`, so a seller MUST serve them offerings whose definitions are `1.0` or `1.1`; a strict validator built from 3.2 rejects a `1.2` definition, which is acceptable for an experimental surface. At `1.2`, media-buy-scoped rows MUST name the dimension `media_buy_id`, and the offering's `reporting_profile.primary_keys` MUST include `package_id`. The dimension is named `package_id`, matching `media_buy_id`; reporting subscription selectors and `standard_dimensions` keep calling the breakdown `package` (`enums/reporting-dimension.json`).

New compliance vectors in `test-vectors/reporting-report-definition/` include a `1.2` fixture with `["date", "media_buy_id", "package_id"]` and a negative vector for a `1.2` media-buy definition without `package_id`. The `reporting-reconciliation` reference fixture and its digests are unchanged at `1.1`.
