---
sidebar_position: 1
title: get_signals
---

# get_signals

**Task**: Discover signals based on description, with details about where they are deployed.

The `get_signals` task returns both signal metadata and real-time deployment status across platforms, allowing agents to understand availability and guide the activation process.

## Request

```json
{
  "context_id": null,  // First request, no context yet
  "signal_spec": "High-income households interested in luxury goods",
  "deliver_to": {
    "platforms": ["index-exchange", "openx"],
    "accounts": [
      { "platform": "index-exchange", "account": "agency-123-ix" },
      { "platform": "openx", "account": "agency-123-ox" }
    ],
    "countries": ["US", "CA"]
  },
  "filters": {
    "catalog_types": ["marketplace"],
    "max_cpm": 5.0,
    "min_coverage_percentage": 10
  },
  "max_results": 5
}
```

### Parameters

- **context_id** (string, nullable): Context identifier for session persistence (null on first request)
- **signal_spec** (string, required): Natural language description of the desired signals
- **deliver_to** (object, required): Where the signals need to be delivered
  - **platforms** (array or "all"): Target platforms for signal deployment
  - **accounts** (array, optional): Specific platform-account combinations
  - **countries** (array, required): Countries where signals will be used
- **filters** (object, optional): Filters to refine results
  - **catalog_types** (array): Filter by catalog type (marketplace, custom, owned)
  - **data_providers** (array): Filter by specific data providers
  - **max_cpm** (number): Maximum CPM price filter
  - **min_coverage_percentage** (number): Minimum coverage requirement
- **max_results** (number, optional): Maximum number of results to return

## Examples

### All Platforms Discovery

Discover all available deployments across platforms:

```json
{
  "context_id": null,
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

## Response

```json
{
  "context_id": "ctx-signals-abc123",  // Server creates context
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