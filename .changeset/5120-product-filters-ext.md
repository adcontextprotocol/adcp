---
"adcontextprotocol": minor
---

Add optional `ext` fields to discovery filters for vendor-namespaced,
seller-specific criteria.

This closes the schema gap surfaced by adcp-go#277 and tracked for follow-up
in adcp-go#279: `product-filters.json` already allowed extension keys via
`additionalProperties: true`, but did not expose the protocol-standard `ext`
slot. The same request-side filter pattern applied to creative and signal
discovery filters. Existing wire payloads remain compatible, while generated
SDKs can now surface discoverable extension objects.
