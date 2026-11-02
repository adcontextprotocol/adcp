---
"adcontextprotocol": minor
---

Compliance (experimental): `comply_test_controller` adds the `reporting_subscription_probe` scenario for `media_buy.reporting_subscriptions`. Its operations are `revoke_grant`, `regrant`, `reduce_grant` (new `allowed_tasks` param), `set_account_timezone` (new `timezone` param), and `advance_time` (`target_time`). They act only on the caller's own grant on sandbox accounts and on one virtual clock, `simulated_now`. With them, storyboards can test coverage, `accounts_unauthorized`, gaps, withheld periods, wind-down grants, and timezone cutovers against a remote seller without waiting on wall-clock boundaries.
