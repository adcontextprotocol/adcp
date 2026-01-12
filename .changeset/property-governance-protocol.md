---
"adcontextprotocol": minor
---

Add Property Governance Protocol support to get_products

- Add optional `property_list` parameter to get_products request for filtering products by property list
- Add `property_list_applied` response field to indicate whether filtering was applied
- Enables buyers to pass property lists from governance agents to sales agents for compliant inventory discovery
