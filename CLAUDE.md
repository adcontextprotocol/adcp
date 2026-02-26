# Claude Development Guide

This guide extends the parent repo's CLAUDE.md with workspace-specific details for the AgenticAdvertising.org implementation.

## Documentation Framework

This project uses **Mintlify** for documentation:
- All docs in `docs/` directory as Markdown/MDX
- Use `<CodeGroup>` for multi-language examples (NOT Docusaurus `<Tabs>`)
- Run with: `mintlify dev`

## Critical Rules

### Organization Naming
- ✅ **AgenticAdvertising.org** - the member organization
- ✅ **AdCP** - the protocol specification
- ❌ Never "Alliance for Agentic Advertising", "AAO", or "ADCP"

### Examples: No Real Brands or Agencies
- ❌ Never use real company names (brands, agencies, holding companies) in new examples
- ✅ Use fictional names: Acme Corp, Pinnacle Media, Nova Brands, etc.
- The brand seed data in migrations may list real domains for discovery purposes
- Enum values that reference industry standards (e.g., `"groupm"` viewability standard) are protocol terms, not examples

### Schema Compliance
All documentation and examples MUST match JSON schemas in `static/schemas/source/`:
- Verify fields exist in schema before documenting
- Remove examples that don't match schema (don't mark as `test=false`)
- Test with: `npm test -- --file docs/path/to/file.mdx`

### Discriminated Union Error Handling
Always check for errors before accessing success fields:
```javascript
const result = await agent.syncCreatives({...});
if (result.errors) {
  console.error('Failed:', result.errors);
} else {
  console.log(`Success: ${result.creatives.length} items`);
}
```

### Design System
All HTML files in `server/public/` MUST use CSS variables from `/server/public/design-system.css`:
```css
/* ✅ */ color: var(--color-brand);
/* ❌ */ color: #667eea;
```

### UI Text Casing
Use **sentence case** for all UI labels, headings, and section headers:
- ✅ "Brand identity", "Creative assets", "Contact information"
- ❌ "Brand Identity", "Creative Assets", "Contact Information"

## JSON Schema Guidelines

### Discriminated Unions
Use explicit discriminator fields with `"type"` before `"const"`:
```json
{
  "oneOf": [
    {
      "properties": {
        "kind": { "type": "string", "const": "variant_a" },
        "field_a": { "type": "string" }
      },
      "required": ["kind", "field_a"]
    }
  ]
}
```

Include common fields (like `ext`) inside each variant, not at root level.

### Schema Locations
- Source schemas: `static/schemas/source/` (development, serves as `latest`)
- Released versions: `dist/schemas/{version}/` (e.g., `2.5.3`, `3.0.0-beta.3`)
- Local access: `http://localhost:3000/schemas/latest/` when running dev server

### Schema URLs in Documentation

When linking to schemas in docs, use the correct version alias:

**Released schemas** - Use the major version alias:
```markdown
[$schema](https://adcontextprotocol.org/schemas/v3/media-buy/create-media-buy-request.json)
```

**Unreleased schemas** (exist in `static/schemas/source/` but not in any `dist/schemas/{version}/`) - Use `/schemas/latest/`:
```markdown
<!-- Using latest because this schema is not yet released in any version.
     Update to correct version alias after the next release. -->
[$schema](https://adcontextprotocol.org/schemas/latest/media-buy/sync-audiences-request.json)
```

**How to check if a schema is released:**
1. Check `dist/schemas/` for the highest version number under each major (e.g., `3.0.0-beta.3` for v3, `2.5.3` for v2)
2. If the schema exists in a released version, use that major version alias (v3, v2)
3. If only in `static/schemas/source/`, use `latest`

**Version aliases:**
- `/schemas/v3/` → latest 3.x release (currently 3.0.0-beta.3)
- `/schemas/v2/` → latest 2.x release (currently 2.5.3)
- `/schemas/v1/` → points to `latest` (for backward compatibility)
- `/schemas/latest/` → development version (`static/schemas/source/`)

**CI validation:** The `check-schema-links.yml` workflow validates schema URLs in PRs and will warn about unreleased schemas or suggest the correct version.

