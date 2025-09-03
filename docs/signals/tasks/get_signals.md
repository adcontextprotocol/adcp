---
sidebar_position: 1
title: get_signals
---

# get_signals

**Task**: Discover signals based on description, with details about where they are deployed.

**Request Schema**: [`/schemas/v1/signals/get-signals-request.json`](/schemas/v1/signals/get-signals-request.json)  
**Response Schema**: [`/schemas/v1/signals/get-signals-response.json`](/schemas/v1/signals/get-signals-response.json)

The `get_signals` task returns both signal metadata and real-time deployment status across platforms, allowing agents to understand availability and guide the activation process.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `signal_spec` | string | Yes | Natural language description of the desired signals |
| `deliver_to` | DeliverTo | Yes | Where the signals need to be delivered (see Deliver To Object below) |
| `filters` | Filters | No | Filters to refine results (see Filters Object below) |
| `max_results` | number | No | Maximum number of results to return |

### Deliver To Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platforms` | string[] \| "all" | Yes | Target platforms for signal deployment |
| `accounts` | Account[] | No | Specific platform-account combinations (see Account Object below) |
| `countries` | string[] | Yes | Countries where signals will be used (ISO codes) |

### Account Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | Yes | Platform identifier |
| `account` | string | Yes | Account identifier on that platform |

### Filters Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `catalog_types` | string[] | No | Filter by catalog type ("marketplace", "custom", "owned") |
| `data_providers` | string[] | No | Filter by specific data providers |
| `max_cpm` | number | No | Maximum CPM price filter |
| `min_coverage_percentage` | number | No | Minimum coverage requirement |

## Response (Message)

The response includes a human-readable message that:
- Summarizes the signals found matching the criteria
- Explains deployment status across platforms
- Highlights activation requirements or timing
- Provides recommendations for signal selection

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

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
          "platform": "string",
          "account": "string",
          "is_live": "boolean",
          "scope": "string",
          "decisioning_platform_segment_id": "string",
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
  - **deployments**: Array of platform deployments
    - **platform**: Platform name
    - **account**: Specific account if applicable
    - **is_live**: Whether signal is currently active
    - **scope**: Deployment scope (platform-wide or account-specific)
    - **decisioning_platform_segment_id**: Platform-specific segment ID
    - **estimated_activation_duration_minutes**: Time to activate if not live
  - **pricing**: Pricing information
    - **cpm**: Cost per thousand impressions
    - **currency**: Currency code

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "get_signals",
  "arguments": {
    
    "signal_spec": "High-income households interested in luxury goods",
    "deliver_to": {
      "platforms": ["the-trade-desk", "amazon-dsp"],
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

### MCP Response
```json
{
  "message": "Found 1 luxury segment matching your criteria. Available on The Trade Desk, pending activation on Amazon DSP.",
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
          "account": null,
          "is_live": true,
          "scope": "platform-wide",
          "decisioning_platform_segment_id": "ttd_exp_lux_auto_123"
        },
        {
          "platform": "amazon-dsp",
          "account": null,
          "is_live": false,
          "scope": "platform-wide",
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
            platforms: ["the-trade-desk", "amazon-dsp"],
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
A2A returns results as artifacts:
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
                    "account": null,
                    "is_live": true,
                    "scope": "platform-wide",
                    "decisioning_platform_segment_id": "ttd_exp_lux_auto_123"
                  },
                  {
                    "platform": "amazon-dsp",
                    "account": null,
                    "is_live": false,
                    "scope": "platform-wide",
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

### Key Differences
- **MCP**: Direct tool call with arguments, returns flat JSON response
- **A2A**: Skill invocation with input, returns artifacts with text and data parts
- **Payload**: The `input` field in A2A contains the exact same structure as MCP's `arguments`

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

- `SIGNAL_AGENT_SEGMENT_NOT_FOUND`: Signal agent segment ID doesn't exist
- `AGENT_NOT_FOUND`: Private signal agent not visible to this principal
- `AGENT_ACCESS_DENIED`: Principal not authorized for this signal agent

## Usage Notes

1. **Multi-Platform Discovery**: Use `platforms: "all"` to see all available deployments
2. **Deployment Status**: Check `is_live` to determine if activation is needed
3. **Platform IDs**: Use the `decisioning_platform_segment_id` when creating campaigns
4. **Activation Required**: If `is_live` is false, use the `activate_signal` task
5. **The message field** provides a quick summary of the most relevant findings

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