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
Before creating any creative assets, you need to understand **what formats are available and required**. AdCP provides two complementary tools that work together:

#### The Discovery Workflow

**`get_products`** finds advertising inventory that matches your campaign needs and returns format IDs those products support. **`list_creative_formats`** provides full format specifications with detailed creative requirements.

#### Recursive Format Discovery

Sales agents can optionally reference creative agents that provide additional formats. This creates a recursive discovery pattern:

1. Call `list_creative_formats` on a sales agent
2. Receive full format definitions for formats the agent directly supports
3. Optionally receive a `creative_agents` array with URLs to other creative agents
4. Recursively call `list_creative_formats` on those creative agents to discover more formats
5. **Buyers must track visited URLs to avoid infinite loops**

Each format includes an `agent_url` field indicating its authoritative source.

**Note**: `list_creative_formats` does not require authentication, enabling public format discovery.

#### Two Common Approaches:

**1. Inventory-First** - "What products match my campaign, and what formats do they need?"
```javascript
// Find products for your campaign
const products = await get_products({
  brief: "Premium video inventory for sports fans",
  promoted_offering: "Nike Air Max 2024"
});
// Products return: format_ids: ["video_15s_hosted", "homepage_takeover_2024"]

// Get full creative specs (returns complete format objects, not just IDs)
const response = await list_creative_formats({});
const formatSpecs = response.formats.filter(f =>
  products.products.flatMap(p => p.format_ids).includes(f.format_id)
);
// Now you have full specs: video_15s_hosted needs MP4 H.264, 15s, 1920x1080
//                          homepage_takeover_2024 needs hero image + logo + headline

// Optionally discover formats from linked creative agents
if (response.creative_agents) {
  for (const agent of response.creative_agents) {
    const agentFormats = await list_creative_formats({ agent_url: agent.agent_url });
    formatSpecs.push(...agentFormats.formats);
  }
}
```

**2. Creative-First** - "What video formats does this publisher support?"
```javascript
// Browse all available formats (returns full format objects immediately)
const response = await list_creative_formats({
  type: "video",
  category: "standard"
});
// response.formats contains: full format objects for video_15s_hosted, video_30s_vast, etc.

// Recursively discover formats from creative agents if needed
const allFormats = [...response.formats];
if (response.creative_agents) {
  for (const agent of response.creative_agents) {
    const agentResponse = await list_creative_formats({
      agent_url: agent.agent_url,
      type: "video"
    });
    allFormats.push(...agentResponse.formats);
  }
}

// Find products supporting your creative capabilities
const products = await get_products({
  promoted_offering: "Nike Air Max 2024",
  filters: {
    format_ids: allFormats.map(f => f.format_id)
  }
});
```

#### Why Both Tools Matter

- **Without `list_creative_formats`**: Format IDs from products are opaque identifiers
- **Without `get_products`**: You don't know which formats actually have available inventory
- **Together**: You understand both what's available AND what's required to meet specifications

### Phase 2: Creative Production
Once you understand format requirements, create the actual creative assets according to the specifications discovered in Phase 1.

### Phase 3: Creative Library Management

AdCP uses a centralized creative library where assets are uploaded once and assigned to multiple campaigns. This industry-standard approach enables:

- Upload creatives to account-level library
- Assign library assets to specific campaigns/packages
- Reuse creatives across multiple media buys
- Track performance across all assignments
- Update metadata globally for all uses

**For complete details on library operations, organization, and best practices**, see [Creative Library](./creative-library.md).

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
- **[Creative Channel Guides](../../creative/channels/video)** - Format examples across video, display, audio, DOOH, and carousels
- **[Asset Types](../../creative/asset-types)** - Understanding asset roles and specifications