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

### Expert Review Scenarios
When running expert agents against documentation changes, test both:
- **Conceptual correctness** — Is the framing right? Are terms used consistently?
- **End-to-end buyer workflows** — Walk through actual buyer journeys (discovery → preview → serve → audit). Include generative-specific flows (brief → pre-flight preview → live campaign → post-flight replay) and edge cases (conversational formats, quality mismatches, multi-format pipelines).

Conceptual reviews miss workflow gaps. Workflow reviews miss framing errors. Run both.

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

**Use `--empty` (no package entry) for everything that isn't a protocol change:**
- Addie (any server-side AI behavior, tools, routing, bolt app)
- Website / admin UI / member pages
- Documentation updates (docs/, mintlify)
- Infrastructure, deployment, migrations
- Internal tooling and scripts

Only use `patch`/`minor`/`major` when the change affects the published AdCP protocol spec — schemas, task definitions, API reference.

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

## Certification Program

AgenticAdvertising.org runs a three-tier certification program (Basics → Practitioner → Specialist) taught by Addie through interactive chat. Key files:

- **Curriculum**: `server/src/addie/mcp/certification-tools.ts` (teaching tools, module resources, scoring)
- **Teaching methodology**: `TEACHING_METHODOLOGY`, `BUILD_PROJECT_METHODOLOGY`, `CAPSTONE_METHODOLOGY` constants in certification-tools.ts
- **Framework doc**: `docs/learning/instructional-design.mdx` (authoritative source for teaching methodology)
- **Policies**: `docs/learning/policies/` (nondiscrimination, learner records, complaints, conflict of interest, IP, personnel)
- **Database**: `server/src/db/certification-db.ts` (progress, credentials, tracks)
- **API routes**: `server/src/routes/certification.ts` (public/authenticated endpoints)
- **UI**: `server/public/certification.html` (dashboard, LinkedIn sharing, credential display)

### Certification impact checklist

When making protocol changes (new tasks, schema changes, renamed fields, removed features):

1. **Check affected modules** — Which certification modules teach the changed concepts? Update `MODULE_RESOURCES` links and teaching context in `certification-tools.ts` if needed.
2. **Consider continuing education** — Breaking changes (`major` version bumps) that alter core concepts may require notifying credential holders. Credentials reference the protocol version at time of issuance.
3. **Update learning resources** — If you add or move documentation pages referenced in `MODULE_RESOURCES`, update the URLs.

When updating teaching methodology:

4. **Keep framework aligned** — When updating `TEACHING_METHODOLOGY`, `BUILD_PROJECT_METHODOLOGY`, or `CAPSTONE_METHODOLOGY` constants in `certification-tools.ts`, verify alignment with `docs/learning/instructional-design.mdx` and update both.
5. **Update policies if needed** — Changes to assessment, data handling, or personnel processes may require updates to the corresponding policy page in `docs/learning/policies/`.

When building new features (member profiles, dashboards, community pages):

6. **Surface credentials** — If the feature displays user identity or professional context, consider showing earned credentials.
7. **Link to certification** — New capability areas may warrant new modules or tracks. Note this in the changeset description so it can be planned.

### Security

Module and exam completion is only available through Addie's tool calls — never through REST API. This prevents users from self-reporting scores without actual assessment.

## Illustrated Documentation

### Gemini image generation style guide

Walkthrough and overview pages use AI-generated illustrations in a consistent graphic novel style. When generating images with Gemini, use this prompt structure:

**Model**: `gemini-3.1-flash-image-preview` (via `responseModalities: ["TEXT", "IMAGE"]`)

**Base style prompt** (include in every image request):
```
Flat illustration, teal/emerald color palette (#047857 primary, #0d9488 secondary, #134e4a dark accents).
Graphic novel style with clean panel borders. Clean, minimal linework with subtle gradients.
Tech-forward but warm. No real brand names or logos.
Wide aspect ratio suitable for documentation headers (roughly 16:9).
Characters should have simple but expressive faces. Use white/light backgrounds for readability.
```

**Per-panel additions**: Describe the scene, characters, and key visual elements. Keep characters consistent within a walkthrough (same hair, glasses, outfit). Use the same robot design for AI agents across all illustrations.

**Generation script**: `scripts/generate-images.ts` — accepts a JSON prompt file and generates images via Gemini API. Run with `npx tsx scripts/generate-images.ts <prompt-file.json>`.

**Image locations**:
- `images/walkthrough/` — narrative panels for walkthrough pages
- `images/concepts/` — educational diagrams for concept explanations and curriculum

Mintlify serves from `/images/...`.

**Pages with illustrated walkthrough treatment**:
- `docs/walkthrough-adcp.mdx` — AdCP overview (5 panels)
- `docs/media-buy/walkthrough-media-buy.mdx` — media buy lifecycle (7 panels)
- `docs/governance/walkthrough-governance.mdx` — governance trust model (7 panels)
- `docs/creative/index.mdx` — creative campaign workflow (7 panels, from PR #1447)

### Documentation nav structure

Walkthrough pages use progressive disclosure — grouped by reader intent:
1. **Top level**: Overview + visual walkthrough (front door for everyone)
2. **Concepts**: Strategic/conceptual content with concept diagrams
3. **Implementation**: Integration guides for builders
4. **Reference**: Task reference and specification pages

Apply this pattern when restructuring protocol sections.
