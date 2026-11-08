---
"adcontextprotocol": minor
---

Reporting (experimental): revocation means no access. `sync_reporting_receipts` and `sync_reporting_status` no longer accept receipts and statuses after the caller loses authority for an account. Before, they stayed open for `status_retention_days` for revisions the caller had read. Once authority ends, every reference to the account, receipts included, resolves like an unknown identifier, so a seller responding to fraud or a compromised agent stops everything at once.

A seller that wants a buyer to finish reconciling after a relationship ends, for example after an agency-of-record change, keeps a reduced grant instead of revoking: an `authorization` whose `allowed_tasks` lists only the reconciliation tasks it permits (such as `get_reporting_status`, `sync_reporting_receipts`, and `sync_reporting_status`), with `read_only: false`. The account stays in reporting-subscription coverage while that grant lists `get_reporting_status`, so the buyer keeps receiving final revisions and adjustments for its buys.
