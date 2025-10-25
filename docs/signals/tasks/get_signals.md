---
sidebar_position: 1
title: get_signals
---

# get_signals

**Task**: Discover signals based on description, with details about where they are deployed.

**Response Time**: ~60 seconds (inference/RAG with back-end systems)

**Request Schema**: [`/schemas/v1/signals/get-signals-request.json`](/schemas/v1/signals/get-signals-request.json)
**Response Schema**: [`/schemas/v1/signals/get-signals-response.json`](/schemas/v1/signals/get-signals-response.json)

The `get_signals` task returns both signal metadata and real-time deployment status across platforms, allowing agents to understand availability and guide the activation process.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signal_spec` | string | Yes | Natural language description of the desired signals |
| `deliver_to` | DeliverTo | Yes | Destination platforms where signals need to be activated (see Deliver To Object below) |
| `filters` | Filters | No | Filters to refine results (see Filters Object below) |
| `max_results` | number | No | Maximum number of results to return |

### Deliver To Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `destinations` | Destination[] | Yes | List of destination platforms (DSPs, sales agents, etc.) - see Destination Object below |
| `countries` | string[] | Yes | Countries where signals will be used (ISO codes) |

### Destination Object

Each destination must have **either** `platform` (for DSPs) **or** `agent_url` (for sales agents):

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | Conditional* | Platform identifier (e.g., 'the-trade-desk', 'amazon-dsp') |
| `agent_url` | string (URI) | Conditional* | URL identifying the sales agent |
| `account` | string | No | Account identifier on the platform or agent |

*Must include either `platform` or `agent_url`, but not both.

**Activation Keys**: If the authenticated caller has access to any of the destinations in the request, the signal agent will include `activation_key` fields in the response for those destinations (when `is_live: true`).

**Permission Model**: The signal agent determines key inclusion based on the caller's authentication and authorization. For example:
- A sales agent receives keys for destinations matching its `agent_url`
- A buyer with credentials for multiple DSP platforms receives keys for all those platforms
- Access is determined by the signal agent's permission system, not by flags in the request

### Filters Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `catalog_types` | string[] | No | Filter by catalog type ("marketplace", "custom", "owned") |
| `data_providers` | string[] | No | Filter by specific data providers |
| `max_cpm` | number | No | Maximum CPM price filter |
| `min_coverage_percentage` | number | No | Minimum coverage requirement |

## Response Structure

All AdCP responses include:
- **message**: Human-readable summary of the operation result
- **context_id**: Session continuity identifier for follow-up requests  
- **data**: Task-specific payload (see Response Data below)

The response structure is identical across protocols, with only the transport wrapper differing:
- **MCP**: Returns complete response as flat JSON
- **A2A**: Returns as artifacts with message in text part, data in data part

## Response Data

```json
{
  "signals": [
    {
      "signal_agent_segment_id": "string",
      "name": "string",
      "description": "string",
      "signal_type": "string",
      "data_provider": "string",
      "coverage_percentage": "number",
      "deployments": [
        {
          "agent_url": "string",
          "account": "string",
          "is_live": "boolean",
          "activation_key": {
            "type": "segment_id",
            "segment_id": "string"
          },
          "estimated_activation_duration_minutes": "number"
        }
      ],
      "pricing": {
        "cpm": "number",
        "currency": "string"
      }
    }
  ]
}
```

### Field Descriptions

- **signals**: Array of matching signals
  - **signal_agent_segment_id**: Unique identifier for the signal
  - **name**: Human-readable signal name
  - **description**: Detailed signal description
  - **signal_type**: Type of signal (marketplace, custom, owned)
  - **data_provider**: Name of the data provider
  - **coverage_percentage**: Percentage of audience coverage
  - **deployments**: Array of destination deployments
    - **agent_url**: URL identifying the destination agent
    - **account**: Account identifier if applicable
    - **is_live**: Whether signal is currently active on this destination
    - **activation_key**: The key to use for targeting (see Activation Key below). **Only present if `is_live=true` AND this destination has `requester=true` in the request.**
    - **estimated_activation_duration_minutes**: Time to activate if not live
  - **pricing**: Pricing information
    - **cpm**: Cost per thousand impressions
    - **currency**: Currency code

### Activation Key Object

The activation key represents how to use the signal on a destination platform. It can be either a segment ID or a key-value pair:

**Segment ID format:**
```json
{
  "type": "segment_id",
  "segment_id": "ttd_segment_12345"
}
```

**Key-Value format:**
```json
{
  "type": "key_value",
  "key": "audience_segment",
  "value": "luxury_auto_intenders"
}
```

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request - Sales Agent Requesting Signals

A sales agent querying for signals. Because the authenticated caller is wonderstruck.salesagents.com, the signal agent will include activation keys in the response:

```json
{
  "tool": "get_signals",
  "arguments": {
    "signal_spec": "High-income households interested in luxury goods",
    "deliver_to": {
      "destinations": [
        {
          "agent_url": "https://wonderstruck.salesagents.com"
        }
      ],
      "countries": ["US"]
    },
    "filters": {
      "max_cpm": 5.0,
      "catalog_types": ["marketplace"]
    },
    "max_results": 5
  }
}
```

### MCP Response - With Activation Key

Because the authenticated caller matches the destination, the response includes the activation key:

```json
{
  "message": "Found 1 luxury segment matching your criteria. Already activated for your sales agent.",
  "context_id": "ctx-signals-123",
  "signals": [
    {
      "signal_agent_segment_id": "luxury_auto_intenders",
      "name": "Luxury Automotive Intenders",
      "description": "High-income individuals researching luxury vehicles",
      "signal_type": "marketplace",
      "data_provider": "Experian",
      "coverage_percentage": 12,
      "deployments": [
        {
          "agent_url": "https://wonderstruck.salesagents.com",
          "is_live": true,
          "activation_key": {
            "type": "key_value",
            "key": "audience_segment",
            "value": "luxury_auto_intenders_v2"
          }
        }
      ],
      "pricing": {
        "cpm": 3.50,
        "currency": "USD"
      }
    }
  ]
}
```

### MCP Request - Buyer Querying Multiple DSP Platforms

A buyer checking availability across multiple DSP platforms:

```json
{
  "tool": "get_signals",
  "arguments": {
    "signal_spec": "High-income households interested in luxury goods",
    "deliver_to": {
      "destinations": [
        {
          "platform": "the-trade-desk",
          "account": "agency-123"
        },
        {
          "platform": "amazon-dsp"
        }
      ],
      "countries": ["US"]
    },
    "filters": {
      "max_cpm": 5.0,
      "catalog_types": ["marketplace"]
    },
    "max_results": 5
  }
}
```

### MCP Response - Buyer With Multi-Platform Access

A buyer with credentials for both The Trade Desk and Amazon DSP receives keys for both platforms:

```json
{
  "message": "Found 1 luxury segment matching your criteria. Already activated on The Trade Desk, pending activation on Amazon DSP.",
  "context_id": "ctx-signals-123",
  "signals": [
    {
      "signal_agent_segment_id": "luxury_auto_intenders",
      "name": "Luxury Automotive Intenders",
      "description": "High-income individuals researching luxury vehicles",
      "signal_type": "marketplace",
      "data_provider": "Experian",
      "coverage_percentage": 12,
      "deployments": [
        {
          "platform": "the-trade-desk",
          "account": "agency-123",
          "is_live": true,
          "activation_key": {
            "type": "segment_id",
            "segment_id": "ttd_agency123_exp_lux_auto"
          }
        },
        {
          "platform": "amazon-dsp",
          "is_live": false,
          "estimated_activation_duration_minutes": 60
        }
      ],
      "pricing": {
        "cpm": 3.50,
        "currency": "USD"
      }
    }
  ]
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Find me signals for high-income households interested in luxury goods that can be deployed on The Trade Desk and Amazon DSP in the US, with a maximum CPM of $5.00."
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "data",
      data: {
        skill: "get_signals",
        parameters: {
          signal_spec: "High-income households interested in luxury goods",
          deliver_to: {
            destinations: [
              {
                agent_url: "https://thetradedesk.com",
                account: "agency-123"
              },
              {
                agent_url: "https://advertising.amazon.com/dsp"
              }
            ],
            countries: ["US"]
          },
          filters: {
            max_cpm: 5.0,
            catalog_types: ["marketplace"]
          },
          max_results: 5
        }
      }
    }]
  }
});
```

### A2A Response
A2A returns results as artifacts with the same data structure:
```json
{
  "artifacts": [{
      "name": "signal_discovery_result",
      "parts": [
        {
          "kind": "text",
          "text": "Found 1 luxury segment matching your criteria. Available on The Trade Desk, pending activation on Amazon DSP."
        },
        {
          "kind": "data",
          "data": {
            "context_id": "ctx-signals-123",
            "signals": [
              {
                "signal_agent_segment_id": "luxury_auto_intenders",
                "name": "Luxury Automotive Intenders",
                "description": "High-income individuals researching luxury vehicles",
                "signal_type": "marketplace",
                "data_provider": "Experian",
                "coverage_percentage": 12,
                "deployments": [
                  {
                    "agent_url": "https://thetradedesk.com",
                    "account": "agency-123",
                    "is_live": true
                  },
                  {
                    "agent_url": "https://advertising.amazon.com/dsp",
                    "is_live": false,
                    "estimated_activation_duration_minutes": 60
                  }
                ],
                "pricing": {
                  "cpm": 3.50,
                  "currency": "USD"
                }
              }
            ]
          }
        }
      ]
    }]
}
```

### Protocol Transport
- **MCP**: Direct tool call with arguments, returns complete response as flat JSON
- **A2A**: Skill invocation with input, returns structured artifacts with message and data separated
- **Data Consistency**: Both protocols contain identical AdCP data structures and version information

## Scenarios

### All Platforms Discovery

Discover all available deployments across platforms:

```json
{
  
  "signal_spec": "Contextual segments for luxury automotive content",
  "deliver_to": {
    "platforms": "all",
    "countries": ["US"]
  },
  "filters": {
    "data_providers": ["Peer39"],
    "catalog_types": ["marketplace"]
  }
}
```

### Response

**Message**: "Found luxury automotive contextual segment from Peer39 with 15% coverage. Live on Index Exchange and OpenX, pending activation on Pubmatic."

**Payload**:
```json
{
  "signals": [{
    "signal_agent_segment_id": "peer39_luxury_auto",
    "name": "Luxury Automotive Context",
    "description": "Pages with luxury automotive content and high viewability",
    "signal_type": "marketplace",
    "data_provider": "Peer39",
    "coverage_percentage": 15,
    "deployments": [
      {
        "platform": "index-exchange",
        "account": "agency-123-ix",
        "is_live": true,
        "scope": "account-specific",
        "decisioning_platform_segment_id": "ix_agency123_peer39_lux_auto"
      },
      {
        "platform": "index-exchange",
        "account": null,
        "is_live": true,
        "scope": "platform-wide",
        "decisioning_platform_segment_id": "ix_peer39_luxury_auto_gen"
      },
      {
        "platform": "openx",
        "account": null,
        "is_live": true,
        "scope": "platform-wide",
        "decisioning_platform_segment_id": "ox_peer39_lux_auto_456"
      },
      {
        "platform": "pubmatic",
        "account": "brand-456-pm",
        "is_live": false,
        "scope": "account-specific",
        "estimated_activation_duration_minutes": 60
      }
    ],
    "pricing": {
      "cpm": 2.50,
      "currency": "USD"
    }
  }]
}
```

### Response Fields

- **context_id** (string): Context identifier for session persistence
- **signals** (array): Array of matching signals
  - **signal_agent_segment_id** (string): Universal identifier for the signal
  - **name** (string): Human-readable signal name
  - **description** (string): Detailed signal description
  - **signal_type** (string): Type of signal (marketplace, custom, owned)
  - **data_provider** (string): Provider of the signal data
  - **coverage_percentage** (number): Estimated reach percentage
  - **deployments** (array): Platform-specific deployment information
    - **platform** (string): Target platform name
    - **account** (string, nullable): Specific account if account-specific
    - **is_live** (boolean): Whether signal is currently active
    - **scope** (string): "platform-wide" or "account-specific"
    - **decisioning_platform_segment_id** (string): Platform-specific ID to use
    - **estimated_activation_duration_minutes** (number, optional): Time to activate if not live
  - **pricing** (object): Pricing information
    - **cpm** (number): Cost per thousand impressions
    - **currency** (string): Currency code

## Error Codes

### Discovery Errors
- `SIGNAL_AGENT_SEGMENT_NOT_FOUND`: Signal agent segment ID doesn't exist
- `AGENT_NOT_FOUND`: Private signal agent not visible to this principal
- `AGENT_ACCESS_DENIED`: Principal not authorized for this signal agent

### Discovery Warnings
- `PRICING_UNAVAILABLE`: Pricing data temporarily unavailable for one or more platforms
- `PARTIAL_COVERAGE`: Some requested platforms don't support this signal type
- `STALE_DATA`: Some signal metadata may be outdated due to provider refresh delays

## Usage Notes

1. **Authentication-Based Keys**: Activation keys are only returned when the authenticated caller matches one of the destinations
2. **Permission Security**: The signal agent determines key inclusion based on caller identity, not request flags
3. **Deployment Status**: Check `is_live` to determine if activation is needed
4. **Multiple Destinations**: Query multiple destinations to check availability across platforms
5. **Activation Required**: If `is_live` is false, use the `activate_signal` task
6. **The message field** provides a quick summary of the most relevant findings

### Response - Multiple Signals Found

```json
{
  "message": "I found 3 signals matching your luxury goods criteria. The best option is 'Affluent Shoppers' with 22% coverage, already live across all requested platforms. 'High Income Households' offers broader reach (35%) but requires activation on OpenX. All signals are priced between $2-4 CPM.",
  "context_id": "ctx-signals-abc123",
  "signals": [
    {
      "signal_agent_segment_id": "acme_affluent_shoppers",
      "name": "Affluent Shoppers",
      "description": "Users with demonstrated luxury purchase behavior",
      "signal_type": "marketplace",
      "data_provider": "Acme Data",
      "coverage_percentage": 22,
      "deployments": [
        {
          "platform": "index-exchange",
          "account": "agency-123-ix",
          "is_live": true,
          "scope": "account-specific",
          "decisioning_platform_segment_id": "ix_agency123_acme_aff_shop"
        },
        {
          "platform": "openx",
          "account": "agency-123-ox",
          "is_live": true,
          "scope": "account-specific",
          "decisioning_platform_segment_id": "ox_agency123_affluent_789"
        }
      ],
      "pricing": {
        "cpm": 3.50,
        "currency": "USD"
      }
    }
    // ... more signals
  ]
}
```

### Response - Partial Success with Warnings

```json
{
  "message": "Found 2 luxury signals, but encountered some platform limitations. The 'Premium Auto Shoppers' signal has limited reach due to data restrictions, and pricing data is unavailable for one platform. Review the warnings below for optimization suggestions.",
  "context_id": "ctx-signals-abc123",
  "signals": [
    {
      "signal_agent_segment_id": "premium_auto_shoppers",
      "name": "Premium Auto Shoppers",
      "description": "High-value automotive purchase intenders",
      "signal_type": "marketplace",
      "data_provider": "Experian",
      "coverage_percentage": 8,
      "deployments": [
        {
          "platform": "the-trade-desk",
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ttd_exp_auto_premium"
        }
      ],
      "pricing": {
        "cpm": 4.50,
        "currency": "USD"
      }
    }
  ],
  "errors": [
    {
      "code": "PRICING_UNAVAILABLE",
      "message": "Pricing data temporarily unavailable for The Trade Desk platform",
      "field": "signals[0].pricing",
      "suggestion": "Retry in 15-30 minutes when platform pricing feed updates",
      "details": {
        "affected_platform": "the-trade-desk",
        "last_updated": "2025-01-15T12:00:00Z",
        "retry_after": 1800
      }
    },
    {
      "code": "PRICING_UNAVAILABLE", 
      "message": "Pricing data temporarily unavailable for Amazon DSP",
      "field": "filters.platforms",
      "suggestion": "Pricing will be available during activation, or try again later",
      "details": {
        "affected_platform": "amazon-dsp",
        "retry_after": 1800
      }
    }
  ]
}
```

### Response - No Signals Found

```json
{
  "message": "I couldn't find any signals matching 'underwater basket weavers' in the requested platforms. This appears to be a very niche audience. Consider broadening your criteria to 'craft enthusiasts' or 'hobby communities' for better results. Alternatively, we could create a custom signal for this specific audience.",
  "context_id": "ctx-signals-abc123",
  "signals": []
}
```

## Implementation Guide

### Generating Signal Messages

The `message` field should provide actionable insights:

```python
def generate_signals_message(signals, request):
    if not signals:
        return generate_no_signals_message(request.signal_spec)
    
    # Analyze deployment readiness
    ready_count = sum(1 for s in signals if all_platforms_live(s, request.deliver_to))
    best_signal = find_best_signal(signals)
    
    if len(signals) == 1:
        signal = signals[0]
        deployment_status = get_deployment_summary(signal, request.deliver_to)
        price_commentary = f"The CPM is ${signal.pricing.cpm}, which {'is well within' if signal.pricing.cpm <= request.filters.max_cpm else 'exceeds'} your budget."
        return f"I found a perfect match: '{signal.name}' from {signal.data_provider} with {signal.coverage_percentage}% coverage. {deployment_status} {price_commentary}"
    else:
        return f"I found {len(signals)} signals matching your {extract_key_criteria(request.signal_spec)} criteria. {describe_best_option(best_signal)} {get_pricing_range(signals)}."

def get_deployment_summary(signal, deliver_to):
    live_platforms = [d.platform for d in signal.deployments if d.is_live]
    needs_activation = [d for d in signal.deployments if not d.is_live and d.platform in deliver_to.platforms]
    
    if len(live_platforms) == len(deliver_to.platforms):
        return "It's already live on all requested platforms, ready to use immediately."
    elif live_platforms:
        activation_time = max(d.estimated_activation_duration_minutes for d in needs_activation)
        return f"It's live on {', '.join(live_platforms)}. Activation on {needs_activation[0].platform} would take about {activation_time} minutes."
    else:
        return "It requires activation on all platforms, which typically takes 1-2 hours."
```