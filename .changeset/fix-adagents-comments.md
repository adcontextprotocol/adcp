---
"adcontextprotocol": patch
---

Fix outdated documentation references in adagents.json

Updated schema descriptions and documentation to remove outdated references to `list_authorized_properties` response structure. The `properties` and `tags` fields in adagents.json are canonical property definitions, not reflections of the task response (which was simplified in v2.3.0 to only return `publisher_domains`).

**Schema changes:**
- Updated `properties` field description to emphasize it defines the canonical property list
- Updated `tags` field description to clarify it provides metadata for property grouping

**Documentation changes:**
- Simplified adagents.json documentation to focus purely on JSON specification
- Removed implementation examples (validation, caching, error handling)
- Clarified that tags are for efficiency/grouping at scale, not just human-readable metadata
- Kept clear examples of all four authorization patterns
