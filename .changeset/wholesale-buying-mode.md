---
"adcontextprotocol": major
---

Add required `buying_mode` discriminator to `get_products` request for explicit wholesale vs curated buying intent.

Buyers with their own audience stacks (DMPs, CDPs, AXE integrations) can now set `buying_mode: "wholesale"` to declare they want raw inventory without publisher curation. Buyers using curated discovery set `buying_mode: "brief"` and include `brief`. This removes ambiguity from legacy requests that omitted `buying_mode`.

When `buying_mode` is `"wholesale"`:
- Publisher returns products supporting buyer-directed targeting
- No AI curation or personalization is applied
- No proposals are returned
- `brief` must not be provided (mutually exclusive)
