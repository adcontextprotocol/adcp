---
title: manage_creative_assets
sidebar_position: 4
---

# manage_creative_assets

Comprehensive creative asset management for the centralized creative library. This unified endpoint handles all creative lifecycle operations from upload to assignment and deletion.

**Request Schema**: [`/schemas/v1/media-buy/manage-creative-assets-request.json`](/schemas/v1/media-buy/manage-creative-assets-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/manage-creative-assets-response.json`](/schemas/v1/media-buy/manage-creative-assets-response.json)

## Overview

The `manage_creative_assets` task provides a centralized approach to creative management that aligns with industry standards. Creatives are uploaded to a central library at the advertiser/account level, then assigned to specific media buys as needed. This eliminates redundant uploads and enables better creative governance.

## Request Parameters

### Common Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | Operation to perform: `upload`, `list`, `update`, `assign`, `unassign`, `delete` |
| `adcp_version` | string | No | AdCP schema version (default: "1.0.0") |

### Action-Specific Parameters

Parameters vary based on the `action` specified:

#### Upload Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `assets` | Asset[] | Yes | Array of creative assets to upload to library |

#### List Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filters` | object | No | Filter criteria for querying creatives |
| `pagination` | object | No | Pagination parameters |

#### Update Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creative_id` | string | Yes | ID of creative to update |
| `updates` | object | Yes | Fields to update |

#### Assign Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creative_ids` | string[] | Yes | Creative IDs to assign |
| `media_buy_id` | string | No* | Publisher's media buy ID |
| `buyer_ref` | string | No* | Buyer's media buy reference |
| `package_assignments` | string[] | Yes | Package IDs to assign creatives to |

*Either `media_buy_id` or `buyer_ref` must be provided for assign action

#### Unassign Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creative_ids` | string[] | Yes | Creative IDs to unassign |
| `package_ids` | string[] | No | Specific packages to unassign from (if omitted, unassigns from all) |

#### Delete Action
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creative_ids` | string[] | Yes | Creative IDs to delete |
| `archive` | boolean | No | Whether to archive (soft delete) vs permanently delete (default: true) |

## Asset Object (for Upload Action)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `creative_id` | string | Yes | Unique identifier for the creative |
| `name` | string | Yes | Human-readable creative name |
| `format` | string | Yes | Creative format type (e.g., `"video"`, `"audio"`, `"display"`) |
| `media_url` | string | Yes | URL of the creative file |
| `click_url` | string | No | Landing page URL for the creative |
| `duration` | number | No | Duration in milliseconds (for video/audio) |
| `width` | number | No | Width in pixels (for video/display) |
| `height` | number | No | Height in pixels (for video/display) |
| `assets` | SubAsset[] | No | For multi-asset formats like carousels |

## Response Structure

The response structure adapts based on the action performed:

### Upload Response
```json
{
  "message": "Successfully uploaded 2 creatives to library",
  "uploaded_assets": [
    {
      "creative_id": "hero_video_30s",
      "status": "approved",
      "platform_id": "lib_creative_789",
      "suggested_adaptations": [...]
    }
  ]
}
```

### List Response
```json
{
  "message": "Found 15 creatives matching criteria",
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "name": "Nike Air Max Hero 30s",
      "format": "video",
      "status": "approved",
      "created_date": "2024-01-15T10:30:00Z",
      "assignments": ["pkg_ctv_001", "pkg_mobile_002"]
    }
  ],
  "pagination": {
    "total": 15,
    "limit": 10,
    "offset": 0,
    "has_more": true
  }
}
```

### Assign Response
```json
{
  "message": "Successfully assigned 2 creatives to 3 packages",
  "assignments": [
    {
      "creative_id": "hero_video_30s",
      "assigned_packages": ["pkg_ctv_001", "pkg_ctv_002"],
      "assignment_status": "active"
    }
  ]
}
```

## Detailed Examples

### Example 1: Upload Creatives to Library

Upload new creatives to the central library without immediate campaign assignment.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "upload",
    "assets": [
      {
        "creative_id": "nike_hero_30s_v1",
        "name": "Nike Air Max Hero 30s",
        "format": "video",
        "media_url": "https://cdn.nike.com/creatives/hero-30s.mp4",
        "click_url": "https://nike.com/airmax",
        "duration": 30000,
        "width": 1920,
        "height": 1080
      },
      {
        "creative_id": "nike_hero_15s_v1",
        "name": "Nike Air Max Hero 15s",
        "format": "video", 
        "media_url": "https://cdn.nike.com/creatives/hero-15s.mp4",
        "click_url": "https://nike.com/airmax",
        "duration": 15000,
        "width": 1920,
        "height": 1080
      }
    ]
  }
}
```

