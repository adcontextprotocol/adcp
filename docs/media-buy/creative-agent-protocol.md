# Creative Agent Protocol

A unified protocol for calibrating creative agents that can either generate static assets or run as live creative servers.

## Overview

The creative agent protocol enables two primary use cases:

1. **Creative Manifest Generation**: Build a creative manifest containing all assets, text, and metadata needed for traditional ad serving
2. **Dynamic Code Generation**: Generate executable HTML/JS code that renders creatives dynamically at runtime

Both modes use the same creative building workflow, differing only in the output format.

## Core Concepts

### Creative Building Process

The creative building process involves:
- Providing a creative brief
- Referencing assets from libraries (by ID or tags)
- Choosing output mode (manifest vs code)
- Iterating based on feedback

### Output Modes

1. **Manifest Mode**: Returns a structured creative manifest with all assets and metadata
2. **Code Mode**: Returns executable code (HTML/JS) that renders the creative dynamically

### Asset Library
Advertisers maintain a library of reusable assets that can be combined to create creatives:
- Brand assets (logos, colors, fonts)
- Stock imagery and video clips
- Audio tracks and voiceovers
- Templates and layouts
- Text components (headlines, CTAs)

### Creative Formats
Each format defines:
- Technical specifications (dimensions, duration, file size)
- Required and optional asset types
- Composition rules and constraints
- Output options (static assets vs dynamic ad tags)

### Output Types

1. **Creative Manifest**: Structured data containing all creative elements
   - Assets (images, videos, logos) with URLs
   - Text content (headlines, descriptions, CTAs)
   - Metadata and tracking pixels
   - Can be rendered by any ad server

2. **Executable Code**: Self-contained HTML/JavaScript
   - Handles its own rendering logic
   - Supports real-time personalization
   - Includes fallback mechanisms
   - Best for dynamic campaigns

## Real-Time Inference

### The Evolution of Dynamic Creative

The advertising industry is moving beyond simple template-based personalization to true real-time creative generation. Companies like OpenAds and Connected Stories are pioneering this approach, where creative decisions are made at the moment of ad request based on:

- **User Context**: Location, device, time, weather, browsing behavior
- **Campaign Performance**: What's working right now across different segments
- **Inventory Characteristics**: The specific placement and surrounding content
- **Business Logic**: Pricing, inventory levels, promotional calendars

### How Real-Time Inference Works

When deployed as a live agent, the creative agent performs inference at request time:

1. **Context Ingestion** (~10ms)
   - Receive user and placement context
   - Parse real-time signals (weather, stock levels, etc.)
   - Load user segment data

2. **Creative Decision** (~20ms)
   - Apply trained model to select optimal creative approach
   - Choose assets, messaging, and layout
   - Personalize content based on context

3. **Dynamic Assembly** (~20ms)
   - Compose creative from selected elements
   - Apply brand guidelines and safety checks
   - Generate final creative output

4. **Delivery** (~10ms)
   - Return VAST, HTML5, or native format
   - Include impression tracking
   - Cache for similar requests

Total latency: ~60ms (well within industry standards)

### Advantages of Real-Time Inference

1. **True Personalization**: Every impression can be unique
2. **Instant Optimization**: Apply learnings immediately 
3. **Context Awareness**: React to real-world events as they happen
4. **Inventory Efficiency**: Match creative to specific placements
5. **Business Integration**: Reflect real-time inventory, pricing, or promotions

### Example: Weather-Responsive Creative

```json
{
  "user_context": {
    "location": "Chicago",
    "weather": "snowing",
    "temperature": 28,
    "time": "evening"
  },
  "inference_result": {
    "creative_strategy": "comfort_warmth",
    "hero_image": "dog_by_fireplace_v3",
    "headline": "Keep Your Best Friend Cozy",
    "cta": "Shop Winter Nutrition",
    "color_palette": "warm_amber"
  }
}
```

### Industry Examples

Companies leading in real-time creative inference:

- **OpenAds**: Programmatic creative optimization platform using ML models
- **Connected Stories**: Dynamic creative assembly with real-time decisioning
- **Others**: Thunder, Clinch, Flashtalking moving toward inference-based approaches

These platforms demonstrate that real-time inference is not just feasible but increasingly necessary for competitive advantage in digital advertising.

### Real-World Use Case: Dynamic Retail Creative

Consider a clothing retailer using a deployed creative agent:

**Context at Impression Time:**
- User in Miami, 85°F, sunny
- Browsing travel blog about beach destinations  
- Mobile device, 2pm local time
- Previous purchase: winter jacket (6 months ago)

