---
sidebar_position: 1
title: Glossary
---

# Glossary

## A

**Account Type**  
Classification of MCP session credentials as either "platform" (aggregator) or "customer" (direct advertiser/agency).

**Activation**  
The process of making an audience available for targeting on a specific platform and seat.

**Ad Context Protocol (AdCP)**  
An open standard based on Model Context Protocol (MCP) that enables AI-powered advertising workflows through natural language interfaces.

**Audience Discovery**  
The process of finding relevant marketing audiences using natural language descriptions.

**Audience ID**  
A unique identifier for an audience within a provider's catalog.

**Audience Type**  
Classification of audiences as "marketplace" (third-party), "owned" (first-party), or "destination" (bundled with media).

## C

**CPM (Cost Per Mille)**  
Pricing model based on cost per thousand impressions.

**Customer Account**  
Direct advertiser or agency account with specific seat access and negotiated rates.

## D

**Deployment** (Audience Protocol)  
The availability status of an audience on specific platforms, including activation state and timing.

**Devices** (Audience Protocol)  
Size unit representing unique device identifiers (cookies, mobile IDs) - typically the largest reach metric.

**Device Type** (Media Buy Protocol)  
Targeting dimension for platform types: mobile, desktop, tablet, CTV, audio, DOOH.

**DSP (Demand-Side Platform)**  
Technology platform that allows advertisers to buy advertising inventory programmatically.

## E

**Estimated Activation Time**  
Predicted timeframe for audience deployment, typically 24-48 hours for new activations.

## H

**Households**  
Size unit representing unique household addresses, useful for geographic and family-based targeting.

## I

**Impressions** (Media Buy Protocol)  
The number of times an ad is displayed, used for pricing and delivery tracking.

**Individuals** (Audience Protocol)  
Size unit representing unique people, best for frequency capping and demographic targeting.

**Inventory**  
Available advertising space on websites, apps, or other media properties.

## M

**MCP (Model Context Protocol)**  
The underlying protocol framework that enables AI assistants to interact with external systems.

**Marketplace Audience**  
Third-party audience available for licensing from data providers.

## N

**Natural Language Processing**  
The AI capability that allows audience discovery through conversational descriptions rather than technical parameters.

## O

**Owned Audience**  
First-party audience data belonging to the advertiser or platform.

## P

**Platform Account**  
Master account representing an advertising platform that can syndicate audiences to multiple customers.

**Prompt**  
Natural language description used to discover relevant audiences (e.g., "high-income sports enthusiasts").

**Provider**  
The company or platform that supplies audience data (e.g., LiveRamp, Experian).

## R

**Relevance Score**  
Numerical rating (0-1) indicating how well an audience matches the discovery prompt.

**Relevance Rationale**  
Human-readable explanation of why an audience received its relevance score.

**Revenue Share**  
Pricing model based on a percentage of media spend rather than fixed CPM.

## S

**Seat**  
A specific advertising account within a platform, typically representing a brand or campaign.

**Segment ID**  
The specific identifier used for audience activation, may differ from audience_id.

**Size Unit** (Audience Protocol)  
The measurement type for audience size: individuals, devices, or households.

## T

**Third-Party Audience**  
Audience data licensed from external providers, also known as marketplace audiences.

## U

**Usage Reporting**  
Daily reporting of audience utilization for billing and optimization purposes.

## B

**Budget**  
Total monetary allocation for a media buy, which can be distributed across multiple packages.

## F

**Flight**  
A time-bounded advertising campaign segment, mapped to line items in ad servers.

## H

**Households** (Audience Protocol)  
Size unit representing unique household addresses, useful for geographic and family-based targeting.

**Human-in-the-Loop (HITL)** (Media Buy Protocol)  
Protocol feature allowing publishers to require manual approval for operations.

## L

**Line Item**  
The basic unit of inventory in ad servers like Google Ad Manager, represented as packages in AdCP.

## M

**MCP (Model Context Protocol)**  
The underlying protocol framework that enables AI assistants to interact with external systems.

**Marketplace Audience**  
Third-party audience available for licensing from data providers.

**Media Buy**  
A complete advertising campaign containing packages, budget, targeting, and creative assets.

## P

**Package**  
A specific advertising product within a media buy, representing a flight or line item with its own pricing and targeting.

**Principal**  
An authenticated entity (advertiser, agency, or brand) with unique access credentials and platform mappings.

**Product**  
Advertising inventory available for purchase, discovered through natural language queries.

## Acronyms

- **AdCP**: Ad Context Protocol
- **API**: Application Programming Interface
- **CPM**: Cost Per Mille (thousand)
- **DSP**: Demand-Side Platform
- **DMP**: Data Management Platform
- **MCP**: Model Context Protocol
- **PII**: Personally Identifiable Information
- **RTB**: Real-Time Bidding
- **SSP**: Supply-Side Platform
- **TTD**: The Trade Desk
- **UTC**: Coordinated Universal Time

## Units and Measurements

**Time Formats**
- All timestamps use ISO 8601 format (e.g., "2025-01-20T14:30:00Z")
- Dates use YYYY-MM-DD format
- Activation times expressed as human-readable estimates ("24-48 hours")

**Currency**
- All pricing in specified currency (typically USD)
- CPM expressed as cost per 1,000 impressions
- Revenue share expressed as decimal (0.15 = 15%)

**Size Reporting** (Audience Protocol)
- Counts expressed as integers
- Units clearly specified (individuals/devices/households)
- Dated with "as_of" timestamp for freshness

**Impression Reporting** (Media Buy Protocol)
- Delivery counts by package
- Pacing metrics for optimization
- Dimensional breakdowns available

## Error Codes Reference

Common error codes across all AdCP implementations:

- `SEGMENT_NOT_FOUND`: Invalid or expired segment ID
- `ACTIVATION_FAILED`: Unable to complete activation process
- `ALREADY_ACTIVATED`: Audience already active for platform/seat
- `DEPLOYMENT_UNAUTHORIZED`: Insufficient permissions for platform/seat
- `BUDGET_EXCEEDED`: Operation would exceed allocated budget
- `CREATIVE_REJECTED`: Creative asset failed platform review
- `INVALID_PRICING_MODEL`: Requested pricing model unavailable
- `RATE_LIMIT_EXCEEDED`: Too many requests in time window
- `AUTHENTICATION_FAILED`: Invalid or expired credentials
- `VALIDATION_ERROR`: Request format or parameter errors