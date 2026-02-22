---
"adcontextprotocol": minor
---

Add `buying_mode` field to `get_products` request for explicit wholesale buying intent.

Buyers with their own audience stacks (DMPs, CDPs, AXE integrations) can now set `buying_mode: "wholesale"` to declare they want raw inventory without publisher curation. Previously, omitting the `brief` was ambiguous — it could mean wholesale intent, early exploration, or a forgotten brief.

When `buying_mode` is `"wholesale"`:
- Publisher returns products supporting buyer-directed targeting
- No AI curation or personalization is applied
- No proposals are returned
- `brief` must not be provided (mutually exclusive)
