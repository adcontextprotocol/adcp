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

### Schema Compliance
All documentation and examples MUST match JSON schemas in `static/schemas/v1/`:
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
- Task schemas: `static/schemas/v1/media-buy/` and `static/schemas/v1/signals/`
- Core objects: `static/schemas/v1/core/`
- Enums: `static/schemas/v1/enums/`
- Registry: `static/schemas/v1/index.json`
- Local access: `http://localhost:3000/schemas/v1/` when running dev server

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

## Local Development

### Docker (Preferred)
```bash
docker compose up --build  # Start postgres + app with auto-migrations
docker compose down -v     # Reset database
```
**Note:** Docker maps to `$CONDUCTOR_PORT` (from `.env.local`), not port 3000. Check `docker compose ps` for the actual port.

### Without Docker
```bash
npm run db:migrate
npm run start
```

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
npm run dev          # Dev server
npm run build        # Build
npm test             # Run tests
npm run lint         # Lint
npm run typecheck    # Type check
npm run docs:dev     # Docs dev server
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