**Real-Time Inference Decision:**
```json
{
  "creative_strategy": "summer_travel",
  "hero_product": "lightweight_beach_coverup",
  "color_palette": "ocean_blues",
  "headline": "Pack Light for Your Beach Getaway",
  "supporting_products": ["sunglasses", "sandals", "beach_tote"],
  "urgency_message": "Free shipping on orders today",
  "layout": "mobile_carousel"
}
```

**Result:** Instead of showing winter jackets (last purchase), the agent shows beach-appropriate clothing that matches the user's current context and apparent intent. This real-time decision drives 3x higher engagement than static retargeting.

## The `build_creative` Tool

This tool builds creative content for a specific format, returning either a creative manifest (for traditional serving) or executable code (for dynamic rendering).

For detailed request/response structures and examples, see the [`build_creative`](tasks/build_creative.md) task documentation.

### Basic Request Example

```json
{
  "message": "Create a native ad for Purina Pro Plan. Make it informative and trustworthy, emphasizing that it's veterinarian recommended and has real salmon as the #1 ingredient. Use 'Learn More' as the CTA.",
  "format": "display_native",
  "output_mode": "manifest",
  "assets": [
    {
      "library_id": "purina_assets",
      "tags": ["salmon_formula", "product_shots"]
    }
  ]
}
```

### Response with Creative Manifest

```json
{
  "message": "Created native ad emphasizing veterinarian recommendation",
  "context_id": "ctx-native-789",
  "status": "draft",
  "creative_output": {
    "type": "creative_manifest",
    "format": "display_native",
    "assets": {
      "headline": "Veterinarian Recommended Nutrition",
      "description": "Pro Plan with real salmon as the #1 ingredient",
      "cta_text": "Learn More",
      "logo": {
        "url": "https://cdn.purina.com/logos/proplan.png",
        "width": 50,
        "height": 50
      },
      "hero_image": {
        "url": "https://cdn.purina.com/products/salmon-hero.jpg",
        "width": 1200,
        "height": 627
      }
    }
  },
  "preview": {
    "static_previews": [
      {
        "context": "desktop",
        "image_url": "https://preview.adcp.com/ctx-native-789/desktop.png"
      }
    ]
  }
}
```

### Conversational Refinement

Subsequent messages continue the conversation using the context_id:

```json
{
  "message": "Can you add a warm, conversational voiceover? It should sound like a caring pet owner sharing advice.",
  "context_id": "ctx-creative-session-123"
}
```

## Asset Library Integration

### Library Structure

```json
{
  "library_id": "purina_brand_assets",
  "name": "Purina Brand Assets",
  "owner": "purina_corp",
  "assets": [
    {
      "asset_id": "logo_main",
      "type": "image",
      "name": "Purina Logo - Primary",
      "url": "https://cdn.purina.com/brand/logo_main.svg",
      "metadata": {
        "usage_rights": "unlimited",
        "versions": ["light", "dark", "monochrome"]
      }
    },
    {
      "asset_id": "color_palette_2024",
      "type": "style",
      "name": "2024 Brand Colors",
      "data": {
        "primary": "#FF6B35",
        "secondary": "#004E89",
        "accent": "#F7931E"
      }
    }
  ]
}
```

### Asset Discovery

Asset providers (advertisers, agencies, or publishers) can provide tools to search and browse available assets:

```json
{
  "tool": "search_asset_library",
  "query": "dog food product shots",
  "filters": {
    "type": "image",
    "usage_rights": "commercial",
    "style": "lifestyle"
  }
}
```

## Dynamic Ad Tag Specification

### Macro Types

1. **Standard Macros** - Predefined by IAB standards
   - `{{CLICK_URL}}` - Click tracking URL
   - `{{IMPRESSION_URL}}` - Impression tracking pixel
   - `{{TIMESTAMP}}` - Current timestamp

2. **Platform Macros** - Provided by the ad server
   - `{{USER_LOCATION}}` - Geographic location
   - `{{DEVICE_TYPE}}` - Mobile, desktop, tablet
   - `{{TIME_OF_DAY}}` - Morning, afternoon, evening

3. **Custom Macros** - Defined by creative requirements
   - `{{WEATHER_CONDITION}}` - Current weather
   - `{{USER_SEGMENT}}` - Audience segment
   - `{{DYNAMIC_PRICE}}` - Real-time pricing

### Ad Tag Template

