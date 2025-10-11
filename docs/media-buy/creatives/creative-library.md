---
title: Creative Library
---

# Creative Library

The AdCP Creative Library provides centralized management for all creative assets at the advertiser/account level. This industry-standard approach eliminates redundant uploads, enables creative reuse across campaigns, and provides better governance and performance tracking.

## Overview

Unlike the traditional model where creatives are uploaded directly to campaigns, AdCP's Creative Library follows the standard approach used by major ad platforms:

1. **Upload Once**: Creatives are uploaded to a central library
2. **Assign Many**: Library creatives can be assigned to multiple campaigns
3. **Manage Centrally**: All creative operations happen at the library level
4. **Track Globally**: Performance and compliance tracked across all uses

This approach mirrors how Google Ad Manager, Meta Business Manager, and other major platforms handle creative assets.

## Quick Start

Ready to start using the Creative Library? Here's the essential workflow:

1. **📤 Upload creatives**: [`sync_creatives`](../task-reference/sync_creatives) - Add assets to your library
2. **🔍 Find creatives**: [`list_creatives`](../task-reference/list_creatives) - Search and filter your library  
3. **🎯 Assign to campaigns**: Use assignments in [`sync_creatives`](../task-reference/sync_creatives) or [`create_media_buy`](../task-reference/create_media_buy)

**New to creative management?** Start with the [Creative Lifecycle](./index.md) conceptual overview.

## Library Architecture

### Creative Storage

All creatives are stored at the **advertiser/account level**, making them available for any media buy within that account. Each creative in the library has:

- **Unique Identity**: `creative_id` that remains consistent across all uses
- **Rich Metadata**: Name, tags, format information, compliance status
- **Assignment Tracking**: Real-time view of which campaigns use the creative
- **Performance History**: Aggregated metrics across all assignments

### Assignment Model

Creatives are **assigned** to specific packages within media buys rather than being uploaded directly:

```
Creative Library
    ├── Creative A (video_hero_30s)
    │   ├── Assigned to: Campaign 1, Package A
    │   └── Assigned to: Campaign 2, Package C
    │
    ├── Creative B (display_banner_300x250)
    │   └── Assigned to: Campaign 1, Package B
    │
    └── Creative C (audio_spot_15s)
        └── Unassigned (available for future use)
```

## Core Operations

The creative library supports two primary operations:

### 1. Creative Management

Use [`sync_creatives`](../task-reference/sync_creatives) to:
- Upload new creatives to the library
- Update existing creative metadata
- Assign creatives to packages
- Bulk operations with upsert semantics

**Benefits:**
- No immediate campaign assignment required
- Creative available for multiple future uses
- Validation and approval before assignment
- Suggested adaptations for better performance

**📋 Get Started:** See the [`sync_creatives`](../task-reference/sync_creatives) technical documentation for detailed examples and parameters.

### 2. Creative Discovery

Use [`list_creatives`](../task-reference/list_creatives) to:
- Search and filter library creatives
- Find available assets for new campaigns
- Track assignment status
- Analyze performance across creatives

**Use Cases:**
- Find creatives for new campaigns
- Audit unused assets
- Performance analysis across creatives
- Compliance reviews

**🔍 Get Started:** See the [`list_creatives`](../task-reference/list_creatives) technical documentation for advanced filtering and querying options.

### 3. Assign (`action: "assign"`)

Connect library creatives to campaign packages:

```json
{
  "action": "assign",
  "creative_ids": ["brand_video_30s", "brand_video_15s"],
  "media_buy_id": "mb_12345",
  "package_assignments": ["pkg_ctv_prime", "pkg_ctv_daytime"]
}
```

**Benefits:**
- Instant campaign setup with existing assets
- No re-upload or re-approval needed
- Flexible assignment to specific packages
- Bulk assignment operations

### 4. Update (`action: "update"`)

Modify creative metadata:

```json
{
  "action": "update",
  "creative_id": "brand_video_30s",
  "updates": {
    "click_url": "https://brand.com/spring-sale",
    "name": "Brand Hero Video 30s - Spring Sale"
  }
}
```

**Applies To:** All current and future assignments of the creative

### 5. Unassign (`action: "unassign"`)

Remove creative from specific campaigns while keeping in library:

```json
{
  "action": "unassign",
  "creative_ids": ["brand_video_30s"],
  "package_ids": ["pkg_ctv_prime"]
}
```

**Preserves:** Creative remains in library for future use

### 6. Archival

Creatives can be archived through [`sync_creatives`](../task-reference/sync_creatives) status updates:

**Options:**
- **Archive**: Soft delete, preserves for reporting
- **Delete**: Permanent removal (use with caution)

## Library Organization

### Naming Conventions

Use consistent `creative_id` patterns for better organization:

```
Format: {brand}_{type}_{duration/size}_{version}

Examples:
- nike_hero_video_30s_v1
- nike_display_banner_300x250_v2
- nike_audio_spot_15s_v1
```

### Tag Strategy

Organize creatives with meaningful tags:

**Campaign Tags:**
- `q1_2024`, `holiday_campaign`, `summer_sale`

**Format Tags:**
- `video`, `audio`, `display`, `mobile_optimized`

**Performance Tags:**
- `high_ctr`, `approved_creative`, `needs_optimization`

**Brand Tags:**
- `nike_air`, `nike_jordan`, `brand_logo`

### Status Management

