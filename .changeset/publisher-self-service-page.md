---
---

Adds a unified publisher self-service page at `/publisher/{domain}`. The
page calls `/api/registry/publisher` and renders: AAO-member status,
adagents.json validity, properties (with source badges:
`adagents_json` / `discovered` / `brand_json`), and authorized agents with
the new "X of Y properties authorized" rollup. Empty state guides
publishers toward declaring inventory or pointing AAO at their brand.json.

Edit-properties button deep-links to the existing property editor at
`/property/view/{domain}`.
