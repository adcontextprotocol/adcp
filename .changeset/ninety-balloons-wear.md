---
---

Add schema tools to knowledge tool set for proper routing. Schema validation tools (validate_json, get_schema, list_schemas, compare_schema_versions) were registered globally but not included in any tool set, so Haiku couldn't route schema-related questions to them.
