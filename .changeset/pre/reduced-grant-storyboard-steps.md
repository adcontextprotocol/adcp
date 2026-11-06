---
"adcontextprotocol": patch
---

Compliance (experimental, `media_buy.reporting_subscriptions`): `media_buy_seller/reporting_subscription_coverage` now checks the beta.4 reduced-grant rule. It reduces the grant to tasks without `get_reporting_status` through the probe's `reduce_grant` and checks that the subscription lists the account in `accounts_unauthorized[]` with `unauthorized_at` equal to the reduction's `simulated_now`, and that `get_reporting_status` refuses the account with `SCOPE_INSUFFICIENT`. It then adds `get_reporting_status` back and checks that the restoration is a re-grant that continues the chain (`authorized_at` unchanged, `regranted_at` set), that the account leaves `accounts_unauthorized[]`, and that it is covered again. The wind-down phase also checks that a reduced grant that keeps `get_reporting_status` lists nothing under `accounts_unauthorized[]`.

The `reduce_grant` row of the `reporting_subscription_probe` table in the controller docs now states the rule, and the `get_reporting_status`, `sync_principal`, `sync_reporting_receipts`, and `sync_reporting_status` pages limit "treated as an unknown account" to revocation. After a reduction, `get_reporting_status` refuses the account with `SCOPE_INSUFFICIENT`.
