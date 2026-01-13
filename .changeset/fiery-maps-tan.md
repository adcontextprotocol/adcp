---
---

Add call_adcp_agent tool and Claude Skills for full AdCP protocol access.

This enables clients to execute the full AdCP spec (not just testing API) via:
- `call_adcp_agent` tool: Low-level proxy to any AdCP-compliant sales agent
- Claude Skills: Protocol knowledge for media-buy, signals, and creative

Skills teach Claude the protocol schemas and workflows; the tool routes to
whatever agent the user specifies. Auth tokens are looked up from saved
agent context or can be provided directly.
