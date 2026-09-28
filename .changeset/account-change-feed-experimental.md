---
"adcontextprotocol": patch
---

Mark the AdCP 3.2 account change feed experimental (feature id `account.change_feed`) while RFC #6810 remains open. `list_account_changes` request/response, the `account.change_recorded` webhook payload, and the `account.change_feed` capability block now carry `x-status: experimental`; the `account.change_recorded` notification type and `CURSOR_EXPIRED` error code descriptions name the feature id. `docs/reference/experimental-status` registers `account.change_feed`, and the task page replaces the "not normative until ratified" warning with the standard experimental callout: sellers implementing the feed MUST list `account.change_feed` in `experimental_features`, and the surface may change in 3.x minors with at least 6 weeks' notice. Annotation and documentation only; no wire shape changes.
