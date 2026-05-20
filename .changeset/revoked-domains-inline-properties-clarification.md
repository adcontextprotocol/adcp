---
"adcontextprotocol": patch
---

Clarify that `revoked_publisher_domains[]` applies to all three authorization-type branches — including `inline_properties`. The schema description and managed-networks.mdx validator-behavior bullet previously enumerated only two of three branches (`publisher_properties` selectors and top-level `properties[].publisher_domain`), leaving `authorized_agents[].properties[].publisher_domain` (the `inline_properties` authorization type) ambiguous. Added `inline_properties` to both enumerations to unblock SDK implementations holding the third branch pending this clarification. Closes #4869.
