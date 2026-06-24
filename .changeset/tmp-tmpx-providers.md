---
"adcontextprotocol": minor
---

TMP: introduce `tmpx_providers` on IdentityMatchResponse so the router preserves per-provider TMPX attribution across fan-out. The router collects one TMPX token per identity provider that emitted one and exposes them as a `provider_id` → token map; the publisher fires each through a per-provider `{TMPX_<provider_id>}`-style macro. The legacy single-token `tmpx` field is deprecated (still emitted by routers as a transitional convenience for consumers that haven't migrated; removed in 4.0). Router-architecture.mdx §"Identity Match fan-out" gains a normative `TMPX collection` paragraph that MUSTs the map on multi-provider fan-outs and forbids collapsing per-provider tokens into a single string. Schema `tmp/identity-match-response.json` adds the new field; the IdentityMatchResponse field table and the inventory-specific behavior section in specification.mdx surface the new shape for publishers.
