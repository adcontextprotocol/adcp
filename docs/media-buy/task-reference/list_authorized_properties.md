---
title: list_authorized_properties
sidebar_position: 1.5
---

# list_authorized_properties

Discover all advertising properties this sales agent is authorized to represent, enabling buyers to validate authorization via adagents.json and resolve property tags used in products.

**Response Time**: ~2 seconds (database lookup with potential pagination)

**Purpose**: 
- Authorization validation for buyer agents
- Property tag resolution for products that use `property_tags` instead of full `properties` arrays
- One-time discovery to cache property-to-domain mappings

**Request Schema**: [`/schemas/v1/media-buy/list-authorized-properties-request.json`](/schemas/v1/media-buy/list-authorized-properties-request.json)
**Response Schema**: [`/schemas/v1/media-buy/list-authorized-properties-response.json`](/schemas/v1/media-buy/list-authorized-properties-response.json)

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tags` | string[] | No | Filter properties by specific tags (e.g., `["local_radio", "premium"]`) |

## Response (Message)

The response includes a human-readable message that:
- Summarizes the total number of authorized properties
- Explains tag groupings if applicable
- Notes any filtering applied

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "properties": [
    {
      "property_type": "website",
      "name": "Sports Network",
      "identifiers": [
        {"type": "domain", "value": "sportsnetwork.com"}
      ],
      "tags": ["sports_network", "premium"],
      "publisher_domain": "sportsnetwork.com"
    },
    {
      "property_type": "radio",
      "name": "WXYZ-FM Chicago",
      "identifiers": [
        {"type": "call_sign", "value": "WXYZ-FM"},
        {"type": "market", "value": "chicago"}
      ],
      "tags": ["local_radio", "midwest"],
      "publisher_domain": "radionetwork.com"
    }
  ],
  "tags": {
    "local_radio": {
      "name": "Local Radio Stations",
      "description": "1847 local radio stations across US markets"
    },
    "sports_network": {
      "name": "Sports Network Properties",
      "description": "145 sports properties and networks"
    },
    "midwest": {
      "name": "Midwest Markets",
      "description": "523 properties in midwest markets"
    },
    "premium": {
      "name": "Premium Inventory",
      "description": "Premium tier inventory across all property types"
    }
  },
  "primary_channels": ["dooh"],
  "primary_markets": ["US", "CA", "MX"],
  "portfolio_size": 125,
  "portfolio_description": "Premium DOOH network across North America. **Venues**: Airports, transit hubs, premium malls, office towers. **Audiences**: Business travelers, commuters, high net worth shoppers. **Special Features**: Dwell time targeting, dayparting, proof-of-play verification."
}
```

### Field Descriptions

- **properties**: Array of all authorized properties (see [Property Schema](/schemas/v1/core/property.json))
- **tags**: Metadata for each tag used by properties
  - **name**: Human-readable name for the tag
  - **description**: Description of what the tag represents and optionally how many properties it includes
- **primary_channels** *(optional)*: Main advertising channels (display, video, dooh, ctv, etc.)
- **primary_markets** *(optional)*: Main geographic markets (ISO country codes)
- **portfolio_size** *(optional)*: Total count of properties in portfolio (not pagination-related)
- **portfolio_description** *(optional)*: Markdown description of the property portfolio

## Integration with get_products

This tool works in conjunction with [`get_products`](./get_products) to support two patterns:

### Pattern 1: Direct Properties
Products include full property objects directly:
```json
{
  "product_id": "sports_premium",
  "properties": [
    {
      "property_type": "website",
      "name": "ESPN.com",
      "identifiers": [{"type": "domain", "value": "espn.com"}],
      "publisher_domain": "espn.com"
    }
  ]
}
```

### Pattern 2: Property Tags (Recommended for Large Networks)
Products reference tags, requiring `list_authorized_properties` to resolve:
```json
{
  "product_id": "local_radio_midwest",
  "property_tags": ["local_radio", "midwest"]
}
```

To resolve tags to actual properties:
1. Call `list_authorized_properties()` once to get all properties
2. Filter properties where `tags` array includes the referenced tags
3. Use those properties for validation

## Validation Workflow