```html
<div id="adcp-creative-{{CREATIVE_ID}}">
  <script>
    (function() {
      var config = {
        creativeId: '{{CREATIVE_ID}}',
        clickUrl: '{{CLICK_URL}}',
        impressionUrl: '{{IMPRESSION_URL}}',
        customData: {
          location: '{{USER_LOCATION}}',
          weather: '{{WEATHER_CONDITION}}',
          segment: '{{USER_SEGMENT}}'
        }
      };
      
      // Dynamic creative assembly based on macros
      if (config.customData.weather === 'sunny') {
        loadCreativeVariant('outdoor_scene');
      } else {
        loadCreativeVariant('indoor_scene');
      }
    })();
  </script>
</div>
```

## Workflow Examples

### Manifest Mode Workflow

1. **Initial Build Request**
   ```json
   {
     "message": "Create a responsive display ad for Purina Pro Plan with 'Shop Now' as the CTA",
     "format": "display_responsive",
     "output_mode": "manifest",
     "assets": [{
       "library_id": "purina_assets",
       "tags": ["current_campaign"]
     }]
   }
   ```

2. **Response with Manifest and Preview**
   - Returns creative manifest with all assets
   - Shows preview of how it will render
   - Offers refinement suggestions

3. **Refinement**
   ```json
   {
     "action": "refine",
     "context_id": "ctx-creative-456",
     "refinement_message": "Add price point and make CTA more prominent"
   }
   ```

4. **Finalize**
   ```json
   {
     "action": "finalize",
     "context_id": "ctx-creative-456"
   }
   ```

### Code Mode Workflow

1. **Initial Build for Dynamic Creative**
   ```json
   {
     "message": "Create a dynamic 30-second video that adapts to viewer context. Make it personalized and engaging.",
     "format": "video_standard_30s",
     "output_mode": "code"
   }
   ```

2. **Response with Executable Code**
   - Returns HTML/JS code that handles rendering
   - Shows previews for different contexts
   - Code includes real-time inference logic

3. **Integration**
   - Use the code directly in ad servers
   - Code handles its own personalization
   - Fallbacks included for reliability

## Benefits of This Approach

1. **Unified Workflow**: Same creative building process for both manifest and code outputs
2. **Flexibility**: Choose between structured manifests or self-contained executable code
3. **Future-Proof**: Start with manifests, migrate to dynamic code when ready
4. **Compatibility**: Manifests work with any ad server; code works with modern platforms
5. **Progressive Enhancement**: Add real-time personalization as needed

## Implementation Considerations

### For Publishers
- Maintain comprehensive asset libraries with tagging
- Support both manifest and code output types
- Provide preview templates for custom formats
- Enable real-time inference for dynamic creatives

### For Orchestrators
- Handle iterative refinement flows
- Store context between iterations
- Manage asset library access and permissions
- Support both manifest assembly and code generation

### For Advertisers
- Organize assets with meaningful tags
- Choose output mode based on campaign needs
- Review previews before finalizing
- Test dynamic code thoroughly
- Leverage tags for seasonal campaigns

## Integration with Existing AdCP Tools

### With Media Buy Creation

When using manifest mode output:
```json
{
  "tool": "add_creative_assets",
  "media_buy_id": "mb_123",
  "assets": [
    {
      "creative_manifest": {
        "context_id": "ctx-creative-789",
        "format": "display_native"
      }
    }
  ]
}
```

When using code mode output:
```json
{
  "tool": "add_creative_assets", 
  "media_buy_id": "mb_123",
  "assets": [
    {
      "creative_code": {
        "context_id": "ctx-creative-456",
        "name": "Dynamic Weather-Based Creative",
        "format": "html5"
      }
    }
  ]
}
```

### Real-Time Inference in Media Buy Flow

When a deployed creative agent is used in a media buy, the inference happens at impression time:

1. **Bid Request** arrives with user context
2. **Media Buy Agent** determines if to bid
3. **Creative Agent** performs real-time inference:
   - Analyzes user context and signals
   - Selects optimal creative approach
   - Assembles personalized creative
4. **Bid Response** includes creative agent URL
5. **Ad Serving** delivers personalized creative

Example bid request enhancement:
```json
{
  "bid_request_id": "abc123",
  "user_context": {
    "geo": {"lat": 40.7, "lon": -74.0},
    "device": "mobile",
    "publisher": "news_app"
  },
  "creative_agent_context": {
    "weather": "raining",
    "time_of_day": "evening",
    "user_segment": "urban_professional",
    "real_time_signals": {
      "trending_topics": ["sustainability"],
      "local_events": ["marathon_tomorrow"]
    }
  }
}
```

The creative agent uses this enriched context to generate a creative in real-time that speaks to urban professionals on a rainy evening, potentially highlighting indoor product benefits or next-day marathon preparation.