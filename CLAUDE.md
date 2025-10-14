# Claude Development Guide

This guide helps AI assistants understand the AdCP project structure and maintain consistency when working on the codebase.

## Project Overview

The Advertising Context Protocol (AdCP) is an open standard for AI-powered advertising workflows. It provides a unified interface for media buying across diverse advertising platforms.

## Documentation Standards

### Protocol Specification vs Implementation

When working on documentation, it's crucial to maintain separation between:

1. **Protocol Specification** (what goes in docs/)
   - Abstract interface definitions
   - Tool signatures and parameters
   - Data models and schemas
   - Workflow descriptions
   - Platform-agnostic concepts

2. **Implementation Details** (what doesn't belong in the spec)
   - Database choices (PostgreSQL, MongoDB, etc.)
   - Deployment methods (Docker, Kubernetes, etc.)
   - Infrastructure details (multi-tenant architecture, etc.)
   - Specific technology stacks
   - Performance optimizations
   - Security implementation details

### Where Implementation Details Can Go

Implementation details can be mentioned as:
- **Recommendations** in a separate implementation guide
- **Examples** clearly marked as non-normative
- **Reference implementations** in the code
- **Best practices** documentation separate from the spec

### Writing Style

- Use "AdCP" not "ADCP"
- Focus on capabilities, not implementation
- Write for an audience implementing the protocol, not using a specific implementation
- Keep examples generic and illustrative

## JSON Schema Maintenance

### Schema-Documentation Consistency

**GOLDEN RULE**: Documentation and JSON schemas MUST always be synchronized.

### Protocol vs Task Response Separation

**CRITICAL PRINCIPLE**: Task response schemas should contain ONLY domain-specific data. Protocol-level concerns are handled by the transport layer (MCP, A2A, REST).

**Protocol-level fields (DO NOT include in task responses)**:
- `message` - Human-readable summaries (handled by MCP content field, A2A assistant messages)
- `context_id` - Session/conversation tracking (handled by protocol)
- `task_id` - Async operation tracking (handled by protocol)
- `status` - Task state management (handled by protocol)
- `webhook_url` / `webhook_secret` - Callback configuration (handled by protocol)

**Task response fields (DO include)**:
- Domain-specific results (signals, creatives, products, delivery metrics)
- Operation-specific metadata (dry_run flag, estimated durations)
- Task-specific errors and warnings
- Resource identifiers (decisioning_platform_segment_id, platform_id, etc.)

**Example - What a task response should look like**:
```json
{
  "signals": [...],           // ✅ Domain data
  "errors": [...]             // ✅ Task-specific errors
}
```

**NOT like this**:
```json
{
  "message": "Found 3 signals",     // ❌ Protocol concern
  "context_id": "ctx_123",          // ❌ Protocol concern
  "task_id": "task_456",            // ❌ Protocol concern
  "status": "completed",            // ❌ Protocol concern
  "signals": [...]                  // ✅ Domain data
}
```

This separation ensures AdCP tasks work identically across different protocol implementations (MCP, A2A, REST, future protocols).

**Protocol Envelope Schema**: The standard wrapper structure is documented in `/schemas/v1/core/protocol-envelope.json`. This schema shows how protocol layers wrap task response payloads with protocol-level fields.

### When to Update Schemas

Update JSON schemas whenever you:
- Add, remove, or rename any fields in task requests/responses
- Change field types, constraints, or validation rules
- Modify enum values (like status types, delivery types, etc.)
- Add new data models or modify existing core objects
- Change required vs optional field specifications

### Schema Update Checklist

When making documentation changes:
1. ✅ Identify affected schemas in `static/schemas/v1/`
2. ✅ Update request schemas (if changing task parameters)
3. ✅ Update response schemas (if changing response structure)  
4. ✅ Update core data models (if changing object definitions)
5. ✅ Update enum schemas (if changing allowed values)
6. ✅ Verify cross-references (`$ref` links) are still valid
7. ✅ Test schema validation with example data
8. ✅ Update schema descriptions to match documentation

### Schema Location Map

- **Task Requests**: `static/schemas/v1/media-buy/` or `static/schemas/v1/signals/`
- **Core Objects**: `static/schemas/v1/core/`
- **Enums**: `static/schemas/v1/enums/` 
- **Registry**: `static/schemas/v1/index.json`

### Validation Testing

Always validate schemas work correctly:
```bash
# Use online JSON schema validators or
# Node.js with ajv library to test schemas
# Schemas are accessible locally at http://localhost:3000/schemas/v1/ when running npm run start
```

### Local Schema Access

When running `npm run start`, all JSON schemas are accessible at:
- Schema registry: `http://localhost:3000/schemas/v1/index.json`
- Core schemas: `http://localhost:3000/schemas/v1/core/{name}.json`
- Task schemas: `http://localhost:3000/schemas/v1/media-buy/{task}-{request|response}.json`
- Signal schemas: `http://localhost:3000/schemas/v1/signals/{task}-{request|response}.json`
- Enum schemas: `http://localhost:3000/schemas/v1/enums/{name}.json`

## Schema Versioning Workflow

### Path-Based Versioning

**IMPORTANT**: AdCP uses path-based versioning. The schema URL path indicates the version, not individual fields in schemas.

- **Version is in the path**: `/schemas/v1/` vs `/schemas/v2/`
- **No `adcp_version` field** in request or response schemas
- **Single source of truth**: `static/schemas/v1/index.json` contains the current version

**Rationale**:
- Eliminates redundant version fields in every schema
- Reduces maintenance burden (no need to update version in 30+ files)
- Clearer semantics (the schema you reference IS the version you use)
- Follows REST/HTTP conventions (version in path, not payload)

### When to Version Schemas

AdCP uses semantic versioning for schemas. Increment the version when:

**PATCH (1.0.0 → 1.0.1)**: Schema fixes that don't change behavior
- Fix typos in descriptions
- Correct validation patterns
- Clarify existing field meanings
- Fix broken `$ref` links

**MINOR (1.0.0 → 1.1.0)**: Backward-compatible additions
- Add new optional fields to requests/responses
- Add new enum values (append-only)
- Add new optional core object properties
- Add new tasks (new request/response pairs)

**MAJOR (1.0.0 → 2.0.0)**: Breaking changes
- Remove or rename existing fields
- Change field types or constraints
- Make optional fields required
- Remove enum values
- Change existing field meanings

### Schema Versioning Checklist

When making **ANY** schema change:

1. **✅ Determine Version Impact**
   - Review changes against patch/minor/major criteria above
   - If breaking change, consider if really necessary
   - Document the rationale for the change

2. **✅ Update Schema Registry**
   - Update `adcp_version` in `static/schemas/v1/index.json`
   - Update `lastUpdated` field in schema registry
   - **DO NOT** add `adcp_version` to individual schemas

3. **✅ Update All Related Schemas**
   - If changing core objects, update all schemas that reference them
   - If adding enum values, ensure all using schemas are compatible
   - Verify `$ref` links still resolve correctly

4. **✅ Test Schema Changes**
   - Validate all modified schemas with JSON Schema validator
   - Test with real request/response examples
   - Ensure existing examples still validate

5. **✅ Update Documentation**
   - Update all affected task documentation in `docs/`
   - Update API examples to reference correct schema path
   - If major version, create migration guide in `docs/reference/versioning.md`

### Example Schema Version Update

When adding a new optional field to `create-media-buy-request.json`:

```json
// In create-media-buy-request.json
{
  "$id": "/schemas/v1/media-buy/create-media-buy-request.json",
  "properties": {
    "new_optional_field": {
      "type": "string",
      "description": "New feature description"
    }
  }
}
```

Then update schema registry:
```json
// In static/schemas/v1/index.json
{
  "adcp_version": "1.1.0",  // ← Update version
  "lastUpdated": "2025-10-13"  // ← Update date
}
```

### Breaking Changes (Major Versions)

For major version changes:

1. **Create new version directory**: `static/schemas/v2/`
2. **Implement breaking changes** in v2 schemas
3. **Update schema registry** to include v2 paths
4. **Create migration documentation** with:
   - What changed and why
   - Step-by-step migration guide
   - Code examples for before/after
5. **Maintain v1 support** during transition period
6. **Deprecation timeline** for removing v1 support

## Code Standards

### TypeScript/JavaScript
- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Implement proper error handling
- Add types for all parameters and return values

### Testing
- Check for existing test patterns before writing new tests
- Run tests with `npm test` before committing
- Ensure new features have corresponding tests

### Format Field Naming Convention

**CRITICAL**: Always use consistent naming for format-related fields to avoid developer confusion.

**Established Convention**:
- **`"formats"`** = Array of format objects (with full details like name, type, requirements, assets_required, etc.)
- **`"format_ids"`** = Array of format ID strings (references to format objects)
- **`"format_types"`** = Array of high-level type strings (video, display, audio, native, etc.)

**Examples**:
```json
// ✅ CORRECT - list_creative_formats response (format objects)
{
  "formats": [
    {
      "format_id": "video_standard_30s",
      "name": "Standard Video - 30 seconds", 
      "type": "video",
      "requirements": {...}
    }
  ]
}

// ✅ CORRECT - Product response (format ID strings)
{
  "product_id": "ctv_premium",
  "format_ids": ["video_standard_30s", "video_standard_15s"]
}

// ✅ CORRECT - get_products filter (high-level types)
{
  "filters": {
    "format_types": ["video", "display"]
  }
}
```

**When adding new fields**:
- Use `format_ids` when referencing existing formats by ID
- Use `formats` only when returning full format objects
- Use `format_types` for broad categorical filtering
- Never use `formats` for arrays of strings - always use `format_ids`

**Schema Validation**: All schemas must follow this convention. Tests will fail if format fields don't match the expected naming pattern.

### Format ID Structure

**CRITICAL**: Format IDs are ALWAYS structured objects, never strings, to avoid parsing ambiguity and handle namespace collisions.

**Structured Format ID (REQUIRED EVERYWHERE)**:
```json
{
  "agent_url": "https://creatives.adcontextprotocol.org",
  "id": "display_300x250"
}
```

**Where structured format IDs are used (everywhere)**:
- **All request parameters** accepting format_id (sync_creatives, build_creative, preview_creative, etc.)
- **All response fields** containing format_id (list_creatives, get_products, list_creative_formats, etc.)
- **Creative asset objects** specifying which format they conform to
- **Product responses** listing supported formats
- **Filter parameters** in list operations (format_ids plural = array of objects)
- **Creative manifests** specifying the format

**Why structured objects everywhere?**
- No parsing ambiguity - components are explicit
- Handles format ID collisions between different creative agents
- Simpler mental model - one pattern, no exceptions
- Future-proof for versioning and extensions

**Schema reference**:
```json
{
  "format_id": {
    "$ref": "/schemas/v1/core/format-id.json"
  }
}
```

**Validation rule**: All AdCP agents MUST reject string format_ids in ALL contexts with clear error messages. No exceptions.

**Legacy handling**: If supporting legacy clients sending strings, you MAY auto-upgrade during a deprecation period (max 6 months), but MUST log warnings and fail on unknown format strings. Recommended approach is strict rejection from day one.

### Removed Format Fields

**IMPORTANT**: The following fields have been removed from the format schema and should NOT be used:

#### `accepts_3p_tags` (Removed in v1.9.0)
- **Why removed**: Redundant with HTML and JavaScript asset types
- **Migration**: Filter formats by `asset_types: ["html"]` or `asset_types: ["javascript"]` to find formats that accept third-party tags
- **Rationale**: Third-party tags ARE HTML/JavaScript assets. If a format accepts these asset types, it implicitly supports third-party tags.

#### `category` and `is_standard` (Removed in v1.10.0)
- **Why removed**: Information is redundant with source location
- **Migration**:
  - Standard formats are defined in `/schemas/v1/standard-formats/` directory
  - Custom formats have an `agent_url` pointing to a non-standard creative agent
  - Format location/source already indicates whether it's standard or custom
- **Rationale**: These fields carried information already expressed by the format's authoritative source. Adding explicit fields was redundant and increased maintenance burden.

## Common Tasks

### Before Making Changes
1. Check `git status` to understand current state
2. Read relevant existing documentation
3. Search for similar patterns in the codebase
4. Consider impact on other parts of the system

### Documentation Updates
1. Keep protocol spec abstract and implementation-agnostic
2. Update all related documentation when making changes
3. Ensure examples are consistent across docs
4. Remove version numbers while in v1 development
5. **CRITICAL: JSON Schema Synchronization**
   - When changing any task parameters, data models, or field definitions in docs, **ALWAYS update the corresponding JSON schemas** in `static/schemas/v1/`
   - When updating JSON schemas, **ALWAYS verify the documentation matches** the schema definitions
   - Check both request/response schemas AND core data model schemas for affected changes
   - Update the schema registry (`static/schemas/v1/index.json`) if adding/removing schemas

### Code Changes
1. Follow existing patterns
2. Update tests
3. Run linting: `npm run lint`
4. Run type checking: `npm run typecheck`
5. Run tests: `npm test`

## Key Concepts to Remember

### Protocol Design Principles
1. **MCP-Based**: Built on Model Context Protocol
2. **Asynchronous**: Operations may take time
3. **Human-in-the-Loop**: Optional manual approval
4. **Platform Agnostic**: Works across ad platforms
5. **AI-Optimized**: Designed for AI agents

### What Exists vs What Doesn't
- ✅ `get_products` - discovers inventory
- ❌ `discover_products` - doesn't exist
- ❌ `get_avails` - removed in favor of direct purchase
- ✅ `create_media_buy` - creates campaigns
- ✅ `list_creative_formats` - shows supported formats

### Data Models
- Products don't include `targeting_template` or `implementation_config` in responses
- Focus on what's visible to API consumers, not internal implementation

## Useful Commands

```bash
# Development
npm run dev          # Start development server
npm run build        # Build the project
npm test            # Run tests
npm run lint        # Check code style
npm run typecheck   # Check TypeScript types

# Documentation
npm run docs:dev    # Start docs dev server
npm run docs:build  # Build documentation

# Git
git status          # Check current changes
git add -A          # Stage all changes
git commit -m "..."  # Commit with message
git push            # Push to remote
```

## When in Doubt

1. Check existing code for patterns
2. Keep the specification abstract
3. Focus on protocol capabilities, not implementation
4. Ask for clarification on design decisions
5. Refer to the [API Reference](docs/media-buy/api-reference.md) for tool signatures

## Standard Formats: Lessons Learned

### Schema Simplification Best Practices

Through the standard formats implementation, we've learned key principles for schema design:

1. **Remove Platform-Specific Complexity**
   - Formats should be platform-agnostic
   - No `platform` or `placement_type` fields in format definitions
   - Publishers adapt formats through placement, not specification changes

2. **Simplify Selection Logic**
   - Removed complex `format-selection.json` schema
   - No placement types or format preferences in products
   - Buyers directly specify formats they want to provide

3. **Clear Asset Identification**
   - Added `asset_role` field to identify asset purposes (e.g., 'hero_image', 'logo')
   - Assets are self-describing with clear roles
   - Enables better creative assembly and validation

4. **Better Field Naming**
   - `accepts_3p_tags` instead of `is_3p_served` (indicates optionality)
   - `formats_to_provide` instead of `selected_formats` (clearer intent)
   - Field names should indicate purpose, not state

### Testing Considerations

1. **Schema Registry Tests**
   - Not all schemas need to be in the registry
   - Registry only needs to reference core and enum schemas
   - Standard format schemas are discovered through directory structure
   - Test should validate registry references exist, not that all schemas are registered

2. **Schema Validation Patterns**
   - Include `index.json` files in schema discovery
   - Validate examples match schema structure
   - Ensure all `$ref` links resolve correctly
   - Test both request and response schemas

### Code Review Integration

When addressing code review feedback:

1. **Use Todo Lists**
   - Create a todo for each review comment
   - Track progress systematically
   - Mark items complete as you address them

2. **Batch Related Changes**
   - Group similar schema updates together
   - Use MultiEdit for multiple changes to same file
   - Test after each batch of changes

3. **Documentation Sync**
   - Update documentation when changing schemas
   - Keep examples consistent with schema changes
   - Update both spec docs and CLAUDE.md as needed

### Standard Formats Architecture

The simplified standard formats structure:

```
static/schemas/v1/standard-formats/
├── index.json                 # Registry of all standard formats
├── asset-types/              # Reusable asset type definitions
│   ├── image.json
│   ├── video.json
│   └── text.json
├── display/                  # Display format definitions
│   ├── display_300x250.json
│   └── mobile_interstitial_320x480.json
├── video/                    # Video format definitions
│   ├── video_skippable_15s.json
│   └── video_story_vertical.json
└── native/                   # Native format definitions
    └── native_responsive.json
```

Key principles:
- Each format is self-contained with all requirements
- No cross-references to placement or selection schemas
- Assets are defined inline with clear specifications
- Format categories match industry standards (display, video, native, etc.)

## Documentation Structure Theory & Learnings

### Core Documentation Principles

Based on extensive reorganization of the AdCP documentation, these principles have emerged as critical for effective technical documentation:

#### 1. **User-Centric Organization**
- Structure docs around **user workflows**, not internal system architecture
- Group related concepts together even if they map to different technical components
- Prioritize **what users need to accomplish** over how the system is built internally

#### 2. **Eliminate Redundancy Ruthlessly**
- **One source of truth** for each concept - never duplicate content across multiple files
- Use **cross-references** rather than copying content
- When consolidating, choose the **most logical location** based on user workflow

#### 3. **Consistent Naming Patterns**
- Use **"Overview"** for index pages rather than repeating the section name
- Examples: `capability-discovery/index.md` titled "Overview", not "Capability Discovery"
- Avoid navigation hierarchies where the same name appears twice

#### 4. **Protocol-Agnostic Documentation**
- **Never** assume a specific protocol (MCP, A2A, REST) in core documentation
- Focus on **tasks and capabilities**, not transport mechanisms
- Reference protocol-specific details in dedicated protocol sections

#### 5. **Workflow-Based Information Architecture**
- Organize by **user journey stages**: Discovery → Planning → Execution → Optimization
- Group related activities together (e.g., Policy Compliance belongs with Media Buys, not as standalone)
- Separate **conceptual understanding** from **technical implementation**

### Documentation Architecture Lessons

#### Multi-Level Navigation Strategy
```
Main Section (e.g., "Media Buy")
├── Overview (introduces the domain)
├── Foundation Concepts (e.g., Capability Discovery)
├── Planning Activities (e.g., Product Discovery)  
├── Execution Workflows (e.g., Media Buys, Creatives)
└── Advanced Topics (technical deep-dives)
```

#### Content Consolidation Guidelines

**When to Consolidate:**
- Content serves the **same user workflow**
- Information is **closely related** conceptually
- Separate documents create **cognitive overhead**
- Users would naturally expect to find information together

**When to Keep Separate:**
- Content serves **different audiences** (conceptual vs. technical)
- Documents are **reference material** (e.g., API docs)
- Content has **different lifecycles** (e.g., stable concepts vs. evolving examples)

#### Navigation Best Practices

1. **Role-Based Getting Started**
   - Provide **multiple entry points** based on user role
   - "For AI Agent Developers", "For Campaign Managers", "For Publishers"
   - Each path references the **same underlying documentation** but suggests different reading order

2. **Clear Section Purposes**
   - **Capability Discovery**: Foundation concepts and requirements
   - **Product Discovery**: Natural language inventory search
   - **Media Buys**: Campaign lifecycle and execution
   - **Creatives**: Asset management workflows
   - **Advanced Topics**: Technical implementation details

3. **Avoid Deep Nesting**
   - Maximum **3 levels** of navigation hierarchy
   - Use **in-page sections** rather than additional file levels
   - Prefer **longer comprehensive pages** over many small pages

### Anti-Patterns to Avoid

#### 1. **Technology-Centric Organization**
```
❌ BAD: Organized by tech stack
├── MCP Integration
├── A2A Integration  
├── Database Schemas
└── API Endpoints

✅ GOOD: Organized by user workflow
├── Discovery & Planning
├── Campaign Execution
├── Performance Optimization
└── Technical Implementation
```

#### 2. **Redundant Section Titles**
```
❌ BAD: Navigation shows duplicate names
Product Discovery
├── Product Discovery (redundant!)
├── Brief Expectations
└── Example Briefs

✅ GOOD: Clear hierarchy
Product Discovery  
├── Overview
├── Brief Expectations
└── Example Briefs
```

#### 3. **Protocol Assumptions**
```
❌ BAD: MCP-centric language
"Use MCP tool calls to discover products..."

✅ GOOD: Protocol-agnostic language  
"Use the get_products task to discover products..."
```

#### 4. **Scattered Related Content**
```
❌ BAD: Related concepts separated
├── Media Buys (lifecycle)
├── Policy Compliance (standalone)
└── Optimization (separate section)

✅ GOOD: Workflow-grouped content
└── Media Buys
    ├── Lifecycle
    ├── Policy Compliance  
    └── Optimization & Reporting
```

### Specific AdCP Learnings

#### 1. **Brief-Based Targeting Philosophy**
- Documentation should emphasize **natural language approach** over technical targeting APIs
- Focus on **publisher expertise** and **inclusive pricing** concepts
- Technical overlays are **exception cases**, not the primary workflow

#### 2. **Separation of Concerns Model**
- The **three-role model** (Publisher, Principal, Orchestrator) is central to AdCP
- This model should be explained in **Media Buy context**, not as general protocol theory
- Each role has **different documentation needs** and entry points

#### 3. **Asynchronous-First Design**
- Emphasize **"timely but not real-time"** nature throughout documentation
- Response time expectations should be **clearly communicated** early
- Human-in-the-loop workflows are **normal**, not edge cases

#### 4. **Multi-Protocol Reality**
- AdCP **tasks are protocol-agnostic** - the same 8 tasks work across MCP, A2A, and future protocols
- Protocol choice is an **integration decision**, not a capability limitation
- Documentation should **guide protocol selection** based on use case, not assume one

### Continuous Improvement Guidelines

1. **Regular User Journey Reviews**
   - Periodically trace through documentation **as different user types**
   - Identify **friction points** and **missing connections**
   - Consolidate or separate content based on **actual usage patterns**

2. **Cross-Reference Validation**
   - Ensure all **internal links** remain valid after reorganization
   - Use **relative paths** that survive structural changes
   - Regularly test **build process** to catch broken references

3. **Content Lifecycle Management**
   - Mark **outdated concepts** for removal rather than updating indefinitely
   - **Archive rather than delete** content that may become relevant again
   - Keep **CLAUDE.md updated** with structural decisions and rationale

These principles emerged from reorganizing 50+ documentation files and should guide future structural decisions. The goal is always **user success** - helping people accomplish their goals with minimal cognitive overhead.