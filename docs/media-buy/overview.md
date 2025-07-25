# Media Buying Overview

## Objectives

The Agentic Media Buying Protocol (AdCP:Buy) provides a unified mechanism for orchestrators to facilitate media buys on publishers on behalf of principals, supporting both guaranteed and non-guaranteed inventory through a single interface.

A "media package" represents a combination of inventory, data, creative formats, and targeting, available at either a fixed price (guaranteed delivery) or competitive bid (non-guaranteed). Each package embodies a testable hypothesis that can be validated through measurement. The protocol seamlessly integrates with programmatic infrastructure while enabling the sophisticated collaboration of traditional media buys.

## Key Concepts

### Unified Package Discovery
The protocol uses a single `get_packages` endpoint that returns both:
- **Catalog packages**: Standardized, pre-configured inventory that accepts immediate orders at competitive bids
- **Custom packages**: Tailored solutions created in response to specific briefs with negotiated terms

### Delivery Types
- **Guaranteed**: Fixed impressions at fixed CPM with publisher commitment
- **Non-guaranteed**: Best-effort delivery at specified bid, competing in real-time

### OpenRTB Compatibility
All creative specifications, targeting parameters, and technical implementations align with OpenRTB 2.6 standards, ensuring compatibility with existing programmatic infrastructure.

## Protocol Flow

### Phase 1: Discovery
The orchestrator calls `get_packages` with:
- Optional brief describing campaign objectives
- Complete media buy specification (budget, timing, targeting, creatives)
- Provided signals for advanced targeting
- Delivery preferences (guaranteed/non-guaranteed/both)

The publisher responds with available packages showing:
- Compatibility with uploaded creatives
- Estimated delivery at various bid levels
- Pricing guidance for competitive packages
- Approval requirements for custom packages

### Phase 2: Media Buy Creation
The orchestrator calls `create_media_buy` to:
- Select multiple packages (mixing guaranteed and non-guaranteed)
- Set budgets and bids per package
- Assign creatives to packages
- Specify flight dates and measurement approach

### Phase 3: Activation
- Catalog packages with pre-approved creatives activate instantly
- Custom packages may require creative review
- Non-guaranteed packages begin competing immediately upon activation
- Guaranteed packages activate after approval workflow

### Phase 4: Optimization
- Principal provides performance indices by package
- Publisher optimizes delivery based on feedback
- Creatives can be added/removed from rotation
- Budgets can be reallocated between packages

### Phase 5: Reporting
- Real-time delivery metrics for all packages
- Win rate data for non-guaranteed inventory
- Unified reporting across package types
- Standard OpenRTB measurement integration

## Technical Architecture

### Creative Standards
The protocol adopts IAB/OpenRTB creative formats as the foundation:
- **Video**: VAST 4.1+ with standard MIME types, durations, and companion specs
- **Audio**: MP3/M4A with VAST 4.1, supporting pre-fetch timing
- **Display**: Standard IAB sizes with HTML5 support
- **DOOH**: Venue-specific formats with impression multipliers
- **Native**: OpenRTB Native 1.2 specifications

### Provided Signals Integration
Principals can use their own data without sharing raw audiences:
- Signals are referenced by ID in package configuration
- AEE validates signal presence at impression time
- Publishers never see underlying audience data
- Seamless integration with OpenRTB bid requests

### Measurement Flexibility
- Supports indexed performance feedback
- Integrates with standard viewability vendors
- Enables custom measurement methodologies
- Real-time optimization based on outcomes

## Benefits of Unified Approach

### For Buyers
- Single API for all inventory types
- Immediate activation for standard packages
- Custom solutions when needed
- Use existing creative assets and data
- Mix guaranteed and non-guaranteed for optimal results

### For Publishers
- Monetize all inventory through one protocol
- Reduce operational overhead
- Automated creative validation
- Dynamic pricing for non-guaranteed
- Maintain direct relationships

### For the Ecosystem
- Bridges programmatic and direct channels
- Reduces fragmentation
- Enables innovation while maintaining standards
- Supports emerging media types
- Preserves privacy through signal abstraction

## Agentic Execution Engine (AEE)

The AEE enables sophisticated real-time decisioning without exposing raw audience data:

1. Publisher's ad server makes OpenRTB request to Principal's AEE
2. AEE evaluates impression against active signals
3. Response indicates signal presence and package eligibility
4. Publisher applies package-level decisioning rules

This architecture combines the precision of RTB with the scale and privacy of traditional buys, working equally well for real-time and offline media.

## Next Steps

- Read the full [Protocol Specification](./specification)
- See the [Sales Agent reference implementation](https://github.com/adcontextprotocol/salesagent)