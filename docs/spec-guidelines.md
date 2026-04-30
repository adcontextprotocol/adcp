---
title: Specification Guidelines
description: "AdCP specification guidelines: type naming rules, discriminated union patterns, field naming conventions, and style standards for writing protocol spec pages."
"og:title": "AdCP — Specification Guidelines"
---

# AdCP Specification Guidelines

This document outlines design principles and rules for maintaining the AdCP specification. These guidelines help ensure consistency, clarity, and ease of implementation across different programming languages.

## Type Naming Principles

### No Reused Type Names

**RULE**: Never use the same enum name or field name to represent different concepts, even in different contexts.

**Why**: Type generators (TypeScript, Python, Go, etc.) create collisions when the same name appears with different values or semantics. This forces downstream users to use awkward workarounds like aliasing or deep imports.

**Example of the problem**:

```json
// ❌ BAD: Multiple "Type" enums with different meanings
// asset-type.json
{ "type": "string", "enum": ["image", "video", "html"] }

// format.json
{ "type": "string", "enum": ["audio", "video", "display"] }

// Result: Python generates Type, Type1, Type2 or uses alphabetical first-wins
```

**Solution**: Use semantic, domain-specific names:

```json
// ✅ GOOD: Distinct enum names for different concepts
// asset-content-type.json
{ "type": "string", "enum": ["image", "video", "html"] }

// pricing-model.json
{ "type": "string", "enum": ["cpm", "cpc", "fixed"] }

// Result: Python generates AssetContentType and PricingModel
```

### Semantic Field Names

Field names should describe **what** they represent, not generic categories.

**Examples**:

- ✅ `asset_content_type` - Clear: describes what content the asset contains
- ❌ `type` - Ambiguous: type of what?
- ❌ `asset_type` - Better, but could conflict with other type fields

### Enum Consolidation

When the same concept appears in multiple places with different subsets:

1. **Create a single canonical enum** with all possible values
2. **Reference that enum** in all schemas using `$ref`
3. **Document subset expectations** in field descriptions when needed

**Example**:

```json
// enums/asset-content-type.json - Single source of truth
{
  "$id": "/schemas/v3/enums/asset-content-type.json",
  "type": "string",
  "enum": ["image", "video", "audio", "text", "html", "javascript", ...]
}

// brand.json - References full enum
{
  "asset_type": {
    "$ref": "/schemas/v3/enums/asset-content-type.json",
    "description": "Type of asset. Note: Brand manifests typically contain basic media assets (image, video, audio, text)."
  }
}

// list-creative-formats-request.json - References full enum
{
  "asset_types": {
    "type": "array",
    "items": {
      "$ref": "/schemas/v3/enums/asset-content-type.json"
    }
  }
}
```

**Benefits**:
- Type generators produce single, consistent types
- API allows filtering/specifying any valid value
- Adding new values is non-breaking
- Documentation clarifies typical usage without restricting capability

## Enum Design

### Enum File Structure

All enums should live in `/schemas/v3/enums/` with descriptive names:

```
/schemas/v3/enums/
  asset-content-type.json      # What IS this asset?
  pricing-model.json           # How is this PRICED?
  media-buy-status.json        # What STATE is the buy in?
```

### Enum Naming Convention

- Use **noun phrases** that describe what's being categorized
- Use **kebab-case** for filenames
- Generated type names use **PascalCase** (AssetContentType, PricingModel)
- Avoid generic terms like "type", "kind", "status" without qualifiers

### When to Create a New Enum

Create a dedicated enum file when:
- Values are reused across multiple schemas
- Values represent a closed set of options
- The concept is fundamental to the protocol
- Type safety would benefit implementers

## Field Design

### Discriminated Unions

When objects can have multiple shapes, always use explicit discriminator fields:

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "delivery_type": { "type": "string", "const": "url" },
        "url": { "type": "string" }
      },
      "required": ["delivery_type", "url"]
    },
    {
      "type": "object",
      "properties": {
        "delivery_type": { "type": "string", "const": "inline" },
        "content": { "type": "string" }
      },
      "required": ["delivery_type", "content"]
    }
  ]
}
```

This enables proper type narrowing in TypeScript and pattern matching in other languages.

### Avoiding Over-Specific Subsets

Don't artificially restrict enum values in request schemas unless there's a technical reason:

- ❌ Limit `asset_types` filter to 7 values "because most people only use these"
- ✅ Allow all asset content types - let users filter by anything

If certain values are uncommon, document that in the description but don't prevent their use.

## Schema References

### When to Use $ref

Use `$ref` for:
- Enum values (always)
- Core data models used in multiple places
- Complex nested objects used repeatedly

Don't use `$ref` for:
- Simple inline objects used only once
- Request-specific parameters
- Highly contextual structures

### Reference Paths

All `$ref` paths should be absolute from schema root:

```json
// ✅ GOOD: Absolute path
"$ref": "/schemas/v3/enums/asset-content-type.json"