Track creative lifecycle through status values:

- **`approved`**: Ready for campaign assignment
- **`pending_review`**: Uploaded, awaiting platform approval
- **`rejected`**: Failed validation, needs revision
- **`processing`**: Being transcoded or processed
- **`archived`**: Soft-deleted, preserved for reporting

## Platform Integration

### Google Ad Manager
- Maps to advertiser-level creative library
- Supports standard IAB creative formats
- Automatic policy compliance checking
- Creative approval typically within 24 hours

### Meta Business Manager
- Integrates with ad account creative library
- Supports video, image, and carousel formats
- Automatic optimization suggestions
- Real-time creative performance tracking

### Kevel
- Uses template-based creative system
- Supports custom creative formats
- Real-time creative decisioning
- Flexible creative assignment rules

### Triton Digital
- Station-level creative management
- Audio format specialization
- Broadcast compliance tracking
- Daypart-specific creative rotation

## Performance & Analytics

### Creative Performance Tracking

Library creatives accumulate performance data across all assignments:

```json
{
  "creative_id": "brand_video_30s",
  "performance_metrics": {
    "total_impressions": 1250000,
    "total_clicks": 15750,
    "average_ctr": 0.0126,
    "assignments": 3,
    "campaigns_used": 2
  }
}
```

### Cross-Campaign Analysis

Compare creative performance across different contexts:

- **Format Analysis**: Which video lengths perform best?
- **Campaign Context**: Does the same creative perform differently across campaigns?
- **Platform Optimization**: Which adaptations work best on each platform?
- **Audience Insights**: Creative performance by targeting dimension

## Best Practices

### Upload Strategy

1. **Upload Early**: Add creatives to library before campaign planning
2. **Version Control**: Use clear version numbers for creative iterations
3. **Format Planning**: Consider multiple formats (mobile, desktop, audio) during upload
4. **Tag Consistently**: Use standardized tagging for easy discovery

### Assignment Workflow

1. **Search First**: Check library for existing suitable creatives
2. **Bulk Assign**: Use batch operations for efficiency
3. **Monitor Performance**: Track how library creatives perform across campaigns
4. **Optimize Continuously**: Update click URLs and metadata based on performance

### Library Maintenance

1. **Regular Audits**: Review unused or underperforming creatives
2. **Archive Outdated**: Remove expired promotional creatives
3. **Performance Reviews**: Identify top-performing creatives for reuse
4. **Compliance Monitoring**: Ensure all creatives meet current policy requirements

### Creative Governance

1. **Approval Workflows**: Establish library upload approval processes
2. **Brand Guidelines**: Ensure all uploads meet brand standards
3. **Usage Tracking**: Monitor which creatives are being used where
4. **Performance Standards**: Set minimum performance thresholds

## Migration to Creative Library

If migrating from deprecated creative workflows:

### Step 1: Upload Existing Creatives
Use [`sync_creatives`](../task-reference/sync_creatives) to add assets to the library:
```json
{
  "creatives": [/* your existing creative assets */]
}
```

### Step 2: Assign to Current Campaigns
Use the `assignments` parameter in [`sync_creatives`](../task-reference/sync_creatives) or create new campaigns with [`create_media_buy`](../task-reference/create_media_buy).

### Step 3: Adopt Library Workflow
- Use [`list_creatives`](../task-reference/list_creatives) to search before creating new creatives
- Reuse approved creatives across campaigns
- Manage all creative operations through the library

## Troubleshooting

### Common Issues

**Creative Not Found**
- Verify `creative_id` exists in library
- Check creative status (may be archived)
- Ensure proper account-level access

**Assignment Failed**
- Verify media buy exists and is active
- Check package IDs are valid
- Ensure creative format matches package requirements

**Performance Discrepancies**
- Library metrics are aggregated across all assignments
- Use campaign-specific reporting for individual performance
- Consider assignment timing when analyzing performance

### Support Resources

- Use [`list_creatives`](../task-reference/list_creatives) to audit current library state
- Check creative status and assignment history
- Review platform-specific creative requirements
- Monitor adaptation suggestions for optimization opportunities

## Ready to Get Started?

Now that you understand the Creative Library architecture, here are your next steps:

### 🏗️ **Implementation**
- **Start uploading**: Follow [`sync_creatives`](../task-reference/sync_creatives) for technical implementation
- **Query your library**: Use [`list_creatives`](../task-reference/list_creatives) for advanced filtering and search
- **Understand the workflow**: Read [Creative Lifecycle](./index.md) for end-to-end process

### 📋 **Planning**
- **Review formats**: Check [Creative Formats](../../creative/formats) for platform requirements
- **Design your library**: Plan your creative ID conventions and tagging strategy
- **Map your workflow**: Align the library approach with your existing creative operations

### 🔗 **Integration**
- **Connect platforms**: Integrate with your existing creative management tools
- **Enable AI workflows**: Set up [MCP integration](../../protocols/mcp-guide) for AI assistant access
- **Build automations**: Leverage [A2A protocol](../../protocols/a2a-guide) for natural language operations

## Related Documentation

- [`sync_creatives`](../task-reference/sync_creatives) - Creative management API reference
- [`list_creatives`](../task-reference/list_creatives) - Creative query API reference
- [Creative Lifecycle](./index.md) - End-to-end creative workflow
- [Creative Formats](../../creative/formats) - Understanding format specifications and discovery