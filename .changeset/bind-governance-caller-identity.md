---
"adcontextprotocol": minor
---

Require governance agents to bind `check_governance.caller` to the agent URL
resolved from the authenticated transport credential. Restricted plans now
fail closed when that identity is unavailable or mismatched, preventing a
caller from claiming another agent's delegation or approved-seller authority.
