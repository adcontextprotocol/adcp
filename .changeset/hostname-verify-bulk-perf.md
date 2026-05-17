---
---

Refactor `verifyAgentHostname` into a two-call shape so bulk callers (bulk PUT `/api/me/member-profile`, POST create) issue one query for the verified-domain list and then run a pure in-memory check per agent — N agents now cost one round-trip instead of N. `getVerifiedOrgDomains(orgId)` fetches; `checkAgentHostnameAgainstDomains(url, domains, orgId?)` is pure. `verifyAgentHostname` remains as a single-agent convenience wrapper for unchanged call sites (REST POST, `save_agent` MCP, visibility flip). Closes #4673.
