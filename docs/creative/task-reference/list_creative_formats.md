---
title: list_creative_formats
sidebar_position: 5
---

# list_creative_formats (Creative Agent)

Returns full specifications for all creative formats provided by this creative agent. This is the authoritative source for format definitions.

**Response Time**: ~1 second (simple database lookup)

**Request Schema**: [`/schemas/v1/creative/list-creative-formats-request.json`](/schemas/v1/creative/list-creative-formats-request.json)
**Response Schema**: [`/schemas/v1/creative/list-creative-formats-response.json`](/schemas/v1/creative/list-creative-formats-response.json)

## Authoritative Format Source

Each creative format has a single authoritative home - the creative agent that provides it. When buyers need full format specifications:

1. **Query sales agent** first to discover which creative agents are supported
2. **Query creative agent(s)** to get authoritative format definitions

Creative agents return complete format specifications including:
- Asset requirements
- Technical specifications
- Macro support
- Validation rules
- Preview capabilities

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by format type (e.g., `"audio"`, `"video"`, `"display"`, `"native"`, `"dooh"`) |
| `category` | string | No | Filter by category (`"standard"` or `"custom"`) |
| `standard_only` | boolean | No | Only return IAB/AdCP standard formats |
| `format_ids` | string[] | No | Filter by specific format IDs |

## Response Structure

```json
{
  "adcp_version": "1.6.0",
  "agent_url": "https://reference.adcp.org",
  "agent_name": "AdCP Reference Creative Agent",
  "capabilities": ["validation", "assembly", "preview"],
  "formats": [
    {
      "format_id": "video_standard_30s",
      "name": "Standard Video - 30 seconds",
      "type": "video",
      "category": "standard",
      "is_standard": true,
      "iab_specification": "https://iabtechlab.com/standards/video-ad-serving-template-vast/",
      "accepts_3p_tags": true,
      "supported_macros": ["MEDIA_BUY_ID", "CREATIVE_ID", "CACHEBUSTER", "DEVICE_TYPE"],
      "requirements": {
        "duration_seconds": 30,
        "max_file_size_mb": 50,
        "acceptable_formats": ["mp4", "mov", "webm"],
        "aspect_ratios": ["16:9", "9:16", "1:1"]
      },
      "assets_required": [
        {
          "asset_role": "video_file",
          "asset_type": "video",
          "required": true,
          "width": 1920,
          "height": 1080,
          "duration_seconds": 30
        }
      ]
    }
  ]
}
```

### Field Descriptions

- **agent_url**: Base URL for this creative agent (authoritative source for these formats)
- **agent_name**: Human-readable name for this creative agent
- **capabilities**: What this creative agent can do
  - `validation`: Can validate creatives against format specs
  - `assembly`: Can assemble creatives from assets
  - `generation`: Can generate creatives from prompts (AI/DCO)
  - `preview`: Can generate preview renderings
- **formats**: Array of complete format definitions
  - See [Format schema](/schemas/v1/core/format.json) for full specification

## Example: Standard AdCP Formats

Query the reference creative agent for standard formats:

```json
{
  "category": "standard"
}
```

Response:

```json
{
  "adcp_version": "1.6.0",
  "agent_url": "https://reference.adcp.org",
  "agent_name": "AdCP Reference Creative Agent",
  "capabilities": ["validation", "assembly", "preview"],
  "formats": [
    {
      "format_id": "video_standard_30s",
      "name": "Standard Video - 30 seconds",
      "type": "video",
      "category": "standard"
      // ... full format details
    },
    {
      "format_id": "display_300x250",
      "name": "Medium Rectangle Banner",
      "type": "display",
      "category": "standard"
      // ... full format details
    }
  ]
}
```

## Example: Custom DCO Formats

Query a custom DCO platform for their proprietary formats:

```json
{
  "category": "custom"
}
```

Response:

```json
{
  "adcp_version": "1.6.0",
  "agent_url": "https://dco.example.com",
  "agent_name": "Custom DCO Platform",
  "capabilities": ["validation", "assembly", "generation", "preview"],
  "formats": [
    {
      "format_id": "dco_responsive_multiformat",
      "name": "Responsive Multi-Format DCO",
      "type": "display",
      "category": "custom",
      "is_standard": false,
      "accepts_3p_tags": false,
      "requirements": {
        "dynamic_optimization": true,
        "ai_generation": true
      }
      // ... custom format details
    }
  ]
}
```

## Usage Workflow

1. **Buyer discovers formats** via sales agent: `list_creative_formats` on sales agent
2. **Sales agent returns**: format_ids + creative_agents list
3. **Buyer queries creative agent(s)**: `list_creative_formats` on each creative agent URL
4. **Creative agent returns**: Full authoritative format specifications
5. **Buyer uses formats**: Reference format specs when building/validating creatives

This two-tier model ensures:
- **Single source of truth**: Each format has one authoritative definition
- **Flexibility**: Sales agents can work with multiple creative agents
- **Clarity**: Buyers know exactly where to get format details
