---
title: build_creative
sidebar_position: 13
---

# build_creative

Build creative content for a specific format using a creative agent that can generate either a creative manifest (static mode) or executable code (dynamic mode). This tool supports conversational refinement through a series of messages.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | The request message (initial brief or refinement instructions) |
| `format` | string or object | Yes* | Either format ID (string) for standard formats or full format definition (object) for custom formats (*Required for initial request) |
| `context_id` | string | No | Session context from previous message for continuity |
| `assets` | array | No | References to asset libraries and specific assets |
| `output_mode` | string | No | `"manifest"` for creative manifest or `"code"` for executable (default: `"manifest"`) |
| `preview_options` | object | No | Options for generating preview |
| `finalize` | boolean | No | Set to true to finalize the creative (default: false) |

### Message Examples

**Initial Request:**
- "Create a native ad for Yahoo promoting Purina Pro Plan. Focus on the veterinarian recommendation and that real salmon is the #1 ingredient. Use an informative and trustworthy tone."

**Refinement Messages:**
- "The colors look too green. Make them warmer and more inviting."
- "Add emphasis on the grain-free aspect"
- "Can you include a customer testimonial?"
- "Perfect! Let's finalize this version."

### Assets Structure

```typescript
{
  library_id: string;       // ID of the asset library
  asset_ids?: string[];     // Specific asset IDs to use
  tags?: string[];          // Tags to filter assets (e.g., ["july_us_sale"])
  filters?: object;         // Additional filters for asset selection
}
```

### Preview Options Structure

```typescript
{
  contexts?: Array<{        // Different contexts to preview
    name: string;
    user_data: object;
  }>;
  template_id?: string;     // Publisher template for custom formats
}
```

## Response Format

```json
{
  "message": "string",
  "context_id": "string",
  "status": "string",
  "creative_output": "object",
  "preview": "object",
  "refinement_suggestions": "array"
}
```

### Field Descriptions

- **message**: Agent's response describing what was created or changed
- **context_id**: Session identifier for conversation continuity
- **status**: `"draft"`, `"ready"`, or `"finalized"`
- **creative_output**: The creative manifest or code
- **preview**: Visual preview of how the creative will render
- **refinement_suggestions**: Suggested improvements from the agent

### Creative Output Formats

#### Manifest Mode (Static Creative)
```json
{
  "type": "creative_manifest",
  "format": "display_native",
  "assets": {
    "headline": "Premium Dog Nutrition",
    "description": "Veterinarian recommended formula with real salmon",
    "cta_text": "Learn More",
    "logo": {
      "url": "https://cdn.example.com/purina-logo.png",
      "width": 100,
      "height": 100
    },
    "hero_image": {
      "url": "https://cdn.example.com/salmon-formula.jpg",
      "width": 1200,
      "height": 627
    },
    "tracking_pixels": [
      "https://track.example.com/impression"
    ]
  },
  "metadata": {
    "advertiser": "Purina",
    "campaign": "Salmon Formula Launch",
    "created_at": "2024-02-15T10:00:00Z"
  }
}
```

