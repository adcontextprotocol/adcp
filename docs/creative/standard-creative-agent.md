---
title: Standard Creative Agent
sidebar_position: 3
---

# AdCP Standard Creative Agent

The AdCP Standard Creative Agent is the official creative agent implementation that provides support for all standard AdCP creative formats. This agent is maintained by the AdCP project and provides a baseline implementation for generating, validating, and previewing standard format creatives.

## Overview

All creative formats in AdCP are ultimately powered by creative agents. Even when a publisher defines custom formats, they are effectively providing creative agent functionality behind the scenes. The Standard Creative Agent centralizes support for industry-standard formats that work across all publishers.

### Key Responsibilities

The Standard Creative Agent handles:

1. **Format Discovery**: Provides `list_creative_formats` for all standard formats
2. **Creative Building**: Implements `build_creative` for standard format creation
3. **Preview Generation**: Implements `preview_creative` for format validation and testing
4. **Asset Library**: Manages `manage_creative_library` for standard format assets

## Standard Formats Supported

The Standard Creative Agent supports all formats defined in the [Standard Formats Registry](/schemas/v1/standard-formats/index.json):

### Display Formats
- Standard banner sizes (300x250, 728x90, 320x50, etc.)
- Native responsive ads
- Dynamic creative optimization (DCO) formats
- Mobile interstitials

### Video Formats
- Hosted video (15s, 30s)
- VAST-based video delivery
- Vertical video for mobile/stories
- Connected TV (CTV) formats
- Outstream and native video

### Audio Formats
- Standard audio ads
- Podcast insertions

### Rich Media Formats
- Interactive interstitials
- Expandable units

### Native Formats
- OpenRTB Native 1.2 compliant formats

### Retail/E-commerce Formats
- Product carousels
- Dynamic product feeds

### Foundational Formats
- Immersive canvas (works across 8+ publishers)
- Product carousel (works across 7+ publishers)
- Expandable display (works across 10+ publishers)
- Scroll-triggered experiences
- Universal video (15s and 30s)

## Sales Agent Integration

Sales agents should include the Standard Creative Agent by default to support standard formats:

### Default Configuration

```json
{
  "sales_agent": {
    "agent_id": "sales-example-publisher",
    "name": "Example Publisher Sales Agent",
    "creative_agents": [
      {
        "agent_id": "adcp-standard-creative",
        "url": "https://creative.adcontextprotocol.org/.well-known/adcp/creative",
        "name": "AdCP Standard Creative Agent",
        "supported_formats": ["standard"],
        "is_default": true
      }
    ]
  }
}
```

### Adding Custom Creative Agents

Publishers can supplement the Standard Creative Agent with their own:

```json
{
  "creative_agents": [
    {
      "agent_id": "adcp-standard-creative",
      "url": "https://creative.adcontextprotocol.org/.well-known/adcp/creative",
      "name": "AdCP Standard Creative Agent",
      "supported_formats": ["standard"],
      "is_default": true
    },
    {
      "agent_id": "publisher-custom-creative",
      "url": "https://publisher.example.com/.well-known/adcp/creative",
      "name": "Publisher Custom Formats",
      "supported_formats": [
        "publisher_premium_canvas",
        "publisher_interactive_video",
        "publisher_ar_experience"
      ],
      "is_default": false
    }
  ]
}
```

## Format Discovery

The Standard Creative Agent's `list_creative_formats` endpoint returns all standard formats:

### Request

```json
{
  "filters": {
    "format_types": ["video", "display"]
  }
}
```

### Response

```json
{
  "adcp_version": "1.0.0",
  "formats": [
    {
      "format_id": "video_30s_hosted",
      "name": "30-second Hosted Video",
      "type": "video",
      "description": "Standard 30-second video ad with hosted delivery",
      "duration": "30s",
      "assets_required": [
        {
          "asset_role": "video_file",
          "asset_type": "video",
          "required": true,
          "requirements": {
            "duration": "30s",
            "format": "MP4 H.264",
            "resolution": ["1920x1080", "1280x720"],
            "max_file_size": 50000000
          }
        }
      ],
      "accepts_3p_tags": false
    },
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle Banner",
      "type": "display",
      "description": "Standard 300x250 display banner",
      "dimensions": {
        "width": 300,
        "height": 250
      },
      "assets_required": [
        {
          "asset_role": "banner_image",
          "asset_type": "image",
          "required": true,
          "requirements": {
            "width": 300,
            "height": 250,
            "file_types": ["jpg", "png", "gif"],
            "max_file_size": 200000
          }
        }
      ],
      "accepts_3p_tags": true
    }
  ]
}
```

## Creative Building

The Standard Creative Agent implements conversational creative building:

### Example: Building a Standard Video Creative

```json
{
  "message": "Create a 30-second video ad for Purina Pro Plan featuring their salmon formula",
  "format_id": "video_30s_hosted",
  "output_mode": "manifest",
  "assets": [
    {
      "library_id": "purina_video_library",
      "tags": ["salmon_formula", "30s"]
    }
  ]
}
```

Response includes a creative manifest:

```json
{
  "message": "Created a 30-second video highlighting the salmon formula benefits",
  "context_id": "ctx-video-789",
  "status": "ready",
  "creative_output": {
    "type": "creative_manifest",
    "format_id": "video_30s_hosted",
    "assets": {
      "video_file": {
        "url": "https://cdn.purina.com/video/salmon-30s-v1.mp4",
        "width": 1920,
        "height": 1080,
        "mime_type": "video/mp4",
        "file_size": 45000000
      }
    },
    "metadata": {
      "advertiser": "Purina",
      "campaign": "Salmon Formula Launch",
      "duration": 30
    }
  }
}
```

