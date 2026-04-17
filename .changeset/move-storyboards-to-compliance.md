---
"adcontextprotocol": minor
---

Move storyboards from `@adcp/client` into the protocol repo as `/compliance/`
(universal + domains + specialisms + test-kits), and publish a per-version
protocol tarball at `/protocol/{version}.tgz` so clients can bulk-sync in one
request.

Introduces the two-axis capability model that `get_adcp_capabilities` uses
going forward:

- `domains` (new field) — broad agent categories. Valid values: `media-buy`,
  `creative`, `signals`, `governance`, `brand`, `sponsored-intelligence`
  (promoted from a specialism).
- `specialisms` (new field) — 21 specialization claims, each rolling up to
  exactly one domain. Includes renames (`broadcast-platform` →
  `sales-broadcast-tv`, `social-platform` → `sales-social`), a merge
  (`property-governance` + `collection-governance` → `inventory-lists`), and
  four new 3.1 archetypes (`sales-streaming-tv`, `sales-exchange`,
  `sales-retail-media`, `measurement-verification`).

Also publishes the `/protocol/` discovery endpoint and a new Compliance
Catalog page enumerating every domain + specialism an agent can claim.
