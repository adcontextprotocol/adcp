---
"adcontextprotocol": patch
---

Remove deprecated schema files no longer part of v3 schema design:
- `creative-formats-v1.json` - replaced by modular format schemas in `source/core/`
- `standard-format-ids.json` - enum no longer used in current schema structure
- Cleaned up `index.json` registry (removed stale changelog and version fields)
