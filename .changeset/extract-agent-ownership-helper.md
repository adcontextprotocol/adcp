---
---

Closes #4377. Extracts the agent-ownership predicate into `server/src/services/agent-ownership.ts` so the two distinct semantic uses share one source. `findOwnerOrgForUser(userId, agentUrl)` (registry-api.ts pattern: "any owning org") and `isOrgOwnerOfAgent(orgId, userId, agentUrl)` (member-tools.ts pattern: "this specific org confirmed as owner") both call the same base JOIN with different constraints. Eliminates the inline JOIN copies that PR #4250's review flagged as a drift surface. 7 unit tests pin the semantics + null-on-error behavior.
