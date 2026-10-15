---
"adcontextprotocol": minor
---

Demand-side grants in trust.json (#6033, DR-0025, agent identity P5).

**How a seller evaluates acts-for authority,** at `sync_accounts` and on the freshness schedule. `L2/accounts-and-agents.mdx` §Grants in trust.json is the normative home for these rules:
- the brand's house record authorizes (the house named in the brand's brand.json, otherwise the brand's domain);
- domains compare as registrable domains, and authority is implicit when the operator is the brand;
- otherwise a grant chain with `account.operator` on it must reach the signer's operator with a covering scope, in one of three forms;
- `agents[]` narrows the link that reaches the signer;
- every link covers the account's brand, countries, scope, and time window, and effective authority is their intersection;
- `exclusive_grants` opts a grantor in to fail-closed, and a fetch failure is never absence;
- a 200 from trust.json disables brand.json `authorized_operators[]`, which stays valid only for a house that has never published a trust.json.

**When no grant covers the claim,** the request fails with `PERMISSION_DENIED` and the new `error-details/agent-permission-denied.json` reason `grant_absent`. This is a request-level failure that never creates an account or changes its status. A withdrawn grant ends the agent's access, not the account.

The trust.json `grant` description now points to the L2 rules, `brands` on a grantee's own grant uses the brand IDs it received, and `valid_until` and `exclusive_grants` are no longer marked unenforced. `PERMISSION_DENIED` and `agent-permission-denied.json` now describe per-agent gates generally, covering both provisioning constraints and missing grants.
