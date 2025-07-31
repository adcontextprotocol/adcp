# Signals Discovery Protocol

**Version**: 1.0  
**Status**: Draft  
**Last Updated**: January 2025

## Abstract

The Signals Discovery Protocol defines a standard Model Context Protocol (MCP) interface for AI-powered signal discovery and management systems. This protocol enables AI assistants to help marketers discover, activate, and manage data signals (audiences, contextual, geographical, temporal, and multi-dimensional data) through natural language interactions.

## Overview

The Signals Discovery Protocol provides:

- Natural language signal discovery based on marketing objectives
- Signal activation for specific platforms and seats
- Support for diverse signal types (audiences, contextual, geographical, temporal)
- Transparent pricing with CPM and revenue share models
- Signal size reporting with unit types (individuals, devices, households)
- Usage reporting for billing reconciliation

## Core Concepts

### Platform Types

The Ad Context Protocol works across two fundamental types of platforms:

#### Decisioning Platforms
Platforms where signals, targeting, and optimization happen, generating decisions such as bids, PMP creation, or buy execution:

- **DSPs (Demand-Side Platforms)**: Where advertisers bid on inventory
- **SSPs (Supply-Side Platforms)**: Where publishers offer inventory  
- **Ad Servers**: Where creative decisioning and serving occurs
- **Injective Platforms**: Like Scope3, where campaigns are planned and executed

#### Signal Platforms
Platforms that have information about signals (audiences, contexts, locations, behaviors) and can deliver those signals to decisioning platforms where they become transacted upon:

- **Data Management Platforms (DMPs)**: Aggregate and organize signal data
- **Customer Data Platforms (CDPs)**: Unify customer data across touchpoints
- **Data Providers**: Like LiveRamp, Experian, Peer39, who license data signals
- **Identity Resolution Services**: Link devices and identities across platforms
- **Contextual Providers**: Classify content and contexts
- **Location Intelligence**: Provide geographical and movement signals
- **Environmental Data**: Weather, events, and temporal signals

### Account Types

Each MCP session is authenticated as one of:

1. **Platform Account**: A platform's master account (e.g., "Scope3's LiveRamp account")
   - Can activate signals for platform syndication
   - Sees platform-negotiated rates
   - Usage aggregated across platform customers

2. **Customer Account**: A direct customer account (e.g., "Omnicom's LiveRamp account")
   - Can activate audiences for their specific seats
   - Sees their negotiated rates
   - Usage tracked for their account

### Audience Size Units

- `individuals`: Unique people
- `devices`: Unique devices (cookies, mobile IDs)
- `households`: Unique households

### Pricing Models

- **CPM**: Cost per thousand impressions
- **Revenue Share**: Percentage of media spend
- **Both**: Some audiences offer choice between models
- **Included**: No additional cost (e.g., with media buys)

## Protocol Specification

### get_audiences

Discovers relevant audiences based on a marketing specification.

#### Request

```json
{
  "audience_spec": "string",      // Natural language audience specification (required)
  "deliver_to": {
    "platform": "string",        // Platform to check availability for
    "seat": "string",            // Specific seat within platform  
    "countries": ["string"]      // Target countries (e.g., ["US", "CA"])
  },
  "filters": {
    "audience_types": ["owned", "marketplace", "destination"],
    "max_cpm": "number",
    "max_rev_share": "number",
    "min_size": "integer",
    "max_size": "integer"
  },
  "max_results": "integer" // Default: 5
}
```

#### Response

```json
{
  "success": true,
  "audiences": [{
    "audience_id": "string",
    "segment_id": "string",        // Use for activation
    "name": "string",
    "description": "string",
    "audience_type": "marketplace|owned|destination",
    "provider": "string",
    "size": {
      "count": "integer",
      "unit": "individuals|devices|households",
      "as_of": "date"
    },
    "relevance_score": "number",   // 0-1
    "relevance_rationale": "string",
    "deployment": {
      "is_live": "boolean",        // Ready to use?
      "platform": "string",
      "seat": "string",
      "estimated_activation_time": "string"  // If not live
    },
    "pricing": {
      "cpm": "number",             // null if not CPM
      "rev_share": "number",       // null if not rev share
      "currency": "string",
      "notes": "string"
    }
  }]
}
```

