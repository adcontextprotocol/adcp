---
---

Fix MCP OAuth authentication by replacing the proxy-based OAuth provider with a broker that handles client registration and PKCE locally while delegating user authentication to AuthKit.
