---
"adcontextprotocol": minor
---

feat(aao-directory): add `?include=properties` to agent-publishers endpoint

Adds an opt-in `?include=properties` query parameter to
`GET /v1/agents/{agent_url}/publishers`. When set, each `PublisherEntry`
carries a `property_ids: array[string]` field — the canonical list of
property IDs the agent's selectors resolve to under that publisher.

This unblocks full set-diff divergence detection in SDK clients.
Count-equality is not set-equality: a publisher rotating three properties
leaves `properties_authorized` unchanged while the entire authorized set
changes. `property_ids` gives SDK divergence detectors the data they need
to catch this class of silent drift.

Non-breaking: default off, existing response envelope unchanged.