// ❌ BAD: Relative path
"$ref": "../../enums/asset-content-type.json"
```

## Platform Agnosticism

**RULE**: Normative schema **field names** MUST NOT represent a specific vendor's version of a general concept. Platform-specific fields belong under `ext.{vendor}`.

**Why**: AdCP is a protocol, not a platform. A field named `google_campaign_id` or `ttd_line_id` at the top level of a schema bakes one vendor's data model into the spec and creates lock-in. The protocol is credible as an open standard only to the extent that its normative field surface is vendor-neutral.

**How**: Vendor-specific fields belong in the `ext.{vendor}` namespace (schema: `/schemas/core/ext.json`, source: `static/schemas/source/core/ext.json`). `ext` is `additionalProperties: true` — the namespacing is a convention enforced by review, not by JSON Schema.

```json
// ❌ BAD: vendor name in a normative field (a general concept dressed up as a vendor)
{
  "google_campaign_id": "abc123"
}

// ✅ GOOD: vendor-specific under ext
{
  "ext": {
    "gam": { "campaign_id": "abc123" }
  }
}
```

### External system identifiers

Names that reference **canonical external identifier spaces** are legitimate in both field names and enum values. The distinction is not "does it contain a vendor token" but "does it represent *that vendor's version of something the protocol already has a general concept for*":

- `google_campaign_id` (bad) — a vendor-specific ID for a concept the protocol already models (`media_buy_id`). Move to `ext.gam`.
- `apple_podcast_id` (legitimate) — a canonical identifier for a specific Apple Podcasts item. There is no general concept to map to; the Apple Podcasts namespace is *the* namespace.
- `nielsen_dma` (legitimate) — the industry-standard geographic division, not "Nielsen's version of geography."

Existing examples of legitimate patterns:

- Distribution-platform identifier types: `amazon_music_id`, `roku_channel_id` in `distribution-identifier-type.json` (enum values)
- Feed formats: `google_merchant_center`, `facebook_catalog` in `brand.json` (enum values) — widely-adopted open interchange formats implemented by many third parties
- Measurement/data identifiers: `nielsen_dma` in `get-adcp-capabilities-response` (field name)
- Platform IDs: `apple_podcast_id`, `apple_id` (field names)

The rule to apply: if the name asks "which vendor-equivalent version of something AdCP models?" (bad — use `ext`), reject; if the name asks "which externally-defined system/format/identifier space?" (legitimate), allow. When allowing a field name, add it to `tests/check-platform-agnostic.cjs` `FIELD_ALLOWLIST` with a one-line justification. When allowing an enum value, add it to `ENUM_VALUE_ALLOWLIST` with a path-qualified entry and a one-line justification.

### Reviewer checklist

- Reject a new top-level or request/response field whose name is `{vendor}_{general_concept}` (e.g., `google_campaign_id`, `ttd_line_id`).
- Accept an enum value naming an externally-defined system, format, or identifier space.
- Vendor names in **example blocks** (email addresses, sample IDs) are fine.
- When uncertain, ask: "Is this field or value representing *one vendor's version of something the protocol already has a general concept for*?" If yes, it belongs under `ext.{vendor}`.

## Breaking Changes

### What Constitutes a Breaking Change

**Major version bump required**:
- Removing enum values
- Renaming fields
- Changing field types
- Making optional fields required
- Removing fields entirely

**Minor version bump allowed**:
- Adding new enum values (append-only)
- Adding new optional fields
- Clarifying descriptions
- Adding new tasks/endpoints

### Migration Strategy

When making breaking changes:

1. **Create v2 directory**: `/schemas/v3/`
2. **Maintain v1**: Keep old schemas functional
3. **Document migration**: Provide before/after examples
4. **Deprecation period**: Support both versions for defined period

## Testing Schemas

All schema changes must:

1. ✅ Validate with JSON Schema Draft 07
2. ✅ Pass example data through validation
3. ✅ Generate types successfully (Python, TypeScript)
4. ✅ Update documentation to match
5. ✅ Include changeset describing the change

## Review Checklist

Before merging schema changes, verify:

- [ ] No duplicate enum names across different files
- [ ] No ambiguous field names (like bare "type")
- [ ] All enums referenced via `$ref`, not inline
- [ ] Breaking changes use proper versioning
- [ ] Documentation updated to match schemas
- [ ] Examples validate against new schemas
- [ ] Type generation tested
- [ ] Changeset created with proper version bump

## Philosophy

**"The schema is the spec"**

Documentation should reflect what's in schemas, but schemas are the source of truth. When documentation and schemas diverge, schemas win. This means:

- Write clear, detailed descriptions in schemas
- Use semantic names that are self-documenting
- Design for type generation, not just validation
- Think about developer ergonomics across languages

**"Make the right thing easy"**

Good schema design guides implementers toward correct usage:

- Use discriminators so type checkers catch mistakes
- Use semantic names so code reads clearly
- Consolidate enums so generators produce clean types
- Restrict where necessary, but don't over-restrict

## Questions?

When in doubt about schema design decisions:

1. Check existing patterns in `/schemas/v3/`
2. Consider impact on type generation
3. Ask: "Will this name collision cause issues?"
4. Prefer specificity over brevity
5. Document rationale in this file for future reference
