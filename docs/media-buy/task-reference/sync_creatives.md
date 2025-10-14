---
title: sync_creatives
---

# sync_creatives

Synchronize creative assets with the centralized creative library using upsert semantics. This task supports bulk operations, partial updates, assignment management, and comprehensive validation for efficient creative library management.

**Response Time**: Instant to days (returns `completed`, `working` < 120s, or `submitted` for hours/days)

## Overview

The `sync_creatives` task provides a powerful, efficient approach to creative library management using **upsert semantics** - creatives are either created (if they don't exist) or updated (if they do exist) based on their `creative_id`. This eliminates the need to check existence before uploading and enables seamless bulk operations.

**Key Features:**
- **Bulk Operations**: Process up to 100 creatives per request
- **Upsert Semantics**: Automatic create-or-update behavior
- **Patch Mode**: Update only specified fields while preserving others
- **Assignment Management**: Bulk assign creatives to packages in the same request
- **Validation Modes**: Choose between strict (fail-fast) or lenient (process-valid) validation
- **Dry Run**: Preview changes before applying them
- **Generative Creatives**: Submit brand manifest and generation prompts for AI or human-created creatives
- **Comprehensive Reporting**: Detailed results for each creative processed

## Request Parameters

### Core Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `adcp_version` | string | No | AdCP schema version (default: "1.5.0") |
| `creatives` | array | Yes | Array of creative assets to sync (max 100) |
| `patch` | boolean | No | Partial update mode (default: false) |
| `dry_run` | boolean | No | Preview changes without applying (default: false) |
| `validation_mode` | enum | No | Validation strictness: "strict" or "lenient" (default: "strict") |
| `push_notification_config` | PushNotificationConfig | No | Optional webhook for async sync notifications (see Webhook Configuration below) |

### Assignment Management

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `assignments` | object | No | Bulk creative-to-package assignments |
| `delete_missing` | boolean | No | Archive creatives not in this sync (default: false) |

### Creative Asset Structure

Each creative in the `creatives` array follows the [Creative Asset schema](/schemas/v1/core/creative-asset.json) with support for:

**Hosted Assets:**
- `creative_id`, `name`, `format` (required)
- `media_url` (required for hosted assets)
- `click_url`, `width`, `height`, `duration`, `tags` (optional)

**Third-Party Assets:**  
- `creative_id`, `name`, `format` (required)
- `snippet`, `snippet_type` (required for third-party assets)
- `click_url`, `width`, `height`, `duration`, `tags` (optional)

**Native Ad Templates:**
- `creative_id`, `name`, `format_id` (required)
- `snippet` (HTML template with variables like `[%Headline%]`)
- `snippet_type: "html"`
- `assets` array with sub-assets for template variables

**Generative Creatives:**
- `creative_id`, `name`, `format_id` (required - references a generative format)
- `assets` object with `promoted_offerings` and `generation_prompt`
- Publisher creates the creative (AI or human - buyer may not know the implementation method)
- Response includes `preview_url` when ready for review
- Note: Some buyers may care about creation method for brand safety or compliance reasons

## Webhook Configuration (Task-Specific)

For large bulk operations or creative approval workflows, you can provide a task-specific webhook to be notified when the sync completes:

```json
{
  "creatives": [/* up to 100 creatives */],
  "push_notification_config": {
    "url": "https://buyer.com/webhooks/creative-sync",
    "authentication": {
      "schemes": ["HMAC-SHA256"],
      "credentials": "shared_secret_32_chars"
    }
  }
}
```

**When webhooks are sent:**
- Bulk sync takes longer than ~120 seconds (status: `working` → `completed`)
- Creative approval required (status: `submitted` → `completed`)
- Large creative uploads processing asynchronously

**Webhook payload:**
- Complete sync_creatives response with summary and results
- Includes action taken for each creative (created/updated/unchanged/failed)

See [Webhook Security](../../protocols/core-concepts.md#security) for authentication details.

## Response Format

The response provides comprehensive details about the sync operation:

```json
{
  "adcp_version": "1.5.0",
  "message": "Sync completed: 3 created, 2 updated, 1 unchanged",
  "context_id": "ctx_sync_123456",
  "dry_run": false,
  "summary": {
    "total_processed": 6,
    "created": 3,
    "updated": 2, 
    "unchanged": 1,
    "failed": 0,
    "deleted": 0
  },
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "action": "created",
      "platform_id": "plt_123456"
    }
  ]
}
```

## Generative Creative Workflow

For generative formats, buyers submit a creative manifest (brand information + generation instructions) rather than finished assets. The publisher then creates the creative - either through AI generation, human designers, or a hybrid approach.

**Key Characteristics:**

1. **Implementation Agnostic**: Buyer submits the same request whether the publisher uses AI, human designers, or both
2. **Async by Default**: Response time ranges from seconds (AI) to days (human review)
3. **Preview-First**: Publisher returns `preview_url` for buyer approval before campaign launch
4. **Simple Approval**: Set `approved: true` to finalize or `approved: false` with updated `generation_prompt` to request changes
5. **Conversational Refinement**: Use `context_id` from response to continue the conversation

**Note on Transparency:** Some buyers may care about creation method (AI vs human) for brand safety, compliance, or quality reasons. Publishers should communicate their approach during format discovery or setup.

**Protocol Context**: The `context_id` is managed at the protocol level (automatic in A2A, manual in MCP) and is not part of the task request parameters. See [Context Management](../../protocols/context-management.md) for details.

**Workflow Steps:**

```
1. Buyer submits creative with promoted_offerings + generation_prompt
2. Publisher responds with status: "submitted" or "working"
3. Publisher creates creative (AI/human/hybrid)
4. Publisher responds with status: "completed" + preview_url
5. Buyer reviews preview:
   - Approve: Re-submit with approved: true
   - Refine: Re-submit with approved: false + updated generation_prompt
```

**Example Generative Formats:**
- `premium_bespoke_display` - Custom-designed display ad (human designer, 24-48h)
- `ai_native_responsive` - AI-generated native ad (automated, under 60s)
- `hybrid_video_30s` - AI draft + human polish (hybrid, 2-4h)

The format definition specifies expected turnaround time, but the buyer's workflow is identical regardless of implementation.

## Usage Examples

### Example 1: Full Sync with New Creatives

Upload new creatives with automatic assignment:

```json
{
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "name": "Brand Hero Video 30s",
      "format": "video_30s_vast",
      "snippet": "https://vast.example.com/video/123",
      "snippet_type": "vast_url",
      "click_url": "https://example.com/products",
      "duration": 30000,
      "tags": ["q1_2024", "video", "hero"]
    },
    {
      "creative_id": "banner_300x250",
      "name": "Standard Banner",
      "format": "display_300x250",
      "media_url": "https://cdn.example.com/banner.jpg",
      "click_url": "https://example.com/products",
      "width": 300,
      "height": 250,
      "tags": ["q1_2024", "display"]
    }
  ],
  "assignments": {
    "hero_video_30s": ["pkg_ctv_001", "pkg_ctv_002"],
    "banner_300x250": ["pkg_display_001"]
  }
}
```

### Example 2: Patch Update - Click URLs Only

Update click URLs without affecting other creative properties:

```json
{
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "click_url": "https://example.com/new-landing-page"
    },
    {
      "creative_id": "banner_300x250", 
      "click_url": "https://example.com/new-promo"
    }
  ],
  "patch": true
}
```

### Example 3: Native Ad Template Upload

Upload a native ad template with variable substitution:

```json
{
  "creatives": [
    {
      "creative_id": "native_sponsored_post",
      "name": "Sponsored Social Post",
      "format": "display_native_sponsored_post",
      "snippet": "<div class='sponsored-post'><h2>[%Headline%]</h2><p>[%BodyText%]</p><img src='[%ImageUrl%]' alt='[%ImageAlt%]'></div>",
      "snippet_type": "html",
      "click_url": "https://example.com/native-landing",
      "assets": [
        {
          "asset_id": "headline_var",
          "type": "text",
          "content": "Discover Our New Product Line"
        },
        {
          "asset_id": "body_var", 
          "type": "text",
          "content": "Innovative solutions for modern challenges"
        },
        {
          "asset_id": "image_var",
          "type": "image",
          "media_uri": "https://cdn.example.com/native-hero.jpg"
        }
      ],
      "tags": ["native", "sponsored_content"]
    }
  ]
}
```

### Example 4: Generative Creative Submission

Submit a creative manifest for publisher to create (AI or human):

**Request:**
```json
{
  "creatives": [
    {
      "creative_id": "holiday_hero_display",
      "name": "Holiday Campaign Hero Display",
      "format_id": {
        "agent_url": "https://publisher.com/.well-known/adcp/sales",
        "id": "premium_bespoke_display"
      },
      "assets": {
        "promoted_offerings": {
          "asset_type": "promoted_offerings",
          "url": "https://retailer.com",
          "colors": {
            "primary": "#C41E3A",
            "secondary": "#165B33",
            "accent": "#FFD700"
          },
          "tone": "Warm, festive, family-oriented"
        },
        "generation_prompt": {
          "asset_type": "text",
          "content": "Create a holiday campaign featuring our winter collection. Emphasize warmth, family togetherness, and quality. Include subtle holiday elements without being overtly religious."
        }
      },
      "tags": ["holiday", "q4_2024", "hero"]
    }
  ]
}
```

**Note:** The `url` field in the `promoted_offerings` asset represents the advertiser's brand or product website (e.g., `https://retailer.com`), not a reference to a cached manifest. Publishers can use this URL to gather additional brand context if needed.

**Initial Response (Async):**
```json
{
  "status": "submitted",
  "message": "Creative submitted for creation",
  "context_id": "ctx_abc123",
  "creatives": [
    {
      "creative_id": "holiday_hero_display",
      "action": "created",
      "platform_id": "pub_creative_789"
    }
  ]
}
```

**Later Response (When Ready):**
```json
{
  "status": "completed",
  "message": "Creative ready for review",
  "context_id": "ctx_abc123",
  "creatives": [
    {
      "creative_id": "holiday_hero_display",
      "action": "created",
      "platform_id": "pub_creative_789",
      "preview_url": "https://publisher.com/preview/pub_creative_789",
      "expires_at": "2024-12-20T00:00:00Z"
    }
  ]
}
```

**Approval (Buyer likes it):**
```json
{
  "creatives": [
    {
      "creative_id": "holiday_hero_display",
      "approved": true
    }
  ]
}
```

**Or Request Changes (Buyer wants refinement):**
```json
{
  "creatives": [
    {
      "creative_id": "holiday_hero_display",
      "approved": false,
      "assets": {
        "generation_prompt": {
          "asset_type": "text",
          "content": "Make the colors more vibrant and emphasize the sale pricing more prominently"
        }
      }
    }
  ]
}
```

_Note: Conversational context is maintained automatically by the protocol layer - no explicit `context_id` parameter is needed in requests._

The buyer may not know if this creative was generated by AI in 20 seconds or designed by a human team over 2 days. The workflow is identical either way, though publishers should communicate their approach for buyers who care about creation method.

### Example 5: Dry Run Preview

Preview changes before applying them:

```json
{
  "creatives": [
    {
      "creative_id": "test_banner",
      "name": "Test Banner Creative",
      "format": "display_300x250",
      "media_url": "https://cdn.example.com/test-banner.jpg"
    }
  ],
  "dry_run": true,
  "validation_mode": "lenient"
}
```

### Example 6: Library Replacement (Advanced)

Replace entire creative library with new set (use with extreme caution):

```json
{
  "creatives": [
    // ... all creatives that should exist in the library
  ],
  "delete_missing": true,
  "validation_mode": "strict"
}
```

## Operational Modes

### Patch vs Full Upsert

**Full Upsert Mode (default):**
- Replaces the entire creative with provided data
- Missing optional fields are cleared/reset to defaults
- Use when you want to ensure complete creative definition

**Patch Mode (`patch: true`):**
- Updates only the fields specified in the request
- Preserves existing values for unspecified fields  
- Use for selective updates (e.g., updating click URLs only)

### Validation Modes  

**Strict Mode (default):**
- Entire sync operation fails if any creative has validation errors
- Ensures data consistency and integrity
- Use for production uploads where quality is critical

**Lenient Mode:**
- Processes valid creatives and reports errors for invalid ones
- Allows partial success in bulk operations
- Use for large imports where some failures are acceptable

## Error Handling

### Validation Errors

Common validation scenarios and their handling:

```json
{
  "results": [
    {
      "creative_id": "invalid_creative",
      "action": "failed",
      "errors": [
        "Missing required field: format",
        "Invalid snippet_type: must be one of [vast_xml, vast_url, html, javascript, iframe, daast_url]"
      ]
    }
  ]
}
```

### Assignment Errors

When assignments fail, they're reported within each creative's result:

```json
{
  "creatives": [
    {
      "creative_id": "hero_video_30s",
      "action": "updated",
      "assigned_to": ["pkg_ctv_001"],
      "assignment_errors": {
        "pkg_invalid_123": "Package not found or access denied"
      }
    }
  ]
}
```

## Best Practices

### 1. Batch Size Management
- Stay within 100 creatives per request limit
- For large libraries, break into multiple sync requests
- Consider rate limiting to avoid overwhelming the platform

### 2. Validation Strategy
- Use `dry_run: true` to preview changes for large updates
- Start with `validation_mode: "strict"` to catch data quality issues
- Switch to `lenient` mode for large imports with expected failures

### 3. Creative ID Strategy
- Use consistent, meaningful creative ID conventions
- Include format hints in IDs (e.g., `hero_video_30s`, `banner_300x250`)
- Avoid special characters that might cause URL encoding issues

### 4. Assignment Management
- Group related package assignments in single requests
- Use assignment bulk operations for efficiency
- Monitor assignment results for failed package assignments

### 5. Error Recovery
- Implement retry logic for transient failures
- Parse detailed error responses to identify data quality issues
- Use patch mode for correcting specific field errors

## Migration from Legacy Creative Tasks

The `sync_creatives` task replaces previous action-based creative management approaches:

**Old Approach:**
```json
{
  "action": "upload",
  "creatives": [...]
}
```

**New Approach:**
```json
{
  "creatives": [...] // Automatic upsert behavior
}
```

**Key Changes:**
- No `action` parameter needed - upsert behavior is automatic
- Bulk operations are the default, not an add-on
- Assignment management integrated into sync operation
- More granular control with patch mode and validation modes

## Platform Considerations

### Google Ad Manager
- Requires policy compliance review for new creatives
- Supports standard IAB formats with automatic format validation
- Creative approval typically within 24 hours

### Kevel  
- Supports custom creative formats and templates
- Real-time creative decisioning capabilities
- Flexible template-based native ad support

### Triton Digital
- Audio-specific platform with specialized format requirements
- Station-level creative targeting capabilities
- Supports DAAST and standard audio ad formats

## Related Tasks

- [`list_creatives`](./list_creatives) - Query creative library with filtering and search
- [`create_media_buy`](./create_media_buy) - Create campaigns that use library creatives
- [`list_creative_formats`](./list_creative_formats) - Discover supported creative formats

---

*The sync_creatives task provides the foundation for efficient creative library management in AdCP, enabling bulk operations and flexible update patterns while maintaining data quality and consistency.*