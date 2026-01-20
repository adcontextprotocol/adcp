---
"adcontextprotocol": patch
---

Fix API response parsing in Addie member tools

Multiple MCP tool handlers were incorrectly parsing API responses, expecting flat arrays/objects when APIs return wrapped responses. Fixed:
- `list_working_groups`: Extract `working_groups` from `{ working_groups: [...] }`
- `get_working_group`: Extract `working_group` from `{ working_group: {...}, is_member }`
- `get_my_working_groups`: Extract `working_groups` from wrapped response
- `get_my_profile`: Extract `profile` from `{ profile, organization_id, organization_name }`
