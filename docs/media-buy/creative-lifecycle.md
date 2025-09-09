---
title: Creative Lifecycle
---

# Creative Lifecycle

AdCP provides a comprehensive centralized creative library for managing the entire lifecycle of creative assets. This document explains the conceptual model and workflow for creative management using the centralized library approach.

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

For multi-asset formats, creatives can include multiple sub-assets with different types:

**Carousel/Slider Formats:**
- Multiple images, headlines, and descriptions for rotating content

**Native Ad Templates:**
- HTML template with placeholder variables (e.g., `[%Headline%]`, `%ImageUrl%`)
- Variable content provided via sub-assets (headline, body_text, product_image, etc.)
- Template validation ensures all required variables are provided

## Creative Lifecycle Phases

### 1. Library Upload

Creatives are uploaded to the centralized library using the [`sync_creatives`](./tasks/sync_creatives) task with **upsert semantics** - creatives are automatically created or updated based on their `creative_id`. AdCP supports multiple creative types:

**Creative Types Supported:**
- **Hosted assets** - Traditional media files (images, videos, audio)
- **Third-party snippets** - VAST, HTML, JavaScript tags
- **Native ad templates** - HTML templates with variable substitution

**Upload Process Includes:**
- Upload to centralized library (no immediate campaign assignment required)
- Asset validation against format specifications
- Third-party snippet validation and security review
- Native template variable validation (ensures all required variables are provided)
- Policy compliance checking
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

Ongoing creative management through the new streamlined tasks:

- **Library Querying**: Use [`list_creatives`](./tasks/list_creatives) to search and filter library creatives with advanced filtering
- **Metadata Updates**: Use [`sync_creatives`](./tasks/sync_creatives) with `patch: true` to modify specific fields like names, click URLs, and tags
- **Bulk Operations**: Process up to 100 creatives per sync request for efficient large-scale updates
- **Assignment Tracking**: Monitor which campaigns are using each creative through enriched query responses
- **Performance Analysis**: Track creative effectiveness across all assignments with optional performance data inclusion
- **Validation Modes**: Choose between strict (fail-fast) or lenient (process-valid) validation for bulk operations

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

## Best Practices

1. **Format Planning**: Review supported formats before creative production
2. **Early Upload**: Submit creatives well before campaign launch
3. **Adaptation Acceptance**: Consider publisher suggestions for better performance
4. **Asset Organization**: Use clear naming conventions for creative IDs
5. **Performance Monitoring**: Track creative effectiveness and iterate

## Related Documentation

- [`sync_creatives`](./tasks/sync_creatives) - Bulk creative management with upsert semantics
- [`list_creatives`](./tasks/list_creatives) - Advanced creative library querying and filtering  
- [Creative Library](./creative-library) - Centralized creative management concepts
- [Creative Formats](./creative-formats) - Detailed format specifications
- [`manage_creative_assets` (Deprecated)](./tasks/manage_creative_assets) - Legacy action-based creative management
- [`add_creative_assets` (Deprecated)](./tasks/add_creative_assets) - Legacy creative upload endpoint