---
"adcontextprotocol": minor
---

Add URL reference support to adagents.json for CDN distribution and multi-domain publishers.

Publishers can now choose between two file structures:
1. Inline structure (existing) - full configuration in place
2. URL reference (new) - points to authoritative location

**Features:**
- Schema supports both inline and URL reference variants via discriminated union
- AdAgentsManager validates references and fetches authoritative files
- Prevents infinite loops via nested reference detection
- Requires HTTPS for security
- UI toggle in AdAgents Manager to create either file type

**Use cases:**
- CDN distribution for better performance
- Centralized management across multiple domains
- Dynamic updates without touching domain files
