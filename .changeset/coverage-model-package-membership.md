---
"adcontextprotocol": patch
---

Reporting subscriptions (experimental): fix the coverage reference model and vectors for two cases both SDKs already compute from the spec text (#8678).

- A `package_ids` exclusion that names every package of a buy resolving an offering removes that buy's periods for the offering from `from`. Before, the model ignored every `package_ids` entry. Naming only some resolving packages still leaves the buy covered. `core/reporting-subscription-coverage.json` says so explicitly.
- An account removed from a subscription in place keeps its pre-removal periods: the readback configuration no longer names it, but its `excluded_by_buyer` entry keeps it in that version's scope and removes periods from E. Before, the model dropped every period. `core/reporting-subscription.json` `membership` says so explicitly.
- Three vectors cover these: `package-exclusion-names-every-resolving-package`, `package-exclusion-names-some-resolving-packages`, and `membership-removal-keeps-earlier-periods`.
- `error-codes.json`: `COVERAGE_INPUT_INCOMPLETE` and `COVERAGE_INPUT_INVALID` are raised only when computing the owed set reads the value, and the doc says which values each rule reads. For example, a `timezone_cutovers` entry is read whenever an `account_timezone` offering resolves.
