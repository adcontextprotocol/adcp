---
---

feat(addie): server-side Addie Socket Mode — outbound WebSocket conformance channel that lets adopter dev/staging MCP servers connect to Addie. Adds JWT-issuance route at POST /api/conformance/token and WS upgrade handler at /conformance/connect, with an in-memory session store keyed by WorkOS org. Prototype adopter at examples/conformance-client/. Storyboard runner integration is PR #2; Addie chat tools are PR #3 (feature-flagged). See adcontextprotocol/adcp#3991.
