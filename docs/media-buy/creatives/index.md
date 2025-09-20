---
title: Creative Lifecycle
description: Manage creative assets throughout their lifecycle from format discovery to asset synchronization and library management.
keywords: [creative management, creative assets, creative formats, asset library, creative lifecycle]
---

# Creative Lifecycle

Creative management is central to successful media buying campaigns. AdCP manages the complete creative lifecycle from initial format discovery through ongoing optimization, providing comprehensive tools for managing creative assets throughout their entire lifecycle.

## Overview

AdCP's creative management system handles:

- **Format specifications** for all supported creative types
- **Asset lifecycle management** from creation to optimization
- **Cross-platform synchronization** of creative libraries
- **Standard format support** for consistent delivery

## Key Creative Tasks

### Creative Synchronization
Use [`sync_creatives`](../task-reference/sync_creatives) to upload and manage creative assets in the centralized library. This ensures your creatives are available across all platforms and campaigns.

### Creative Library Management  
Use [`list_creatives`](../task-reference/list_creatives) to view and manage your creative asset library, including status tracking and performance metadata.

## The Three Main Phases

AdCP manages creatives through three main phases:

### Phase 1: Format Discovery
Before creating any creative assets, you need to understand **what formats are required**. AdCP provides two complementary tools that work together:

#### The Discovery Workflow

**`get_products`** finds advertising inventory that matches your campaign needs, while **`list_creative_formats`** provides the detailed creative specifications for the formats those products require.

#### Two Common Approaches:

**1. Inventory-First** - "What products match my campaign?"
```javascript
// Find products for your campaign
const products = await get_products({
  brief: "Premium video inventory for sports fans",
  promoted_offering: "Nike Air Max 2024"
});
// Products return: formats: ["video_15s_hosted", "homepage_takeover_2024"]

// Get creative specs for those specific formats
const formatSpecs = await list_creative_formats({
  format_ids: products.products.flatMap(p => p.formats)
});
// Now you know: video_15s_hosted needs MP4 H.264, 15s, 1920x1080
//                homepage_takeover_2024 needs hero image + logo + headline
```

**2. Creative-First** - "What video formats does this publisher support?"
```javascript
// Browse available video formats
const videoFormats = await list_creative_formats({
  type: "video",
  category: "standard"
});
// Returns: video_15s_hosted, video_30s_vast, video_vertical_15s, etc.

// Find products supporting your creative capabilities
const products = await get_products({
  promoted_offering: "Nike Air Max 2024",
  filters: {
    format_ids: ["video_15s_hosted", "video_30s_vast"]
  }
});
// Returns only products that accept these specific formats
```

#### Why Both Tools Matter

- **Without `list_creative_formats`**: Format IDs from products are meaningless strings
- **Without `get_products`**: You don't know which formats actually have available inventory
- **Together**: You understand both what's available AND what's required

### Phase 2: Creative Production
Once you understand format requirements, create the actual creative assets according to the specifications discovered in Phase 1.

### Phase 3: Creative Library Management
Manage assets through the centralized creative library system.

## The Creative Library Model

AdCP uses a **centralized creative library** that aligns with industry standards. Creatives are uploaded to a central library at the advertiser/account level, then assigned to specific media buys as needed. This approach eliminates redundant uploads and enables better creative governance.

### Creative Object Structure

A `Creative` in the library contains:

**Core Properties:**
- **`creative_id`**: A unique, client-defined identifier for the creative
- **`name`**: Human-readable creative name for organization
- **`format`**: Creative format type (e.g., video, audio, display)
- **`media_url`**: URL pointing to the creative asset file (for hosted assets)
- **`snippet`**: Third-party tag, VAST XML, or code snippet (for third-party assets)
- **`snippet_type`**: Type of snippet content (vast_xml, vast_url, html, javascript, iframe, daast_url)

**Metadata:**
- **`click_url`**: Landing page URL for the creative
- **`tags`**: User-defined tags for organization and searchability
- **`created_date`**: When the creative was uploaded to the library
- **`status`**: Current approval status (approved, pending_review, rejected, archived)

**Assignment Tracking:**
- **`assignments`**: Current package/media buy assignments
- **`assignment_count`**: Number of active assignments

## Creative Lifecycle Phases

### 1. Library Upload

Creatives are uploaded to the centralized library using the [`sync_creatives`](../task-reference/sync_creatives) task. This library-first approach allows creatives to be uploaded once and reused across multiple campaigns. AdCP supports multiple creative types:

