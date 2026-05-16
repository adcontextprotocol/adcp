---
---

fix(adagents): accept property-level publisher_domain in managerdomain scope gate

The explicit-publisher-scoping gate from #4173 only inspected per-agent
paths (`authorized_agents[].publisher_properties[].publisher_domain` and
`authorized_agents[].collections[].publisher_domain`). Probing real
production manifests after #4251 landed showed every managed-network
manager rejects under the gate — Mediavine, the only manager currently
serving an adagents.json against a publisher with a managerdomain
pointer (`homestratosphere.com → mediavine.com`), uses property-level
scoping with tag-based agent references:

```json
"properties": [{ "publisher_domain": "thehollywoodgossip.com",
                 "tags": ["scope3-aee"] }],
"authorized_agents": [{ "authorization_type": "property_tags",
                        "property_tags": ["scope3-aee"] }]
```

The cross-publisher commitment is expressly declared — just routed
through the property layer rather than re-spelled per-agent.

Gate now accepts either shape:

- Per-agent paths (existing): `publisher_properties[].publisher_domain`
  or `collections[].publisher_domain` directly names the publisher.
- Property-level paths (new): a `properties[]` entry carries
  `publisher_domain` matching the source, AND at least one
  `authorized_agents[]` entry references that property indirectly via
  `property_ids` or `property_tags`.

Cross-publisher confusion attacks still fail closed — a property
belonging to a different publisher can't satisfy the gate, and an agent
referencing a tag none of the publisher's properties carry can't
satisfy it either.

Tests added for: property_tags + property-level publisher_domain
(Mediavine pattern), property_ids + property-level publisher_domain,
foreign-property rejection, no-matching-tag rejection.
