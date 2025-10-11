---
title: list_creative_formats
sidebar_position: 5
---

# list_creative_formats

Returns full specifications for all creative formats provided by this creative agent.

**Response Time**: ~1 second (simple database lookup)

**Authentication**: None required - this endpoint must be publicly accessible for format discovery

**Request Schema**: [`/schemas/v1/creative/list-creative-formats-request.json`](/schemas/v1/creative/list-creative-formats-request.json)
**Response Schema**: [`/schemas/v1/creative/list-creative-formats-response.json`](/schemas/v1/creative/list-creative-formats-response.json)

## Recursive Discovery Model

Creative agents use the same response format as sales agents:
1. **formats**: Full format definitions for formats they own/support
2. **creative_agents** (optional): URLs to other creative agents providing additional formats

Each format includes an **agent_url** field indicating its authoritative source.

Buyers can recursively query creative_agents to discover all available formats. **Buyers must track visited URLs to avoid infinite loops.**

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `format_ids` | string[] | No | Return only these specific format IDs |
| `type` | string | No | Filter by format type: `"audio"`, `"video"`, `"display"`, `"dooh"` (technical categories with distinct requirements) |
| `asset_types` | string[] | No | Filter to formats that include these asset types. For third-party tags, search for `["html"]` or `["javascript"]`. E.g., `["image", "text"]` returns formats with images and text, `["javascript"]` returns formats accepting JavaScript tags. Values: `image`, `video`, `audio`, `text`, `html`, `javascript`, `url` |
| `dimensions` | string | No | Filter to formats with specific dimensions (e.g., `"300x250"`, `"728x90"`). Combine with `asset_types` to find specific sizes like "300x250 JavaScript" |
| `name_search` | string | No | Search for formats by name (case-insensitive partial match, e.g., `"mobile"` or `"vertical"`) |

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

## Example 1: Find Formats by Asset Types

"I have images and text - what formats can I build?"

```json
{
  "asset_types": ["image", "text"]
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
      "format_id": "display_300x250",
      "agent_url": "https://reference.adcp.org",
      "name": "Medium Rectangle",
      "type": "display",
      "accepts_3p_tags": false,
      "assets_required": [
        {
          "asset_type": "image",
          "asset_role": "hero_image",
          "required": true
        },
        {
          "asset_type": "text",
          "asset_role": "headline",
          "required": true
        }
      ]
    }
  ]
}
```

## Example 2: Find Formats for Third-Party HTML Tags

"I have 728x90 HTML tags - which of your formats support them?"

```json
{
  "asset_types": ["html"],
  "dimensions": "728x90"
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
      "format_id": "display_728x90_3p",
      "agent_url": "https://dco.example.com",
      "name": "Leaderboard - Third Party",
      "type": "display",
      "dimensions": "728x90",
      "assets_required": [
        {
          "asset_id": "tag",
          "asset_type": "html",
          "asset_role": "third_party_tag",
          "required": true,
          "requirements": {
            "width": 728,
            "height": 90,
            "max_file_size_kb": 200
          }
        }
      ]
    }
  ]
}
```

## Example 3: Search by Name

"Show me your vertical or mobile formats"

```json
{
  "name_search": "vertical"
}
```

Response returns all formats with "vertical" in the name.

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
