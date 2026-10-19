---
"adcontextprotocol": patch
---

Document that the AAO directory inverse-lookup (`GET /v1/agents/{agent_url}/publishers`) matches `agent_url` spec-exactly, with a non-root trailing slash significant. The directory previously folded `/mcp` and `/mcp/` together and answered both with the slashless agent's publishers, which could report an authorization the publisher's adagents.json does not grant.
