---
sidebar_position: 2
title: Protocol Specification
---

# Audience Discovery Protocol RFC

**Version**: 0.1  
**Status**: Request for Comments  
**Last Updated**: January 2025

## Abstract

The Audience Discovery Protocol defines a standard Model Context Protocol (MCP) interface for AI-powered audience discovery and management systems. This protocol enables AI assistants to help marketers discover, activate, and manage audiences through natural language interactions.

## Overview

The Audience Discovery Protocol provides:

- Natural language audience discovery based on marketing objectives
- Multi-platform audience discovery in a single request
- Audience activation for specific platforms and accounts
- Transparent pricing with CPM and revenue share models
- Audience size reporting with unit types (individuals, devices, households)
- Usage reporting for billing reconciliation

## Core Concepts

### Agent Integration

The Audience Discovery Protocol operates within the broader [Ad Tech Ecosystem Architecture](../intro#ad-tech-ecosystem-architecture), connecting audience agents with decisioning platforms through standardized activation workflows.

### Request Roles and Relationships

Every audience discovery request involves two key roles:

#### Orchestrator
The platform or system making the API request to the audience platform:
- **Examples**: Scope3, Claude AI assistant, trading desk platform, campaign management tool
- **Responsibilities**: Makes API calls, handles authentication, manages the technical interaction
- **Account**: Has technical credentials and API access to the audience platform

#### Principal  
The entity on whose behalf the request is being made:
- **Examples**: Advertiser (Nike), agency (Omnicom), brand team, media buyer
- **Responsibilities**: Owns the campaign objectives, budget, and business relationship
- **Pricing**: May have negotiated rates, contract terms, or access to private audiences

#### How This Works in Practice

1. **Request Flow**: Orchestrator → Audience Platform (on behalf of Principal) → Decisioning Platform
2. **Authentication**: Orchestrator authenticates with technical credentials
3. **Authorization**: Principal's identity determines available audiences and pricing
4. **Activation**: Audiences are activated for Principal's account on the decisioning platform
5. **Billing**: Principal is responsible for usage costs and campaign spend

#### Example Scenarios

**Scenario 1: Marketplace Agent with Personalized Catalog (Agency)**
- **Orchestrator**: Claude AI assistant (making API calls)
- **Principal**: Omnicom (agency running campaign for Nike)
- **Audience Agent**: LiveRamp (marketplace agent, Omnicom has account for personalized catalog)
- **Decisioning Platform**: The Trade Desk (where audiences will be used)
- **Flow**: Claude (on behalf of Omnicom) → LiveRamp (Omnicom's personalized catalog with negotiated rates and private data) → delivers to Omnicom's account on The Trade Desk

**Scenario 2: Marketplace Agent with Personalized Catalog**  
- **Orchestrator**: Scope3 platform (connecting audiences to agents)
- **Principal**: Nike (advertiser setting up their agent)
- **Audience Agent**: Experian (marketplace agent, Nike has account for personalized catalog)
- **Decisioning Platform**: Nike Advertising Agent (running on Scope3 platform)
- **Flow**: Scope3 (on behalf of Nike) → Experian (Nike's personalized catalog with owned data and custom rates) → delivers to Nike's advertising agent (hosted by Scope3)

**Scenario 3: Private Audience Agent**
- **Orchestrator**: Scope3 platform (connecting audiences to agents)
- **Principal**: Walmart (retailer setting up their agent)
- **Audience Agent**: Walmart (private agent, only visible to Walmart)
- **Decisioning Platform**: Walmart Advertising Agent (running on Scope3 platform)
- **Flow**: Scope3 (on behalf of Walmart) → Walmart audience agent (private, owned, no cost) → delivers to Walmart's advertising agent for workflow orchestration

**Scenario 4: Marketplace Agent with Public Catalog**
- **Orchestrator**: Claude AI assistant (making API calls)
- **Principal**: Startup Brand (new advertiser with no existing accounts)
- **Audience Agent**: LiveRamp (marketplace agent, public catalog access)
- **Decisioning Platform**: The Trade Desk (where audiences will be used)
- **Flow**: Claude (on behalf of Startup Brand) → LiveRamp (public catalog, standard pricing) → delivers to Startup Brand's account on The Trade Desk

**Scenario 5: Data Provider with Multi-Platform Deployment**
- **Orchestrator**: Agency trading desk platform
- **Principal**: Media Agency (looking for contextual segments)
- **Audience Agent**: Peer39 (contextual data provider)
- **Decisioning Platforms**: Multiple SSPs (Index Exchange, OpenX, PubMatic)
- **Flow**: Trading desk (on behalf of Agency) → Peer39 (returns same segments deployed across multiple SSPs) → Agency can activate on any/all SSPs

### Audience Agent Types

#### Private Audience Agents
Agents owned by the principal with exclusive access:
- **Examples**: Walmart's internal audience platform, retailer first-party data
- **Business Model**: No audience costs (workflow orchestration only)
- **Access**: Only visible and accessible to the owning principal
- **Discovery**: Not discoverable by other principals
- **Authentication**: Owner-only access, no external visibility
- **Usage Reporting**: Optional (no billing, just workflow tracking)

#### Marketplace Audience Agents  
External agents that license audience data with catalog-based access:
- **Examples**: LiveRamp, Experian, data providers
- **Business Model**: CPM, revenue share, or licensing fees
- **Usage Reporting**: Required for billing reconciliation

**Catalog Access Levels:**
- **Public Catalog**: Available to any orchestrator without principal registration
  - Standard marketplace pricing
  - Platform-wide segments only (available to all decisioning platform users)
  - No account specification needed in requests
  - All segments already live (`scope: "platform-wide"`)
  
- **Personalized Catalog**: Requires principal account with the audience agent
  - All platform-wide segments (same as public catalog)
  - PLUS account-specific segments (custom audiences, private data)
  - Mixed pricing: negotiated rates for some, standard rates for others
  - Account field required in requests for account-specific deployments

### Authentication Patterns

- **Private**: Owner-only authentication (e.g., Walmart authenticates to their own agent)
- **Marketplace**: Orchestrator authentication determines catalog access level
  - Public catalog: Orchestrator credentials sufficient
  - Personalized catalog: Requires principal account with audience agent

### Segment ID Structure

Audience discovery involves multiple segment identifiers at different stages:

#### Audience Agent Segment ID
The identifier used by the audience agent for their internal segment tracking:
- **Example**: `"polk_001382"` (Polk's segment as known to LiveRamp)
- **Usage**: Used in `get_audiences` responses and `activate_audience` requests
- **Scope**: Internal to the audience agent platform

#### Decisioning Platform Segment ID  
The identifier assigned by the decisioning platform after activation:
- **Example**: `"liveramp_polk_dallas_lexus"` (TTD's ID for the activated segment)
- **Usage**: Returned in `activate_audience` responses and used for campaign targeting
- **Scope**: Internal to the decisioning platform
- **Timing**: Only available after successful activation
- **Variability**: May differ by platform and account for the same audience

### Agent vs Data Provider

- **Agent**: The audience platform facilitating access (e.g., LiveRamp, Experian)
- **Data Provider**: The original source of the audience data (e.g., Polk, Acxiom, Peer39)

An audience agent may host segments from multiple data providers in their marketplace.

### Coverage Percentage

Coverage percentage indicates what portion of the agent's total addressable audience this segment covers:
- **99%**: Matches nearly all identifiers the agent has (very broad audience)
- **50%**: Matches about half the agent's identifiers (medium audience)
- **1%**: Matches very few identifiers the agent has (very niche audience)

This is relative to each audience agent's capabilities - a 50% coverage audience from LiveRamp may be larger than a 99% coverage audience from a niche data provider.

### Pricing Models

- **CPM**: Cost per thousand impressions
- **Revenue Share**: Percentage of media spend
- **Both**: Some audiences offer choice between models
- **Included**: No additional cost (e.g., with media buys)

## Protocol Specification

### get_audiences

Discovers relevant audiences based on a marketing specification. Supports both single-platform and multi-platform queries.

#### Request

**Single Platform Example** (original format, still supported):
```json
{
  "audience_spec": "High-income sports enthusiasts interested in premium running gear",
  "deliver_to": {
    "platform": "the-trade-desk",
    "account": "omnicom-ttd-main",
    "countries": ["US", "CA"]
  },
  "filters": {
    "catalog_types": ["marketplace"],
    "max_cpm": 8.0,
    "min_coverage_percentage": 25
  },
  "max_results": 3
}
```

**Multi-Platform Example**:
```json
{
  "audience_spec": "Premium automotive intenders in major urban markets",
  "deliver_to": {
    "platforms": [
      {
        "platform": "index-exchange",
        "account": "agency-123-ix"        // Optional - for account-specific segments
      },
      {
        "platform": "openx"                // No account = platform-wide segments only
      },
      {
        "platform": "pubmatic",
        "account": "brand-456-pm"
      }
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

**All Platforms Example** (discover all available deployments):
```json
{
  "audience_spec": "Contextual segments for luxury automotive content",
  "deliver_to": {
    "platforms": "all",                   // Returns all platforms where segments are deployed
    "countries": ["US"]
  },
  "filters": {
    "data_providers": ["Peer39"],         // Optional filter by data provider
    "catalog_types": ["marketplace"]
  }
}
```

#### Response

**Single Platform Response** (backward compatible):
```json
{
  "audiences": [{
    "audience_agent_segment_id": "sports_enthusiasts_public",
    "name": "Sports Enthusiasts - Public",
    "description": "Broad sports audience available platform-wide",
    "audience_type": "marketplace",
    "data_provider": "Polk",
    "coverage_percentage": 45,
    "deployment": {
      "is_live": true,
      "scope": "platform-wide",
      "decisioning_platform_segment_id": "ttd_sports_general"
    },
    "pricing": {
      "cpm": 3.50,
      "currency": "USD"
    },
    "require_usage_reporting": false
  }]
}
```

**Multi-Platform Response**:
```json
{
  "audiences": [{
    "audience_agent_segment_id": "peer39_luxury_auto",
    "name": "Luxury Automotive Context",
    "description": "Pages with luxury automotive content and high viewability",
    "audience_type": "marketplace",
    "data_provider": "Peer39",
    "coverage_percentage": 15,
    "deployments": [                      // Array of deployments across platforms
      {
        "platform": "index-exchange",
        "account": "agency-123-ix",
        "is_live": true,
        "scope": "account-specific",
        "decisioning_platform_segment_id": "ix_agency123_peer39_lux_auto"
      },
      {
        "platform": "index-exchange",
        "account": null,                  // Platform-wide version also available
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
    },
    "require_usage_reporting": true
  }]
}
```

### activate_audience

Activates an audience for use on a specific platform/account.

#### Request

```json
{
  "audience_agent_segment_id": "peer39_luxury_auto",
  "platform": "pubmatic",                   
  "account": "brand-456-pm"                 // Required for account-specific activation
}
```

#### Response

```json
{
  "decisioning_platform_segment_id": "pm_brand456_peer39_lux_auto",
  "estimated_activation_duration_minutes": 60
}
```

### check_audience_status

Checks the deployment status of an audience on a decisioning platform.

#### Request

```json
{
  "audience_agent_segment_id": "peer39_luxury_auto",
  "decisioning_platform": "index-exchange",
  "account": "agency-123-ix"                // Optional - only for account-specific segments
}
```

#### Response

```json
{
  "status": "deployed",
  "deployed_at": "2025-01-15T14:30:00Z"
}
```

### report_usage

Reports usage data for billing reconciliation. When the same audience is used across multiple platforms, report each platform separately.

#### Request

```json
{
  "reporting_date": "2025-01-15",
  "platform": "index-exchange",          
  "account": "agency-123-ix",           
  "usage": [{
    "audience_agent_segment_id": "peer39_luxury_auto",
    "decisioning_platform_segment_id": "ix_agency123_peer39_lux_auto",
    "active": true,
    "impressions": 5000000,
    "media_spend": 125000.00,
    "data_cost": 12500.00               // Based on CPM or revenue share
  }],
  "summary": {
    "total_impressions": 5000000,
    "total_media_spend": 125000.00,
    "total_data_cost": 12500.00,
    "unique_segments": 1
  }
}
```

#### Response

```json
{
  "success": true
}
```

## Typical Flow

### Data Provider Multi-Platform Flow (e.g., Peer39)

1. **Discovery**: Call `get_audiences` with multiple platforms to see all deployments at once

2. **Review**: See which platforms have segments live vs. requiring activation, compare segment IDs across platforms

3. **Select**: Choose which platforms to use based on campaign needs and existing deployments

4. **Activate**: For any platforms where segments aren't live, call `activate_audience`

5. **Monitor**: Use `check_audience_status` to track activation progress

6. **Launch**: Run campaigns across multiple SSPs using the platform-specific segment IDs

7. **Report**: Report usage separately for each platform where the audience was used

### Marketplace Audience Agent Flow

1. **Discovery**: Call `get_audiences` multiple times to explore different audience options - response varies by authentication (public vs personalized catalog)

2. **Review**: Evaluate audience options, pricing, and `deployment.is_live` status for the specific decisioning platform

3. **Commit**: Principal decides to proceed with specific audiences for their media execution

4. **Activate**: For account-specific segments that aren't live, call `activate_audience` to deploy from audience agent to decisioning platform

5. **Monitor**: Use `check_audience_status` to track activation progress between agents

6. **Launch**: Once deployed, launch the media execution (campaigns, PMPs, direct buys, etc.) on the decisioning platform

7. **Report**: For segments with `require_usage_reporting: true`, report daily usage via `report_usage`

### Private Audience Agent Flow

1. **Discovery**: Call `get_audiences` on owned audience agent (Walmart), with no licensing costs

2. **Review**: Check `deployment.is_live` status for workflow orchestration (no pricing review needed)

3. **Commit**: Principal decides to proceed with owned audiences for their media execution

4. **Activate**: If not live, call `activate_audience` for workflow orchestration from owned agent to decisioning platform

5. **Monitor**: Use `check_audience_status` to track activation progress

6. **Launch**: Once deployed, launch the media execution using owned audiences

7. **Report**: Only if `require_usage_reporting: true` (typically false for private agents)

## Error Codes

- `AUDIENCE_AGENT_SEGMENT_NOT_FOUND`: Audience agent segment ID doesn't exist
- `ACTIVATION_FAILED`: Could not activate audience
- `ALREADY_ACTIVATED`: Audience already active
- `DEPLOYMENT_UNAUTHORIZED`: Can't deploy to platform/account
- `INVALID_PRICING_MODEL`: Pricing model not available
- `AGENT_NOT_FOUND`: Private audience agent not visible to this principal
- `AGENT_ACCESS_DENIED`: Principal not authorized for this audience agent

## Implementation Notes

### Authentication

Each MCP session involves two levels of identification:

#### Orchestrator Authentication
The technical credentials used by the orchestrator to authenticate with the audience platform:
- **API Keys**: Technical access credentials for the orchestrator platform
- **Session Scope**: Determines what operations the orchestrator can perform
- **Platform Permissions**: What audience platforms the orchestrator can access

#### Principal Authorization  
The principal's identity determines business-level access and pricing:
- **Account Relationship**: Whether the principal has a direct relationship with the audience platform
- **Pricing Tier**: Negotiated rates, marketplace rates, or enterprise discounts
- **Audience Access**: Private audiences, premium segments, or marketplace-only access
- **Billing Account**: Where usage charges are applied

#### Authentication Flow
1. **Caller** authenticates with audience agent using their credentials
2. **Audience agent** determines catalog access level based on authentication
3. **Responses** reflect the authenticated party's available options and rates

### Orchestrator Implementation Guidelines

#### Agent Discovery and Access
1. **Private Agents**: Only show to owning principal (e.g., only show Walmart's agent to Walmart)
2. **Marketplace Agents**: Always discoverable, but catalog access varies by principal account status

#### Error Handling by Agent Type
- **Private**: Return `AGENT_NOT_FOUND` for non-owners
- **Marketplace**: Always allow requests but return appropriate catalog level
  - Public catalog: Generic marketplace offerings with standard pricing
  - Personalized catalog: Principal's custom data, negotiated rates, and owned segments

#### User Experience Considerations
- **Setup Flow**: Marketplace agents with public catalogs enable immediate audience discovery
- **Account Benefits**: Principals with marketplace agent accounts get their own data plus negotiated rates
- **Privacy**: Private agents ensure data sovereignty for owned audiences

### Multi-Platform Considerations

#### Response Format Selection
- If request contains single `platform` field: Return single `deployment` object
- If request contains `platforms` array: Return `deployments` array
- This ensures backward compatibility while enabling multi-platform queries

#### Platform-Specific Segment IDs
- Same audience may have different segment IDs on different platforms
- Account-specific deployments may have different IDs than platform-wide deployments
- Always use the correct `decisioning_platform_segment_id` for each platform/account combination

#### Efficient Discovery
- Data providers like Peer39 can return all their deployments in one response
- Reduces API calls from N (one per platform) to 1
- Particularly valuable for contextual data providers with wide SSP distribution

### Usage Reporting

- **Frequency**: Daily reporting by 12:00 UTC
- **Required for**: Marketplace audiences 
- **Not required for**: Private owned audiences (no billing, optional for workflow tracking)
- **Multi-Platform**: Report each platform separately, even for the same audience

#### Audience Lifecycle Management

Usage reporting handles the complete audience lifecycle:

- **All Active Audiences**: Every audience currently activated must be included in daily reports
- **Deactivation**: Set `active: false` to indicate an audience is no longer being used
- **Final Billing**: Include final usage data when marking `active: false`
- **Zero Usage**: Audiences with no impressions/spend should still be reported with `active: true` if they remain available for campaigns

This approach eliminates the need for explicit deactivation API calls while ensuring accurate billing and lifecycle tracking.

### Best Practices

1. Check `is_live` status before attempting activation
2. Allow 24-48 hours for audience activation
3. Report media spend accurately for revenue share audiences
4. Understand the difference between size units
5. Consider both pricing options when available
6. Use multi-platform queries when discovering audiences across SSPs
7. Store platform-specific segment IDs for campaign execution