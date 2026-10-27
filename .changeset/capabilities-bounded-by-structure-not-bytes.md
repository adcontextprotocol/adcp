---
"adcontextprotocol": minor
---

Bound the `get_adcp_capabilities` response by structure only, and drop the 64 KiB byte cap as a rule on it (#8198). The `maxItems`, `maxLength`, and `maxProperties` limits and their `x-max-*-4.0` annotations are the protocol's limit on the document, and AdCP sets no byte limit on it. A client can still apply its own transport limit, as any HTTP client does; that is the client's choice, not a protocol rule. `MAX_CAPABILITIES_BYTES` (64 KiB) stays only as the fetch budget of step 1 in the deprecated RFC 9421 key-discovery chain, which is unchanged through 3.x and removed in 4.0. The per-field budgets on the two counterparty-asserted lists (8,192 bytes each, 16,384 together) are unchanged and now stated as absolute values. The 4.0 follow-up for the 87 MiB structural worst case is tighter structural bounds on the nested lists, not a byte cap. This removes a limit and makes no schema change.