#### Code Mode (Dynamic Creative)
```json
{
  "type": "creative_code",
  "format": "html5",
  "code": "<div id='adcp-creative'>\n  <script>\n    (function() {\n      // Dynamic creative logic\n      const context = window.ADCP_CONTEXT || {};\n      const assets = {\n        sunny: 'outdoor-dog.jpg',\n        rainy: 'indoor-cozy.jpg'\n      };\n      \n      // Select asset based on weather\n      const heroImage = assets[context.weather] || assets.sunny;\n      \n      // Render creative\n      document.getElementById('adcp-creative').innerHTML = `\n        <img src=\"${heroImage}\" />\n        <h2>${context.time === 'morning' ? 'Start Their Day Right' : 'Premium Nutrition'}</h2>\n        <button>Shop Now</button>\n      `;\n    })();\n  </script>\n</div>",
  "dependencies": {
    "context_required": ["weather", "time"],
    "fallback_provided": true
  }
}
```

### Preview Format

```json
{
  "preview_url": "https://preview.adcp.com/creative/ctx-123",
  "static_previews": [
    {
      "context": "default",
      "image_url": "https://preview.adcp.com/creative/ctx-123/default.png",
      "description": "Standard creative rendering"
    },
    {
      "context": "mobile",
      "image_url": "https://preview.adcp.com/creative/ctx-123/mobile.png",
      "description": "Mobile-optimized layout"
    }
  ],
  "interactive_preview": {
    "url": "https://preview.adcp.com/creative/ctx-123/interactive",
    "instructions": "Click to see different weather/time variations"
  }
}
```

## Examples

### Example 1: Building a Native Ad (Manifest Mode)

#### Initial Request
```json
{
  "message": "Create a native ad for Yahoo promoting Purina Pro Plan. Focus on the veterinarian recommendation and that real salmon is the #1 ingredient. Use an informative and trustworthy tone with 'Learn More' as the CTA.",
  "format": "display_native",
  "output_mode": "manifest",
  "assets": [
    {
      "library_id": "purina_assets",
      "tags": ["product_shots", "salmon_formula"]
    }
  ]
}
```

#### Response
```json
{
  "message": "I've created a native ad that emphasizes the veterinarian recommendation with your salmon product prominently featured. The layout follows Yahoo's native format guidelines.",
  "context_id": "ctx-native-789",
  "status": "draft",
  "creative_output": {
    "type": "creative_manifest",
    "format": "display_native",
    "assets": {
      "headline": "Veterinarian Recommended Nutrition",
      "description": "Pro Plan with real salmon as the #1 ingredient provides complete nutrition for your dog's sensitive skin and stomach.",
      "cta_text": "Learn More",
      "sponsor_name": "Purina Pro Plan",
      "logo": {
        "url": "https://cdn.purina.com/logos/proplan-square.png",
        "width": 50,
        "height": 50
      },
      "hero_image": {
        "url": "https://cdn.purina.com/products/salmon-formula-hero.jpg",
        "width": 1200,
        "height": 627,
        "alt": "Pro Plan Salmon Formula bag with happy dog"
      },
      "additional_images": [
        {
          "url": "https://cdn.purina.com/products/salmon-formula-badge.jpg",
          "width": 300,
          "height": 300,
          "alt": "Veterinarian Recommended badge"
        }
      ]
    }
  },
  "preview": {
    "static_previews": [
      {
        "context": "yahoo_desktop",
        "image_url": "https://preview.adcp.com/ctx-native-789/yahoo-desktop.png",
        "description": "How it appears in Yahoo feed on desktop"
      },
      {
        "context": "yahoo_mobile",
        "image_url": "https://preview.adcp.com/ctx-native-789/yahoo-mobile.png",
        "description": "Mobile Yahoo app rendering"
      }
    ]
  },
  "refinement_suggestions": [
    "Add urgency with limited-time offer",
    "Include customer testimonial",
    "Emphasize grain-free aspect"
  ]
}
```

#### Refinement Message 1
```json
{
  "message": "The colors look too green. Make them warmer and more inviting. Also emphasize the grain-free aspect.",
  "context_id": "ctx-native-789",
  "assets": [
    {
      "library_id": "purina_assets",
      "asset_ids": ["warm_lifestyle_photo_1"]
    }
  ]
}
```

#### Response
```json
{
  "message": "I've updated the creative with warmer tones using the lifestyle photo you selected. I've also added 'Grain-Free' as a prominent badge and updated the description to emphasize this benefit.",
  "context_id": "ctx-native-789",
  "status": "ready",
  "creative_output": {
    "type": "creative_manifest",
    "format": "display_native",
    "assets": {
      "headline": "Veterinarian Recommended Grain-Free Nutrition",
      "description": "Pro Plan's grain-free formula with real salmon as the #1 ingredient provides complete nutrition without grains that can upset sensitive stomachs.",
      "cta_text": "Learn More",
      "badges": ["Grain-Free", "Vet Recommended"],
      "hero_image": {
        "url": "https://cdn.purina.com/lifestyle/warm-dog-salmon.jpg",
        "width": 1200,
        "height": 627
      }
    }
  }
}
```

#### Refinement Message 2
```json
{
  "message": "This looks great! Can you add a small customer testimonial to build more trust?",
  "context_id": "ctx-native-789"
}
```

#### Final Response
```json
{
  "message": "I've added a concise customer testimonial that reinforces the veterinarian recommendation and grain-free benefits.",
  "context_id": "ctx-native-789",
  "status": "ready",
  "creative_output": {
    "type": "creative_manifest",
    "format": "display_native",
    "assets": {
      "headline": "Veterinarian Recommended Grain-Free Nutrition",
      "description": "Pro Plan's grain-free formula with real salmon as the #1 ingredient provides complete nutrition without grains that can upset sensitive stomachs.",
      "testimonial": "\"My vet recommended Pro Plan and my dog's digestion improved within days!\" - Sarah M.",
      "cta_text": "Learn More"
    }
  }
}
```

#### Finalize
```json
{
  "message": "Perfect! Let's finalize this version.",
  "context_id": "ctx-native-789",
  "finalize": true
}
```

### Example 2: Building Dynamic Video Creative (Code Mode)

#### Initial Conversation
```json
{
  "message": "I need a dynamic 30-second video for Purina that adapts based on viewer context. It should be upbeat and personalized, focusing on premium nutrition tailored for each dog's needs. The CTA should be 'Find Your Formula'.",
  "format": "video_standard_30s",
  "output_mode": "code",
  "assets": [
    {
      "library_id": "purina_video_library",
      "tags": ["lifestyle_scenes", "product_shots", "happy_dogs"]
    }
  ],
  "preview_options": {
    "contexts": [
      {
        "name": "Urban Morning",
        "user_data": {"location": "urban", "time": "morning", "weather": "sunny"}
      },
      {
        "name": "Suburban Evening", 
        "user_data": {"location": "suburban", "time": "evening", "weather": "rainy"}
      }
    ]
  }
}
```

#### Response
```json
{
  "message": "I've created a dynamic video creative that adapts based on location, time, and weather. The creative selects appropriate scenes and messaging for each context.",
  "context_id": "ctx-video-456",
  "status": "ready",
  "creative_output": {
    "type": "creative_code",
    "format": "vast_dynamic",
    "code": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<VAST version=\"4.2\">\n  <Ad id=\"purina-dynamic-30s\">\n    <InLine>\n      <AdSystem>ADCP Creative Agent</AdSystem>\n      <AdTitle>Purina Pro Plan - Dynamic</AdTitle>\n      <Creatives>\n        <Creative>\n          <Linear>\n            <Duration>00:00:30</Duration>\n            <MediaFiles>\n              <MediaFile delivery=\"progressive\" type=\"video/mp4\">\n                <![CDATA[\n                  https://creative-agent.adcp.com/render?id=ctx-video-456&context={{CONTEXT_PARAMS}}\n                ]]>\n              </MediaFile>\n            </MediaFiles>\n          </Linear>\n        </Creative>\n      </Creatives>\n    </InLine>\n  </Ad>\n</VAST>",
    "dependencies": {
      "render_endpoint": "https://creative-agent.adcp.com/render",
      "context_params": ["location", "time", "weather", "user_segment"],
      "fallback_url": "https://cdn.purina.com/video/generic-30s.mp4"
    }
  },
  "preview": {
    "interactive_preview": {
      "url": "https://preview.adcp.com/ctx-video-456/player",
      "instructions": "Use context selector to see different variations"
    },
    "static_previews": [
      {
        "context": "Urban Morning",
        "image_url": "https://preview.adcp.com/ctx-video-456/urban-morning-storyboard.png",
        "description": "City apartment scene, morning routine, small dog focus"
      },
      {
        "context": "Suburban Evening",
        "image_url": "https://preview.adcp.com/ctx-video-456/suburban-evening-storyboard.png",
        "description": "Backyard scene, family dinner time, large dog focus"
      }
    ]
  }
}
```

### Example 3: Conversational Flow for Custom Format

#### Message 1: Initial Brief
```json
{
  "message": "Create a TikTok Spark ad featuring user-generated content style. Keep it authentic and fun, focusing on real pet parents and their transformation stories. Use 'See Their Story' as the CTA.",
  "format": {
    "id": "custom_tiktok_spark",
    "name": "TikTok Spark Ad",
    "platform": "tiktok",
    "required_assets": [
      {"name": "video_url", "type": "video", "constraints": {"duration": "9-60s", "aspect_ratio": "9:16"}},
      {"name": "cover_image", "type": "image", "constraints": {"dimensions": "1080x1920"}},
      {"name": "caption", "type": "text", "constraints": {"max_length": 150}},
      {"name": "cta_text", "type": "text", "constraints": {"max_length": 20}}
    ]
  },
  "output_mode": "manifest",
  "preview_options": {
    "template_id": "tiktok_spark_preview_v2"
  }
}
```

#### Response
```json
{
  "message": "Created a TikTok Spark ad with UGC-style content. The preview shows how it will appear in the TikTok feed with engagement metrics.",
  "context_id": "ctx-tiktok-123",
  "status": "ready",
  "creative_output": {
    "type": "creative_manifest",
    "format": {
      "id": "custom_tiktok_spark",
      "name": "TikTok Spark Ad"
    },
    "assets": {
      "video_url": "https://cdn.purina.com/ugc/transformation-story.mp4",
      "cover_image": "https://cdn.purina.com/ugc/transformation-cover.jpg",
      "creator_handle": "@realpetparent",
      "creator_avatar": "https://cdn.purina.com/ugc/creator-avatar.jpg",
      "caption": "Can't believe the difference Pro Plan made! 🐕 #DogTransformation #PurinaPro",
      "music_track": "Happy - Pharrell Williams",
      "cta_text": "See Their Story",
      "engagement_stats": {
        "likes": "24.5K",
        "comments": "892",
        "shares": "1.2K"
      }
    }
  },
  "preview": {
    "template_preview": {
      "url": "https://preview.adcp.com/ctx-tiktok-123/tiktok-feed",
      "template_id": "tiktok_spark_preview_v2",
      "description": "Rendered using TikTok's Spark ad preview template"
    }
  }
}
```

## Usage Notes

- **Manifest Mode**: Returns structured data that can be used with any ad server
- **Code Mode**: Returns executable HTML/JS that handles its own rendering
- **Previews**: Always check previews to ensure creative meets expectations
- **Custom Formats**: Publishers should provide preview templates for non-standard formats
- **Conversations**: Use natural language messages to guide the creative process
- **Context**: The agent maintains context throughout the conversation
- **Flexibility**: Add assets or change direction at any point in the conversation
- **Asset Tags**: Leverage tags for efficient asset selection (e.g., seasonal campaigns)

## Implementation Guide

### Creative Manifest Assembly

```python
def build_creative_manifest(format_spec, brief, assets):
    manifest = {
        "type": "creative_manifest",
        "format": format_spec.id if isinstance(format_spec, str) else format_spec,
        "assets": {}
    }
    
    # Map required assets from format spec
    for required in format_spec.required_assets:
        if required.type == "text":
            manifest["assets"][required.name] = generate_text(
                brief, 
                required.constraints
            )
        elif required.type == "image":
            manifest["assets"][required.name] = select_image(
                assets,
                required.dimensions,
                brief.tone
            )
    
    return manifest
```

### Dynamic Code Generation

```python
def build_creative_code(format_spec, brief, assets):
    if format_spec.type == "video":
        return generate_vast_code(brief, assets)
    elif format_spec.type == "display":
        return generate_html5_code(brief, assets)
    else:
        return generate_custom_code(format_spec, brief, assets)
```

### Preview Generation

```python
def generate_preview(creative_output, preview_options):
    if creative_output.type == "creative_manifest":
        # Use publisher template or default renderer
        template = load_template(
            preview_options.template_id or 
            get_default_template(creative_output.format)
        )
        return template.render(creative_output.assets)
    else:
        # Execute code in sandboxed environment
        return sandbox_preview(creative_output.code, preview_options.contexts)
```

### Asset Library Integration with Tags

```python
def resolve_assets(asset_refs):
    assets = []
    
    for ref in asset_refs:
        library = get_library(ref.library_id)
        
        if ref.asset_ids:
            # Direct selection
            assets.extend(library.get_by_ids(ref.asset_ids))
        elif ref.tags:
            # Tag-based selection
            assets.extend(library.get_by_tags(ref.tags))
        elif ref.filters:
            # Apply custom filters
            assets.extend(library.filter(ref.filters))
    
    return assets
```