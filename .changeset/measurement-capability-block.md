---
"adcontextprotocol": minor
---

Add `measurement` capability block to `get_adcp_capabilities` and
optional `metric_categories[]` to `brand.json` measurement-agent
entries. Closes #3612 (the protocol surface piece of the per-metric
catalog discovery design from #3586). Unblocks #3613 (AAO crawler +
index implementation).

**Why and how it parallels other agents.** Every AdCP agent type
self-describes its capabilities at the agent itself via
`get_adcp_capabilities` (sales / creative / governance / brand /
buying / signals). Measurement now follows the same pattern with a
new `measurement` block whose `metrics[]` array carries the per-metric
catalog (id, category, standard reference, unit, description,
documentation URL). No outlier — measurement is the same shape as
every other agent type.

**Optional `metric_categories[]` on brand.json** parallels rights
agents' `available_uses[]` / `right_types[]` — the one precedent in
AdCP for putting *coarse-filter* metadata on `brand.json` for cheap
directory queries. AAO can pre-filter measurement agents by category
without crawling each one. The full catalog stays at the agent
(canonical); brand.json carries only the category list.

**Schema additions.**

- `enums/measurement-category.json`: closed enum (`attention`,
  `brand_lift`, `incrementality`, `audience`, `reach`,
  `creative_quality`, `emissions`, `outcomes`, `other`).
- `protocol/get-adcp-capabilities-response.json`: new `measurement`
  block with `metrics[]` (`metric_id`, `category` required;
  `standard_reference`, `unit`, `description`, `documentation_url`
  optional). Adds `measurement` to `supported_protocols` enum.
- `brand.json` `brand_agent_entry`: optional `metric_categories[]`
  array referencing the new enum.

**Doc updates.**

- `docs/protocol/get_adcp_capabilities.mdx`: new `measurement` section
  with the field table, response example, and the
  discovery-vs-settlement framing (live agent call for currency, AAO
  index for cross-vendor speed).
- `docs/registry/index.mdx`: refines the measurement-vendor discovery
  section to reference the now-defined `measurement` capability block
  and forward-references the AAO index endpoint (#3613) and the
  buyer-agent direct-call docs (#3614).

**Backwards compatibility.** All additions are optional and additive.
Sellers without measurement capability are unchanged; sellers with
measurement capability gain a structured catalog surface.

**WG review.** This is the protocol surface for measurement-vendor
capability declaration. The hybrid design (live capability response +
optional brand.json coarse filter) was reached via #3586 and #3612
discussion; locking it here.

Closes #3612.