### Protocol vs Task Response Separation
Task responses contain ONLY domain data. Protocol concerns (message, context_id, task_id, status) are handled by transport layer.

## Versioning

### Changesets
**NEVER manually edit versions.** Use changesets:
```bash
# Create .changeset/your-feature.md
---
"adcontextprotocol": minor
---
Description of change.
```

Types: `patch` (fixes), `minor` (new features), `major` (breaking), `--empty` (no protocol impact)

### Semantic Versioning for Schemas
- **PATCH**: Fix typos, clarify descriptions
- **MINOR**: Add optional fields, new enum values, new tasks
- **MAJOR**: Remove/rename fields, change types, remove enum values

### Addie Code Version
When making significant changes to Addie's core logic, bump `CODE_VERSION` in `server/src/addie/config-version.ts`.

**When to bump:**
- Claude client behavior (`claude-client.ts`)
- Tool implementations (`mcp/*.ts`)
- Message processing logic (`thread-service.ts`, `bolt-app.ts`)
- Router logic beyond `ROUTING_RULES` (`router.ts`)

**Format:** `YYYY.MM.N` (e.g., `2025.01.1`, `2025.01.2`, `2025.02.1`)

This creates a new Addie config version, allowing performance comparison before/after code changes.

## Deployment

Production deploys to **Fly.io** (not Vercel). Migrations run automatically on startup.
- Deploy logs: `fly logs -a <app-name>`
- SSH access: `fly ssh console -a <app-name>`

## Local Development

**Always use Docker for local testing:**
```bash
docker compose up --build  # Start postgres + app with auto-migrations
docker compose down -v     # Reset database
```

The app runs on `$CONDUCTOR_PORT` (from `.env.local`), defaulting to 3000. Static files in `server/public/` are hot-reloaded via volume mount.

### Environment Variables
- `CONDUCTOR_PORT` - Server port (default: 3000)
- `DATABASE_URL` - PostgreSQL connection string
- `DEV_USER_EMAIL` / `DEV_USER_ID` - Enable dev mode (local only)

### Slack Apps
Two separate apps with independent credentials:
1. **AgenticAdvertising.org Bot**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
   - Events: `/api/slack/aaobot/events`
   - Commands: `/api/slack/aaobot/commands`
2. **Addie AI**: `ADDIE_BOT_TOKEN`, `ADDIE_SIGNING_SECRET` → `/api/slack/addie/events`

### Dev Login
With dev mode enabled, visit `/dev-login.html` to switch between admin/member/visitor test users.

## Documentation Locations

**Update for releases:**
- `docs/intro.mdx` - Info banner
- `server/public/index.html` - Homepage version
- `docs/reference/release-notes.mdx` - Release notes
- `docs/reference/roadmap.mdx` - Roadmap

**Auto-generated (don't edit):**
- `CHANGELOG.md` - Managed by changesets

## Testable Documentation

Mark pages with `testable: true` in frontmatter. All code blocks will be executed:
```markdown
---
title: get_products
testable: true
---
```

JSON examples with `$schema` field are validated against schemas in CI.

## Format Conventions

### Field Naming
- `formats` = Array of full format objects
- `format_ids` = Array of format ID references
- `format_types` = Array of high-level types (video, display, etc.)

### Format ID Structure
Always structured objects:
```json
{
  "agent_url": "https://creatives.adcontextprotocol.org",
  "id": "display_300x250"
}
```

### Renders Structure
Visual formats use `renders` array with structured dimensions:
```json
{
  "renders": [{
    "role": "primary",
    "dimensions": { "width": 300, "height": 250, "unit": "px" }
  }]
}
```

## Quick Reference

### Useful Commands
```bash
docker compose up --build  # Local dev server (preferred)
npm run build              # Build TypeScript
npm test                   # Run tests
npm run lint               # Lint
npm run typecheck          # Type check
mintlify dev               # Docs dev server (requires mintlify CLI)
```

### Protocol Design Principles
1. MCP-Based
2. Asynchronous operations
3. Human-in-the-loop optional
4. Platform agnostic
5. AI-optimized

### Task Reference
- ✅ `get_products`, `create_media_buy`, `list_creative_formats`
- ❌ `discover_products`, `get_avails` (don't exist)