#### Response
```json
{
  "message": "Successfully uploaded 2 creatives to your library. Both videos have been approved and are ready for campaign assignment. I've also identified opportunities for mobile optimization.",
  "uploaded_assets": [
    {
      "creative_id": "nike_hero_30s_v1",
      "status": "approved",
      "platform_id": "lib_creative_001",
      "review_feedback": "Passed all policy checks",
      "suggested_adaptations": [
        {
          "adaptation_id": "adapt_mobile_vertical",
          "format_id": "video_vertical_9x16",
          "name": "Nike Hero Mobile Vertical",
          "description": "9:16 version optimized for mobile feeds",
          "estimated_performance_lift": 35
        }
      ]
    },
    {
      "creative_id": "nike_hero_15s_v1", 
      "status": "approved",
      "platform_id": "lib_creative_002",
      "review_feedback": "Approved for all placements",
      "suggested_adaptations": []
    }
  ]
}
```

### Example 2: List Library Creatives

Query creatives in the library with filtering and pagination.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "list",
    "filters": {
      "format": "video",
      "status": "approved",
      "created_after": "2024-01-01",
      "name_contains": "nike"
    },
    "pagination": {
      "limit": 10,
      "offset": 0
    }
  }
}
```

#### Response
```json
{
  "message": "Found 3 Nike video creatives in your approved library",
  "creatives": [
    {
      "creative_id": "nike_hero_30s_v1",
      "name": "Nike Air Max Hero 30s",
      "format": "video",
      "status": "approved",
      "platform_id": "lib_creative_001",
      "created_date": "2024-01-15T10:30:00Z",
      "duration": 30000,
      "width": 1920,
      "height": 1080,
      "click_url": "https://nike.com/airmax",
      "assignments": ["pkg_ctv_001", "pkg_ctv_prime"]
    },
    {
      "creative_id": "nike_hero_15s_v1",
      "name": "Nike Air Max Hero 15s", 
      "format": "video",
      "status": "approved",
      "platform_id": "lib_creative_002",
      "created_date": "2024-01-15T10:30:00Z",
      "duration": 15000,
      "assignments": ["pkg_ctv_midroll"]
    }
  ],
  "pagination": {
    "total": 3,
    "limit": 10,
    "offset": 0,
    "has_more": false
  }
}
```

### Example 3: Assign Creatives to Media Buy

Assign existing library creatives to specific packages within a media buy.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "assign",
    "creative_ids": ["nike_hero_30s_v1", "nike_hero_15s_v1"],
    "media_buy_id": "mb_12345",
    "package_assignments": ["pkg_ctv_prime", "pkg_ctv_midroll"]
  }
}
```

#### Response
```json
{
  "message": "Successfully assigned Nike creatives to your CTV campaign. The 30s version will run in prime time slots, and the 15s version will serve during mid-roll breaks.",
  "assignments": [
    {
      "creative_id": "nike_hero_30s_v1",
      "assigned_packages": ["pkg_ctv_prime"],
      "assignment_status": "active",
      "estimated_impressions": 125000
    },
    {
      "creative_id": "nike_hero_15s_v1",
      "assigned_packages": ["pkg_ctv_midroll"],
      "assignment_status": "active",
      "estimated_impressions": 87500
    }
  ]
}
```

### Example 4: Update Creative Metadata

