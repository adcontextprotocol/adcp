---
---

Add CI linter (`npm run check:registry`) that enforces the publication bar for
`static/registry/policies/**/*.json`. Registry-published policies must carry
the full metadata set (`source: "registry"`, `version`, `name`, `category`,
`jurisdictions`, `source_url`, `source_name`, `effective_date`, plus at least
one pass and one fail exemplar). Schema-level validation stays relaxed so
inline bespoke `PolicyEntry` authoring in `sync-plans` and `content-standards`
remains ergonomic. Existing registry entries backfilled to meet the bar, and
`static/registry/README.md` added documenting the requirement.

Closes #2319.