### activate_audience

Activates an audience for use on a specific platform/seat.

#### Request

```json
{
  "segment_id": "string",  // From get_audiences (required)
  "platform": "string",    // Required
  "seat": "string",        // Optional
  "options": {
    "priority": "normal|high",
    "notification_email": "string"
  }
}
```

#### Response

```json
{
  "success": true,
  "activation": {
    "segment_id": "string",
    "audience_name": "string",
    "platform": "string",
    "seat": "string",
    "status": "activating|active",
    "estimated_ready_time": "string",
    "activation_id": "string",
    "created_at": "datetime"
  }
}
```

### check_audience_status

Checks the deployment status of an audience.

#### Request

```json
{
  "segment_id": "string",  // Required
  "platform": "string",    // Optional
  "seat": "string"         // Optional
}
```

#### Response

```json
{
  "success": true,
  "audience": {
    "segment_id": "string",
    "name": "string",
    "size": {
      "count": "integer",
      "unit": "individuals|devices|households",
      "as_of": "date"
    },
    "deployment": {
      "platform": "string",
      "seat": "string",
      "status": "deployed|pending|not_deployed",
      "deployed_at": "datetime"
    },
    "pricing": {
      "cpm": "number",
      "rev_share": "number",
      "currency": "string"
    }
  }
}
```

### report_usage

Reports usage data for billing reconciliation.

#### Request

```json
{
  "reporting_date": "date",  // YYYY-MM-DD (required)
  "platform": "string",
  "seat": "string",
  "usage": [{
    "segment_id": "string",
    "impressions": "integer",
    "clicks": "integer",
    "media_spend": "number",    // For rev share
    "data_cost": "number",      // Calculated cost
    "campaigns": [{
      "campaign_id": "string",
      "campaign_name": "string",
      "impressions": "integer",
      "media_spend": "number"
    }]
  }],
  "summary": {
    "total_impressions": "integer",
    "total_media_spend": "number",
    "total_data_cost": "number",
    "unique_segments": "integer"
  }
}
```

#### Response

```json
{
  "success": true,
  "processing": {
    "report_id": "string",
    "status": "accepted",
    "total_data_cost": "number"
  },
  "billing_impact": {
    "invoice_period": "string",
    "accumulated_data_cost": "number",
    "credit_remaining": "number"
  }
}
```

## Typical Flow

1. **Discovery**: Use `get_audiences` to find relevant audiences
2. **Review**: Check `deployment.is_live` status
3. **Activate**: If not live, use `activate_audience`
4. **Monitor**: Use `check_audience_status` to track activation
5. **Target**: Once deployed, use in campaigns
6. **Report**: Daily usage reporting via `report_usage`

## Error Codes

- `SEGMENT_NOT_FOUND`: Segment ID doesn't exist
- `ACTIVATION_FAILED`: Could not activate audience
- `ALREADY_ACTIVATED`: Audience already active
- `DEPLOYMENT_UNAUTHORIZED`: Can't deploy to platform/seat
- `INVALID_PRICING_MODEL`: Pricing model not available

## Implementation Notes

### Authentication

Each MCP session must be authenticated with credentials that determine:
- Account type (platform or customer)
- Available audiences
- Pricing rates
- Deployment permissions

### Usage Reporting

- **Frequency**: Daily reporting by 12:00 UTC
- **Required for**: Marketplace audiences
- **Not required for**: Destination audiences (billed with media)

### Best Practices

1. Check `is_live` status before attempting activation
2. Allow 24-48 hours for audience activation
3. Report media spend accurately for revenue share audiences
4. Understand the difference between size units
5. Consider both pricing options when available