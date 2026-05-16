---
---

chore(server): deprecate `/api/registry/lookup/domain/:domain` in favor of `/api/registry/publisher` (refs #4115)

Marks the older domain-lookup endpoint as deprecated in the OpenAPI spec and adds `Deprecation: true` + `Link` response headers so machine and human consumers both see the migration signal before removal.

Changes:
- `deprecated: true` on the `lookupDomain` OpenAPI path item in `registry-api.ts`
- Updated description to reference `/api/registry/publisher?domain=X` with a note that this endpoint will be removed in a future release
- `Deprecation: true` and `Link: </api/registry/publisher>; rel="successor-version"` headers on every response from the route handler (RFC 8594)

Internal callers (`mcp-tools.ts`, `addie/mcp/directory-tools.ts`) call `federatedIndex.lookupDomain()` directly and are tracked for migration in #4115 as follow-up work.
