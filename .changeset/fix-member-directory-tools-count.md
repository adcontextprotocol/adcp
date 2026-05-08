---
---

Fix member directory agent detail modal showing "Tools: 0" by including tools_count and tools in the /api/public/discover-agent response. Tools are stripped to {name, description} before serialization; inputSchema is not exposed.
