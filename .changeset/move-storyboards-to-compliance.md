---
"adcontextprotocol": minor
---

Move storyboards from `@adcp/client` into the protocol repo as `/compliance/`
(universal + domains + specialisms + test-kits), and publish a per-version
protocol tarball at `/protocol/{version}.tgz` so clients can bulk-sync in one
request.

Compliance model for `get_adcp_capabilities`:

- `supported_protocols` (existing field, expanded) now doubles as the
  compliance-domain claim: each protocol listed commits the agent to pass the
  baseline storyboard at `/compliance/{version}/domains/{protocol}/`
  (snake_case → kebab-case mapping). `compliance_testing` is an RPC surface
  only and has no baseline. `sponsored_intelligence` is a full protocol
  (promoted from a specialism).
- `specialisms` (new field) — 21 specialization claims, each rolling up to one
  protocol. Includes renames (`broadcast-platform` → `sales-broadcast-tv`,
  `social-platform` → `sales-social`), a merge (`property-governance` +
  `collection-governance` → `inventory-lists`), and four 3.1 archetypes
  flagged `status: preview` (`sales-streaming-tv`, `sales-exchange`,
  `sales-retail-media`, `measurement-verification`) — runner warns rather
  than verifies until their storyboards land.

Also publishes the `/protocol/` discovery endpoint and a new Compliance
Catalog page enumerating every protocol + specialism an agent can claim.