Update creative information without re-uploading the asset.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "update",
    "creative_id": "nike_hero_30s_v1",
    "updates": {
      "name": "Nike Air Max Hero 30s - Holiday Sale",
      "click_url": "https://nike.com/airmax-holiday-sale"
    }
  }
}
```

#### Response
```json
{
  "message": "Successfully updated creative metadata. The new click URL will be used for all future impressions.",
  "updated_creative": {
    "creative_id": "nike_hero_30s_v1",
    "name": "Nike Air Max Hero 30s - Holiday Sale",
    "click_url": "https://nike.com/airmax-holiday-sale",
    "last_updated": "2024-01-20T14:15:00Z"
  }
}
```

### Example 5: Unassign Creatives

Remove creative assignments from specific packages while keeping them in the library.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "unassign",
    "creative_ids": ["nike_hero_30s_v1"],
    "package_ids": ["pkg_ctv_prime"]
  }
}
```

#### Response
```json
{
  "message": "Removed Nike Hero 30s from prime time CTV package. Creative remains available in your library for future campaigns.",
  "unassignments": [
    {
      "creative_id": "nike_hero_30s_v1",
      "removed_from_packages": ["pkg_ctv_prime"],
      "remaining_assignments": ["pkg_ctv_midroll"]
    }
  ]
}
```

### Example 6: Archive Creatives

Remove creatives from active use while preserving them for historical reference.

#### Request
```json
{
  "tool": "manage_creative_assets",
  "arguments": {
    "action": "delete",
    "creative_ids": ["old_creative_v1", "expired_promo_v2"],
    "archive": true
  }
}
```

#### Response
```json
{
  "message": "Archived 2 creatives. They've been removed from active campaigns but preserved for reporting and compliance.",
  "deleted_assets": [
    {
      "creative_id": "old_creative_v1",
      "status": "archived",
      "archived_date": "2024-01-20T15:30:00Z"
    },
    {
      "creative_id": "expired_promo_v2",
      "status": "archived", 
      "archived_date": "2024-01-20T15:30:00Z"
    }
  ]
}
```

## Filter Options (List Action)

When using the `list` action, you can filter creatives using these criteria:

| Filter | Type | Description |
|--------|------|-------------|
| `format` | string | Creative format (video, audio, display, etc.) |
| `status` | string | Creative status (approved, pending_review, rejected, archived) |
| `created_after` | string | ISO date string for minimum creation date |
| `created_before` | string | ISO date string for maximum creation date |
| `name_contains` | string | Search within creative names |
| `assigned_to_package` | string | Show creatives assigned to specific package |
| `unassigned` | boolean | Show only unassigned creatives if true |

## Creative Status Values

| Status | Description |
|--------|-------------|
| `approved` | Ready for campaign assignment and delivery |
| `pending_review` | Uploaded and awaiting platform approval |
| `rejected` | Failed policy review or technical validation |
| `processing` | Being transcoded or processed |
| `archived` | Soft-deleted, preserved for historical reference |

## Best Practices

### Library Organization
- Use consistent naming conventions for creative IDs
- Include version numbers for creative iterations
- Organize by campaign, brand, or time period

### Upload Strategy
- Upload creatives to library before campaign launch
- Consider suggested adaptations for better performance
- Plan for multiple formats (mobile, desktop, audio, video)

### Assignment Workflow
1. Upload creatives to central library
2. Review and approve all assets
3. Assign to specific media buy packages as needed
4. Monitor performance and iterate

### Lifecycle Management
- Regularly review and archive old creatives
- Update click URLs for seasonal campaigns
- Track creative performance across assignments

## Platform Considerations

Different ad platforms handle creative libraries differently:

- **Google Ad Manager**: Supports advertiser-level creative libraries
- **Kevel**: Template-based creative management
- **Meta**: Ad account level creative library with reuse
- **Triton Digital**: Station-level creative management

The AdCP abstraction provides a unified interface regardless of underlying platform implementation.

## Migration from add_creative_assets

If you're currently using the deprecated `add_creative_assets` task:

1. **Upload First**: Use `action: "upload"` to add creatives to library
2. **Then Assign**: Use `action: "assign"` to connect creatives to media buys
3. **Manage Centrally**: Use other actions for ongoing creative management

This new workflow eliminates redundant uploads and provides better creative governance.

## Related Documentation

- [Creative Library](../creative-library.md) - Centralized creative management concepts
- [Creative Lifecycle](../creative-lifecycle.md) - End-to-end creative workflow
- [Creative Formats](../creative-formats.md) - Supported format specifications