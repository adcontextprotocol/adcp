---
"adcontextprotocol": patch
---

spec(capabilities): relax `identity.additionalProperties` to `true` on `get-adcp-capabilities-response`

Forward-compat fix for 3.0.x. The `identity` object was schema-closed (`additionalProperties: false`), so any operator that adopted a forward-compatible field — notably `identity.brand_json_url` from #3690, which was always intended to be readable by 3.0-pinned implementers without a schema bump — would have its capabilities response rejected by strict 3.0 validators (e.g., `@adcp/sdk`'s `createAdcpServer` default).

Mirrors the `additionalProperties: true` already shipped on `main` post-#3690. Strictly additive: the closed property list (`per_principal_key_isolation`, `key_origins`, `compromise_notification`) is unchanged; receivers that ignore unknown fields keep working; receivers that look for new identity fields gain forward-compat without waiting for a 3.x bump.

The forward-compat narrative in `security.mdx` ("3.0-pinned implementers can adopt the field today without bumping") depends on this relaxation being live in shipped schemas — without it, the spec advice contradicts the schema.
