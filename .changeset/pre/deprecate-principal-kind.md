---
"adcontextprotocol": minor
---

Clarify that a principal is the buyer agent as the seller has bound it, and nothing else, in the glossary, the principal task pages, and the buyer agent setup walkthrough. Deprecate `principal_kind` on `get_principal` and `sync_principal` responses, `expected_principal_kind` on `sync_principal` requests, and the `enums/principal-kind.json` enum (`deprecated: true`, `x-deprecated-in: 3.3.0`): a bound buyer agent is always `buyer_agent`. Both keep working throughout 3.x. The task names do not change. See the 3.2 to 3.3 migration guide, Deprecations (#8280).