## Preview Generation

The Standard Creative Agent provides robust preview capabilities for all formats:

### Example: Previewing a Display Ad

```json
{
  "format_id": "display_300x250",
  "creative_manifest": {
    "format_id": "display_300x250",
    "assets": {
      "banner_image": {
        "url": "https://cdn.example.com/banner-300x250.jpg",
        "width": 300,
        "height": 250
      }
    }
  },
  "macro_values": {
    "CLICK_URL": "https://example.com/landing",
    "CACHE_BUSTER": "12345"
  }
}
```

Response includes preview links:

```json
{
  "adcp_version": "1.0.0",
  "preview_url": "https://creative.adcontextprotocol.org/preview/abc123",
  "static_previews": [
    {
      "context": "default",
      "image_url": "https://creative.adcontextprotocol.org/preview/abc123/static.png",
      "description": "Standard rendering of 300x250 banner",
      "dimensions": {
        "width": 300,
        "height": 250
      }
    }
  ],
  "interactive_url": "https://creative.adcontextprotocol.org/preview/abc123/interactive",
  "expires_at": "2025-02-16T10:00:00Z",
  "macro_values_used": {
    "CLICK_URL": "https://example.com/landing",
    "CACHE_BUSTER": "12345"
  }
}
```

## Format Extensions

Publishers can extend standard formats while maintaining compatibility:

### Declaring Extensions

A publisher might extend the standard video format:

```json
{
  "format_id": "publisher_premium_video_30s",
  "extends": "video_30s_hosted",
  "publisher": "example_publisher",
  "modifications": {
    "additional_assets": {
      "brand_safety_card": {
        "asset_role": "end_card",
        "asset_type": "image",
        "required": false,
        "requirements": {
          "width": 1920,
          "height": 1080,
          "duration_on_screen": "5s"
        }
      }
    },
    "placement_requirements": {
      "viewability_threshold": "70% for 2s",
      "autoplay": false
    }
  }
}
```

### Compatibility

Creatives built for standard formats work with all extensions:
- A `video_30s_hosted` creative works for `publisher_premium_video_30s`
- Extensions can add optional assets but must not break core requirements
- Standard Creative Agent validates compatibility

## Asset Library Management

The Standard Creative Agent provides asset library capabilities:

### Adding Assets

```json
{
  "action": "add",
  "assets": [
    {
      "creative_id": "video-salmon-30s-v1",
      "name": "Salmon Formula 30s Video",
      "format": "video_30s_hosted",
      "media_url": "https://cdn.purina.com/video/salmon-30s.mp4",
      "tags": ["salmon_formula", "30s", "premium"],
      "duration": 30000,
      "width": 1920,
      "height": 1080
    }
  ]
}
```

### Searching Assets

```json
{
  "format_ids": ["video_30s_hosted", "video_15s_hosted"],
  "tags": ["salmon_formula"],
  "limit": 10
}
```

## Implementation Details

### Format Validation

The Standard Creative Agent validates:
1. **Asset Requirements**: All required assets are present
2. **Asset Specifications**: Assets meet format requirements (dimensions, file size, etc.)
3. **Macro Support**: Proper macro handling for tracking and personalization
4. **Delivery Methods**: Support for hosted, VAST, and other delivery mechanisms

### Macro Support

The Standard Creative Agent implements the full AdCP Universal Macro system:
- Privacy & Compliance (GDPR, CCPA, etc.)
- Device & Environment
- Geographic
- Identity
- Contextual
- Temporal

### Preview Rendering

Preview generation uses:
1. **Template Engine**: Renders formats using standard templates
2. **Asset Assembly**: Combines assets according to format specifications
3. **Macro Substitution**: Replaces macros with provided or default values
4. **Screenshot Generation**: Creates static preview images
5. **Interactive Previews**: Provides live rendering for testing

## Best Practices

### For Publishers

1. **Include by Default**: Always include the Standard Creative Agent in your sales agent configuration
2. **Extend, Don't Replace**: Extend standard formats rather than creating entirely custom ones
3. **Document Extensions**: Clearly document any modifications to standard formats
4. **Test Compatibility**: Ensure standard creatives work with your extensions

### For Buyers

1. **Start with Standard**: Use standard formats whenever possible for maximum reach
2. **Test Previews**: Always preview creatives before finalizing campaigns
3. **Provide Context**: Use preview contexts to test different scenarios
4. **Validate Macros**: Ensure macro substitution works correctly

### For Creative Agents

1. **Follow Standards**: Implement all standard formats consistently
2. **Validate Thoroughly**: Check asset requirements and format compliance
3. **Generate Quality Previews**: Provide accurate rendering previews
4. **Support Extensions**: Handle publisher extensions gracefully
5. **Document Capabilities**: Clearly communicate supported formats and features

## Future Enhancements

Planned improvements to the Standard Creative Agent:

1. **AI-Powered Generation**: Automated creative generation from briefs
2. **Brand Safety**: Automated brand safety checks and validation
3. **Performance Optimization**: Asset optimization for faster delivery
4. **Advanced Previews**: 3D rendering, AR/VR format support
5. **Collaborative Editing**: Multi-user creative development workflows

## Resources

- [Standard Formats Registry](/schemas/v1/standard-formats/index.json)
- [preview_creative Task Reference](./task-reference/preview_creative.md)
- [build_creative Task Reference](./task-reference/build_creative.md)
- [Creative Formats Documentation](../media-buy/capability-discovery/creative-formats.md)
