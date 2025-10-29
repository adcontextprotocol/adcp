---
title: Release Notes
description: Major release highlights and migration guides for AdCP
keywords: [releases, what's new, migration guide, breaking changes]
sidebar_position: 10
---

# Release Notes

High-level summaries of major AdCP releases with migration guidance. For detailed technical changelogs, see [CHANGELOG.md](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md).

---

## Version 2.3.0

**Released:** October 2025 | [Full Changelog](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md#230)

### What's New

**Publisher-Owned Property Definitions** - Properties are now owned by publishers and referenced by agents, following the IAB Tech Lab sellers.json model. This eliminates duplication and creates a single source of truth for property information.

**Placement Targeting** - Products can now define multiple placements (e.g., homepage banner, article sidebar), and buyers can assign different creatives to each placement within a product purchase.

**Simplified Budgets** - Budget is now only specified at the package level, enabling mixed-currency campaigns and eliminating redundant aggregation at the media buy level.

### Migration Guide

#### Publisher-Owned Properties

**Before:**
```json
{
  "properties": [{
    "publisher_domain": "cnn.com",
    "property_name": "CNN CTV App",
    "property_tags": ["ctv", "premium"]
  }]
}
```

**After:**
```json
{
  "publisher_properties": [
    {
      "publisher_domain": "cnn.com",
      "property_tags": ["ctv"]
    }
  ]
}
```

Buyers now fetch property definitions from `https://cnn.com/.well-known/adagents.json`.

#### Remove Media Buy Budget

**Before:**
```json
{
  "budget": 50000,
  "packages": [...]
}
```

**After:**
```json
{
  "packages": [
    {"package_id": "p1", "budget": 30000},
    {"package_id": "p2", "budget": 20000}
  ]
}
```

Budget is specified per package only.

### Breaking Changes

- `properties` field in products → `publisher_properties`
- `list_authorized_properties` returns `publisher_domains` array
- Removed `budget` from create_media_buy/update_media_buy requests

---

## Version 2.2.0

**Released:** October 2025 | [Full Changelog](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md#220)

### What's New

**Build Creative Alignment** - The `build_creative` task now follows a clear "manifest-in → manifest-out" transformation model with consistent parameter naming.

### Migration Guide

**Before:**
```json
{
  "source_manifest": {...},
  "promoted_offerings": [...]
}
```

**After:**
```json
{
  "creative_manifest": {
    "format_id": {...},
    "assets": {
      "promoted_offerings": [...]
    }
  }
}
```

### Breaking Changes

- `build_creative` parameter renamed: `source_manifest` → `creative_manifest`
- Removed `promoted_offerings` as top-level parameter (now in manifest assets)

---

## Version 2.1.0

**Released:** January 2025 | [Full Changelog](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md#210)

### What's New

**Simplified Asset Schema** - Separated asset payload schemas from format requirement schemas, eliminating redundancy. Asset types are now determined by format specifications rather than declared in manifests.

### Migration Guide

**Before:**
```json
{
  "assets": {
    "banner_image": {
      "asset_type": "image",
      "url": "https://cdn.example.com/banner.jpg",
      "width": 300,
      "height": 250
    }
  }
}
```

**After:**
```json
{
  "assets": {
    "banner_image": {
      "url": "https://cdn.example.com/banner.jpg",
      "width": 300,
      "height": 250
    }
  }
}
```

### Breaking Changes

- Removed `asset_type` field from creative manifest payloads
- Schema paths changed: `/creative/asset-types/*.json` → `/core/assets/*-asset.json`
- Constraint fields moved from asset payloads to format specifications

---

## Version 2.0.0

**Released:** October 2025 | [Full Changelog](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md#200)

### What's New

First production release of the Advertising Context Protocol with:

- **8 Media Buy Tasks** - Complete workflow from product discovery to delivery reporting
- **3 Creative Tasks** - AI-powered creative generation and management
- **2 Signals Tasks** - First-party data integration
- **Standard Formats** - Industry-standard display, video, and native formats
- **Multi-Protocol Support** - Works with MCP, A2A, and REST

### Core Features

- Natural language product discovery with brief-based targeting
- Asynchronous task management with human-in-the-loop approvals
- JSON Schema validation for all requests and responses
- Publisher-owned property definitions via `.well-known/adagents.json`
- Comprehensive format specifications with asset requirements

---

## Versioning Policy

AdCP follows [Semantic Versioning 2.0.0](https://semver.org/):

- **PATCH (x.x.N)** - Bug fixes, documentation, clarifications
- **MINOR (x.N.0)** - New features, backward-compatible additions
- **MAJOR (N.0.0)** - Breaking changes

### Deprecation Process

Breaking changes follow a 6-month deprecation cycle:

1. **Deprecation Notice** - Feature marked deprecated in minor release
2. **Transition Period** - Minimum 6 months support with warnings
3. **Migration Guide** - Detailed upgrade path provided
4. **Breaking Change** - Removed in next major version

---

## Additional Resources

- **Technical Changelog** - [CHANGELOG.md](https://github.com/adcontextprotocol/adcp/blob/main/CHANGELOG.md)
- **GitHub Releases** - [Release Archive](https://github.com/adcontextprotocol/adcp/releases)
- **Community** - [Slack](https://join.slack.com/t/agenticads/shared_invite/zt-3c5sxvdjk-x0rVmLB3OFHVUp~WutVWZg)
- **Issues** - [GitHub Issues](https://github.com/adcontextprotocol/adcp/issues)
- **Support** - support@adcontextprotocol.org