**Creative Types:**
- **Hosted assets** - Traditional media files (images, videos, audio)
- **Third-party snippets** - VAST, HTML, JavaScript tags
- **Native ad templates** - HTML templates with variable substitution

**Upload Process:**
- Upload to centralized library with automatic upsert behavior
- Asset validation and policy compliance checking
- Optional adaptation suggestions from the publisher
- Library storage with metadata for future reuse

### 2. Review & Approval

The review process can be:

- **Automated**: For standard formats configured for auto-approval
- **Manual**: Human review for complex or non-standard creatives
- **Hybrid**: Automated validation followed by manual spot checks

Review outcomes include:
- **Approved**: Ready for delivery
- **Rejected**: Failed validation with feedback
- **Pending**: Still under review

### 3. Campaign Assignment

Once creatives are approved in the library, they can be assigned to specific media buys and packages:

- **Bulk Assignment**: Use the `assignments` parameter in `sync_creatives` to assign multiple creatives to packages
- **Reuse Across Campaigns**: Same creative can be assigned to multiple media buys
- **Selective Assignment**: Choose specific packages within a media buy for each creative
- **Dynamic Management**: Add or remove assignments without re-uploading assets
- **Combined Operations**: Upload and assign creatives in a single request for efficiency

### 4. Library Management

Ongoing creative management is handled through two core tasks:

- **Library Querying**: Use [`list_creatives`](../task-reference/list_creatives) to search, filter, and discover creative assets
- **Asset Updates**: Use [`sync_creatives`](../task-reference/sync_creatives) to update creative metadata, assignments, and content
- **Assignment Tracking**: Monitor which campaigns are using each creative
- **Performance Analysis**: Track creative effectiveness across all assignments

### 5. Adaptation & Optimization

A key feature of AdCP is publisher-assisted creative adaptation:

- **Automatic Suggestions**: Publishers analyze uploaded creatives and suggest optimizations
- **Performance-Driven**: Adaptations include estimated performance improvements
- **Buyer Control**: All adaptations require explicit approval before use

Common adaptation types:
- Aspect ratio adjustments (16:9 → 9:16 for mobile)
- Duration optimization (30s → 15s or 6s)
- Format additions (adding captions for sound-off viewing)
- Platform-specific optimizations

## Creative Library Benefits

The centralized library naturally enables efficient creative management:

- **Shared Assets**: Library creatives can be assigned to multiple media buys simultaneously
- **Tag-Based Organization**: Use tags to group related creatives (e.g., "holiday_2024", "video_ads", "mobile_optimized")
- **Search & Discovery**: Query library by format, status, tags, or assignment status
- **Performance Comparison**: Track effectiveness across all assignments for each creative
- **Efficient Updates**: Modify click URLs or metadata once, applies to all assignments

## Platform Considerations

Different platforms have varying creative requirements:

### Google Ad Manager
- Supports standard IAB formats
- Requires policy compliance review
- Creative approval typically within 24 hours

### Kevel
- Supports custom template-based creatives
- Real-time creative decisioning
- Flexible format support

### Triton Digital
- Audio-specific platform
- Supports standard audio formats
- Station-level creative targeting

## Response Times

Creative operations have varying response times:
- **Format listings**: ~1 second (database lookup)
- **Creative sync**: Minutes to days (asset processing and approval)
- **Library queries**: ~1 second (database lookup)

## Best Practices

1. **Format Planning**: Review supported formats before creative production
2. **Early Upload**: Submit creatives well before campaign launch
3. **Adaptation Acceptance**: Consider publisher suggestions for better performance
4. **Asset Organization**: Use clear naming conventions for creative IDs
5. **Performance Monitoring**: Track creative effectiveness and iterate
6. **Quality Control**: Follow format specifications exactly
7. **File Optimization**: Optimize file sizes for fast loading
8. **Testing**: Test assets across different devices and platforms

## Related Documentation

- **[`sync_creatives`](../task-reference/sync_creatives)** - Bulk creative management with upsert semantics
- **[`list_creatives`](../task-reference/list_creatives)** - Advanced creative library querying and filtering  
- **[`list_creative_formats`](../task-reference/list_creative_formats)** - Understanding format requirements
- **[Creative Library](./creative-library)** - Centralized creative management concepts
- **[Creative Formats](../capability-discovery/creative-formats)** - Detailed format specifications
- **[Standard Formats Guide](./standard-formats-guide)** - Pre-defined formats that work across publishers
- **[Asset Types](./asset-types)** - Understanding asset roles and specifications