```mermaid
sequenceDiagram
    participant Buyer as Buyer Agent
    participant Sales as Sales Agent
    participant Publisher as Publisher Domain

    Note over Buyer: One-time Setup
    Buyer->>Sales: list_authorized_properties()
    Sales-->>Buyer: All property objects with tags
    
    Note over Buyer: Cache Validation Data
    loop For each property.publisher_domain
        Buyer->>Publisher: GET /.well-known/adagents.json
        Publisher-->>Buyer: Authorized agents list
        Buyer->>Buyer: Cache: domain → authorized agents
    end
    
    Note over Buyer: Product Discovery
    Buyer->>Sales: get_products(...)
    Sales-->>Buyer: Products with properties OR property_tags
    
    Note over Buyer: Authorization Validation
    alt Product has properties array
        Buyer->>Buyer: Check each property.publisher_domain in cache
    else Product has property_tags
        Buyer->>Buyer: Resolve tags to properties from cached list
        Buyer->>Buyer: Check each resolved property.publisher_domain
    end
```

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "list_authorized_properties",
  "arguments": {
    "tags": ["local_radio"]
  }
}
```

### MCP Response
```json
{
  "message": "Found 1847 authorized properties matching tags: local_radio",
  "properties": [
    {
      "property_type": "radio",
      "name": "WXYZ-FM Chicago",
      "identifiers": [
        {"type": "call_sign", "value": "WXYZ-FM"},
        {"type": "market", "value": "chicago"}
      ],
      "tags": ["local_radio", "midwest"],
      "publisher_domain": "radionetwork.com"
    }
  ],
  "tags": {
    "local_radio": {
      "name": "Local Radio Stations",
      "description": "1847 local radio stations across US markets"
    },
    "midwest": {
      "name": "Midwest Markets", 
      "description": "523 properties in midwest markets"
    }
  }
}
```

### A2A Request
```javascript
await a2a.send({
  message: {
    parts: [
      {
        kind: "data",
        data: {
          skill: "list_authorized_properties",
          parameters: {
            tags: ["local_radio"]
          }
        }
      }
    ]
  }
});
```

### A2A Response
```json
{
  "artifacts": [{
    "name": "authorized_properties_result",
    "parts": [
      {
        "kind": "text",
        "text": "Found 1847 authorized properties matching tags: local_radio"
      },
      {
        "kind": "data",
        "data": {
          "properties": [
            {
              "property_type": "radio",
              "name": "WXYZ-FM Chicago",
              "identifiers": [
                {"type": "call_sign", "value": "WXYZ-FM"},
                {"type": "market", "value": "chicago"}
              ],
              "tags": ["local_radio", "midwest"],
              "publisher_domain": "radionetwork.com"
            }
          ],
          "tags": {
            "local_radio": {
              "name": "Local Radio Stations",
              "description": "1847 local radio stations across US markets"
            },
            "midwest": {
              "name": "Midwest Markets",
              "description": "523 properties in midwest markets"
            }
          }
        }
      }
    ]
  }]
}
```

## Property Portfolio Metadata

Optional top-level fields provide high-level metadata about the property portfolio to help buying agents quickly determine relevance without examining every property.

### Why Portfolio Metadata?

**The core insight**: This isn't about what the agent *can do* (that's in A2A skills) - it's about what properties the agent *represents*. Properties change over time as inventory is added or removed.

**Use case**: Orchestrator needs to route brief "DOOH in US airports" to relevant agents:
```javascript
// Quick filtering before detailed analysis
const response = await agent.send({ skill: 'list_authorized_properties' });

if (response.primary_channels?.includes('dooh') &&
    response.primary_markets?.includes('US')) {
  // Relevant! Now examine detailed properties
  const airportProperties = response.properties.filter(p =>
    p.tags?.includes('airports')
  );
}
```

### Portfolio Fields

**`primary_channels`** *(optional)*: Main advertising channels in this portfolio
- `"display"`, `"video"`, `"dooh"`, `"ctv"`, `"podcast"`, `"retail"`, etc.
- Helps filter "Do you have DOOH?" before examining properties

**`primary_markets`** *(optional)*: Main geographic markets (ISO country codes)
- Where the bulk of properties are concentrated
- Helps filter "Do you have US inventory?" before examining properties

**`portfolio_size`** *(optional)*: Total count of properties (not pagination-related)
- Context for portfolio scale
- "1847 radio stations" vs "5 premium properties"

**`portfolio_description`** *(optional)*: Markdown description of the portfolio
- Inventory types and characteristics
- Audience profiles
- Special features or capabilities

### Example Portfolio Metadata

**DOOH Network**:
```json
{
  "primary_channels": ["dooh"],
  "primary_markets": ["US", "CA"],
  "portfolio_size": 125,
  "portfolio_description": "Premium digital out-of-home across airports and transit. Business traveler focus with proof-of-play."
}
```

**Multi-Channel Publisher**:
```json
{
  "primary_channels": ["display", "video", "native"],
  "primary_markets": ["US", "GB", "AU"],
  "portfolio_size": 45,
  "portfolio_description": "News and business publisher network. Desktop and mobile web properties with professional audience."
}
```

**Large Radio Network**:
```json
{
  "primary_channels": ["audio"],
  "primary_markets": ["US"],
  "portfolio_size": 1847,
  "portfolio_description": "National radio network covering all US DMAs. Mix of news, talk, and music formats."
}
```

## Use Cases

### Large Network Discovery
For agents representing thousands of properties (e.g., radio networks):
- Call once to get all properties and their tags
- Cache the property list for validation
- Products can reference `["local_radio"]` instead of listing 1847 stations

### Authorization Verification
For buyer agents validating seller authorization:
- Discover all domains this agent claims to represent
- Fetch adagents.json from each domain once
- Cache authorization status for fast product validation

### Tag Resolution
For products using `property_tags` instead of full property arrays:
- Use cached property list to resolve tags to actual properties
- Perform validation on the resolved properties