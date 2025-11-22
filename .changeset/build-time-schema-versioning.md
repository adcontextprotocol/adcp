---
"adcontextprotocol": minor
---

Implement build-time schema versioning with semantic version paths

Adds build-time schema versioning system that transforms unversioned source schemas into versioned distribution output with multiple access patterns:

- `/schemas/{version}/` - Exact semantic version (e.g., 2.5.0) for production use
- `/schemas/v{major}/` - Major version alias (e.g., v2) that tracks latest 2.x release
- `/schemas/v1/` - Backward compatibility alias for existing clients
- `/schemas/latest/` - Always points to current version (exploration only)

**Breaking changes:**
- Schema source files moved from `static/schemas/v1/` to `static/schemas/source/`
- Schemas now served from `dist/schemas/` instead of `static/schemas/`
- All schema `$id` and `$ref` fields use unversioned paths in source, versioned paths in dist

**Migration:**
- Existing clients using `/schemas/v1/` paths continue to work via backward compatibility alias
- New integrations should use `/schemas/v2/` for major version tracking
- Production applications should pin to exact versions (e.g., `/schemas/2.5.0/`)

**Implementation:**
- New `scripts/build-schemas.js` handles transformation and symlink creation
- Build script integrated into `npm run build` and version workflows
- All 142 schema files preserve git history via `git mv`
- Comprehensive documentation in `docs/reference/schema-versioning.mdx`
