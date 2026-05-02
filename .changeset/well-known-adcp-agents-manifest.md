---
"adcontextprotocol": minor
---

feat(spec): `/.well-known/adcp-agents.json` for multi-agent topology discovery (#3895)

Defines a new origin-scoped well-known endpoint that enumerates every AdCP agent served from a host — `agent_id`, `url`, `transport`, `specialisms[]`, and an optional informational `auth_hint`. Lets buyers and conformance runners learn an operator's full multi-agent topology in a single fetch instead of reading a Notion page or hardcoding tenant lists.

**Why.** Today a publisher running sales / signals / governance / creative / brand on one origin has no standard way to advertise the full set. `/.well-known/agent-card.json` describes one agent at a time; `/.well-known/adagents.json` covers authorization, not topology. The training agent demonstrated the gap with a custom `_training_agent_tenants` extension on `adagents.json` — useful but non-standard.

**What's in this PR**

- New schema: `static/schemas/source/adcp-agents.json`. Required: `version`, `agents[]` (each with `agent_id`, `url`, `transport`, `specialisms[]`). Optional: `agents[].auth_hint`, `agents[].description`, `contact`, `last_updated`. `transport` is an open string with documented common values (`"mcp"`, `"a2a"`) so future transports don't require a schema-breaking change. `agents[].url` is `https://`-only with explicit consumer rules for origin-binding and SSRF defence. `agents[]` capped at 256, `specialisms[]` at 64. `additionalProperties: true` elsewhere for forward compatibility.
- Schema registered in `static/schemas/source/index.json` next to `adagents` and `brand` with `file_location: "/.well-known/adcp-agents.json"`.
- New doc: `docs/protocol/multi-agent-discovery.mdx`. Covers shape, fields, `auth_hint` common values, relation to `agent-card.json` / `adagents.json` / `brand.json` / `oauth-authorization-server`, the discovery chain (linked into [Calling an agent](/docs/protocol/calling-an-agent#discovery-chain)), and a reconciliation table that names `adagents.json` as authoritative for "can this agent sell my inventory?" and the agent-card as authoritative when URL/transport disagree. Includes a Consumer Requirements section: HTTPS-only in production, blocking RFC 1918 / loopback / metadata addresses, origin-binding before sending credentials cross-origin, URL canonicalization before comparison, and a 1 MB body cap. Caching and error-semantics section covers missing-manifest fallback to single-agent, malformed-manifest non-blocking degradation, and `X-Forwarded-Host` cache-poisoning guidance. Wired into both navigations in `docs.json`.
- Reference implementation: training agent serves `/.well-known/adcp-agents.json` listing all six tenants (`sales`, `signals`, `governance`, `creative`, `creative-builder`, `brand`). The pre-existing `_training_agent_tenants` extension on `adagents.json` stays in place — it carries tenants that don't fit the `authorized_agents` discriminator (governance / creative / creative-builder / brand) — with its comment pointing at the standard endpoint.
- Smoke test added in `server/src/training-agent/tenants/tenant-smoke.test.ts` verifying the manifest enumerates every tenant with the right key/URL/transport.

**`auth_hint`** is an open string with documented common values (`shared_bearer`, `per_agent_bearer`, `oauth`). `none` was deliberately dropped from the suggested vocabulary to remove a downgrade footgun — a buyer that uses the hint to decide whether to attach credentials would silently send unauthenticated requests on a hostile manifest. The schema and doc now require consumers MUST NOT use `auth_hint` to make credential-attachment decisions; that policy belongs to the consumer's trust configuration for the target origin.

**Out of scope (filed as follow-ups)**

- Per-agent signed manifests — TLS chain trust on the origin is sufficient for v1.
- Capability-aware filtering at the manifest level — operators advertise full claims, runners fetch each agent's `get_adcp_capabilities` for per-tool detail.
- Versioning beyond a top-level `version` field; future revisions will be additive within the `1.x` line.

Closes #3895.
