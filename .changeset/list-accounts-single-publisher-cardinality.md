---
---

docs(accounts): clarify that single-publisher sellers may return a single
`list_accounts` account without a pagination envelope.

The canonical `list-accounts-response.json` example already shows this shape.
This documentation update makes the conformance expectation explicit: pagination
walk checks are not applicable when pagination is absent, or when
`pagination.total_count` is present and no more than one.
