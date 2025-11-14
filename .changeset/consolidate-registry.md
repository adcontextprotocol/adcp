---
"adcontextprotocol": minor
---

Consolidate agent registry into main repository and unify server architecture.

**Breaking Changes:**
- Agent registry moved from separate repository into `/registry` directory
- Unified Express server now serves homepage, registry UI, schemas, and API endpoints
- Updated server dependencies and structure

**New Features:**
- Single unified server for all AdCP services (homepage, registry, schemas, API, MCP)
- Updated homepage with working documentation links
- Slack community navigation link
- Applied 4dvertible → Advertible Inc rebranding (registry PR #8)

**Documentation:**
- Consolidated UNIFIED-SERVER.md, CONSOLIDATION.md, and REGISTRY.md content into main README
- Updated repository structure documentation
- Added Docker deployment instructions
