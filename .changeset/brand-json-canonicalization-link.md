---
"adcontextprotocol": patch
---

**Apply the AdCP URL canonicalization rule to brand.json agent URLs.**

Follow-up to #3067 — the canonicalization reference page now exists,
and `seller-agent-ref`, `adagents.json` `authorized_agents[].url`,
`format-id`, and `provider-registration` all link to it. `brand.json`
declares additional agent URLs that fall in the same identifier-
comparison class but weren't covered:

- `brand_agent_entry.url` — the brand-declared agent endpoint (MCP or
  A2A) used by callers resolving "is this the agent that signed this
  artifact?" or matching against a discovery cache.
- `brand_agent.url` — the brand agent MCP endpoint reference.
- `rights_agent.url` — the rights agent MCP endpoint reference.

All three now reference the AdCP URL canonicalization rules at
`docs/reference/url-canonicalization` so two URLs differing only in
case, default port, or percent-encoded unreserved characters compare
equal during agent resolution.

`logo.url`, `data_subject_contestation.url`, asset-library `url`, and
the brand's primary `url` are *not* identifier-comparison keys (they
point at human-facing pages or asset CDN endpoints), so they were
left unchanged.

`jwks_uri` (line 627) is a fetch target for JWKS download, not an
identifier-comparison key — receivers HTTP-GET the URL as declared
without comparing it to anything. Not in scope for this rule.

No schema shape changes. Descriptions only.
