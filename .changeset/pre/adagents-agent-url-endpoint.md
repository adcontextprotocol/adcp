---
"adcontextprotocol": patch
---

Clarify that `authorized_agents[].url` in `adagents.json` is the agent's full protocol endpoint URL, including the path (for example `https://agent.example.com/mcp`), not the agent's origin. A new "Agent URL matching" section says which URL differences canonicalization ignores and which it keeps (trailing slash, path case, scheme, query). It also says to list one entry for each agent URL when MCP and A2A are served at different paths.
