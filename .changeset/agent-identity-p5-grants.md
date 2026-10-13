---
"adcontextprotocol": minor
---

Demand-side grants in trust.json (#6033, DR-0025, agent identity P5).

**How a seller evaluates acts-for authority at `sync_accounts`:**
- it reads the brand's own trust.json `grants[]`;
- authority is implicit when the operator is the brand;
- otherwise a grant chain must reach the signer's operator with a covering scope, with `account.operator` on the chain: either the brand grants it directly, or the brand grants `account.operator`, whose own grant reaches the signer's operator;
- effective authority is the intersection along the chain;
- `exclusive_grants` opts a grantor in to fail-closed, and a fetch failure is never absence;
- a 200 from trust.json disables brand.json `authorized_operators[]`.

**When no grant covers the claim,** the request fails with `PERMISSION_DENIED` and the new `error-details/agent-permission-denied.json` reason `grant_absent`. This is a request-level failure that never creates an account or changes its status. A withdrawn grant ends the agent's access, not the account.

The trust.json `grant` description now permits a grantee's own single grant to an intermediary, and `valid_until` and `exclusive_grants` are no longer marked unenforced.
