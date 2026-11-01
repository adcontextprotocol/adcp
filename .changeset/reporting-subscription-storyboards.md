---
"adcontextprotocol": patch
---

Compliance (experimental, `media_buy.reporting_subscriptions`): two storyboards exercise principal-level reporting subscriptions over the `reporting_subscription_probe` sandbox clock, and the runner contract gains the `owed_periods_match` check.

- `media_buy_seller/reporting_subscription_coverage` drives one subscription through several periods, a version cutover from hourly UTC to daily account-timezone periods (misaligned boundaries), deactivation and reactivation, a wind-down grant (`SCOPE_INSUFFICIENT` for a dropped task), revocation with a re-grant inside and after `status_retention_days`, and an account timezone change across the November DST transition.
- `media_buy_seller/reporting_subscription_capacity` checks sticky admission under `max_accounts`: a waiting account's `capacity` exception, `accounts_with_exceptions`, and admission when an earlier account leaves coverage.
- `owed_periods_match` compares the periods a subscription owes, computed by the runner from wire state alone (`get_principal`, `list_accounts`, `get_media_buys`, `get_adcp_capabilities`, and the response's `subscription_coverage`), with the seller's obligations in the `get_reporting_status` periods view. The storyboards declare it advisory until a released runner implements it; unknown checks already grade not_applicable.
- The reference model (`scripts/reference/reporting-coverage/coverage.cjs`) also exports its package selection rule, `resolvePackage`, so a seller can resolve offerings with the same rule the vectors pin.
