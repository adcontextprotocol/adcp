---
title: Creative Lifecycle
---

# Creative Lifecycle

AdCP provides a comprehensive set of tools for managing the entire lifecycle of creative assets within a media buy. This document explains the conceptual model and workflow for creative management.

## The Creative Model

A `Creative` is a simple object that links a user-defined ID to a specific format and the location of the asset.

Key components:
- **`creative_id`**: A unique, client-defined identifier for the creative
- **`format_id`**: The ID of the format the creative adheres to (must match formats supported by the products)
- **`content_uri`**: The URI pointing to the creative asset (e.g., VAST XML, image URL, or HTML5 ZIP)

For multi-asset formats (like carousels or sliders), creatives can include multiple assets with different types (images, text, logos).

## Creative Lifecycle Phases

### 1. Submission & Upload

Creatives are submitted using the [`add_creative_assets`](./tasks/add_creative_assets) task. This phase includes:

- Asset validation against format specifications
- Policy compliance checking
- Assignment to specific packages within the media buy
- Optional adaptation suggestions from the publisher

### 2. Review & Approval

The review process can be:

- **Automated**: For standard formats configured for auto-approval
- **Manual**: Human review for complex or non-standard creatives
- **Hybrid**: Automated validation followed by manual spot checks

Review outcomes include:
- **Approved**: Ready for delivery
- **Rejected**: Failed validation with feedback
- **Pending**: Still under review

### 3. Creative Management

After initial upload, creatives can be managed through various tasks:

- **Status Tracking**: Monitor approval status and delivery readiness
- **Creative Groups**: Organize creatives for reuse across campaigns
- **Performance Analysis**: Track creative effectiveness

### 4. Adaptation & Optimization

A key feature of AdCP is publisher-assisted creative adaptation:

- **Automatic Suggestions**: Publishers analyze uploaded creatives and suggest optimizations
- **Performance-Driven**: Adaptations include estimated performance improvements
- **Buyer Control**: All adaptations require explicit approval before use

Common adaptation types:
- Aspect ratio adjustments (16:9 → 9:16 for mobile)
- Duration optimization (30s → 15s or 6s)
- Format additions (adding captions for sound-off viewing)
- Platform-specific optimizations

## Creative Groups

Creative groups enable efficient management across campaigns:

- **Shared Assets**: Use the same creatives across multiple media buys
- **Rotation Rules**: Define how creatives rotate within a group
- **Performance Tracking**: Compare effectiveness across creatives

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

- [`add_creative_assets`](./tasks/add_creative_assets) - Upload and manage creatives
- [Creative Formats](./creative-formats) - Detailed format specifications
- [Asset Types](./asset-types) - Supported asset type reference