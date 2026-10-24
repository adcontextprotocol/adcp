---
"adcontextprotocol": minor
---

Demand-side grants in trust.json (#6033, DR-0025, agent identity P5).

`L2/accounts-and-agents.mdx` §Grants in trust records is the normative home for how a seller evaluates acts-for authority, at `sync_accounts` and on the freshness schedule.

**When no grant covers the claim,** the request fails with `PERMISSION_DENIED` and the new `error-details/agent-permission-denied.json` reason `grant_absent`.

The trust.json `grant` description now points to the L2 rules, `brands` on a grantee's own grant uses the brand IDs it received, and `valid_until` and `exclusive_grants` are no longer marked unenforced. The `exclusive_grants` description no longer carries a fetch-failure rule; the L2 section points to the outage rules for that. `PERMISSION_DENIED` and `agent-permission-denied.json` now describe per-agent gates generally, covering both provisioning constraints and missing grants.

A grant's `grantee` MUST be a registrable domain under the pinned Public Suffix List snapshot. A grant whose `grantee` is not one covers no claim, and its `scopes` still count for `exclusive_grants`. The schema keeps `$ref: #/definitions/domain`, because a pattern can't evaluate the PSL; the `grantee` description states the rule.
