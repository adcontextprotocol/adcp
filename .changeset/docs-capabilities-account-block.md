---
"adcontextprotocol": patch
---

Docs: add the now-required `account.supported_billing` block to the four
`get_adcp_capabilities` example JSON blocks that declare `media_buy`
support.

Since #3750 (`fix(schema): make account.supported_billing conditional on
media_buy protocol`), the response schema requires `account.supported_billing`
whenever `supported_protocols` contains `media_buy`. Four illustrative
examples in the docs (`creative/sales-agent-creative-capabilities.mdx`,
`media-buy/specification.mdx`, `reference/migration/channels.mdx`,
`reference/migration/geo-targeting.mdx`) were not updated alongside the
schema and have been failing CI's schema validation step on `3.0.x` HEAD,
blocking every other patch PR against the branch.

Each example now includes `"account": { "supported_billing": ["operator",
"agent"] }`, matching the pattern already used in
`docs/building/integration/accounts-and-agents.mdx`. Documentation only —
no protocol behavior change.
