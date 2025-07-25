# Agentic Media Buying Protocol (AdCP:Buy) RFC

**Version**: 0.1  
**Status**: Request for Comments  
**Last Updated**: January 2025

## Abstract

The Agentic Media Buying Protocol (AdCP:Buy) defines a standard Model Context Protocol (MCP) interface for AI-powered media buying systems. This protocol enables AI assistants to help advertisers discover, negotiate, execute, and optimize media buys through natural language interactions.

## Overview

The AdCP:Buy protocol provides:

- Collaborative media package creation between principals and publishers
- Iterative proposal and negotiation workflows
- Integration with real-time decisioning through the Agentic Execution Engine (AEE)
- Performance-based optimization through measurement feedback loops
- Flexible creative asset management

## Core Concepts

### Roles and Relationships

#### Orchestrator
The AI agent or platform facilitating the media buy:
- **Examples**: Claude AI assistant, agency trading platform, campaign management tool
- **Responsibilities**: Translates principal objectives into technical requests, manages negotiation flow
- **Authentication**: Uses API credentials to interact with publisher systems

#### Principal
The advertiser or agency purchasing media:
- **Examples**: Nike (brand), Omnicom (agency), media buyer
- **Responsibilities**: Defines objectives, approves proposals, provides creative assets, shares measurement data
- **Account**: Has commercial relationship with publisher

#### Publisher
The media owner selling inventory:
- **Examples**: CNN, Spotify, Reddit, Meta
- **Responsibilities**: Creates media packages, executes campaigns, optimizes based on feedback
- **Inventory**: Can be owned & operated, network, or aggregated programmatic

### Proposal → Media Buy → Media Package

The protocol follows a structured flow from discovery to execution:

#### 1. Proposal
A proposal is the publisher's response to a brief, outlining how they would execute the campaign:
- Contains one or more media packages
- Includes pricing, inventory sources, and delivery estimates
- May go through multiple iterations before acceptance
- Has an ID for reference and optional expiration date

#### 2. Media Buy
A media buy is an accepted proposal that becomes a binding agreement:
- Created when the principal accepts a proposal
- Contains the selected media packages from the proposal
- Tracks delivery, performance, and billing
- Can be modified during flight with mutual agreement

#### 3. Media Package
A media package is a specific execution strategy within a media buy:
- Represents a testable hypothesis (e.g., "sports enthusiasts will convert")
- Combines inventory, data, creative, and targeting
- Has its own budget, pacing, and performance metrics
- Can be optimized independently within the media buy

### Creative Management

Creatives are managed at the media buy level and assigned to packages:

#### Creative Lifecycle
1. **Upload**: Principal uploads creative assets via `add_creative_assets`
2. **Review**: Publisher reviews for technical specs and policy compliance
3. **Approval**: Once approved, creative is available for use
4. **Assignment**: Approved creatives can be added to package rotations
5. **Optimization**: Creatives can be removed from packages based on performance

#### Creative Rotation
- Publishers manage creative rotation within packages based on their optimization algorithms
- Principals can influence rotation by adding/removing creatives from packages
- Multiple creatives can be active per package simultaneously
- Publishers may automatically optimize creative distribution based on performance

### Mid-Flight Adjustments

After a media buy launches, principals can make several adjustments:

#### Available Actions
- **Add Creative**: Upload new creative assets for approval
- **Manage Rotation**: Add/remove approved creatives from package rotations
- **Budget Changes**: Reallocate between packages or increase total budget
- **Update Package Parameters**: Adjust frequency caps, geo targeting, or other package-specific settings
- **Pause/Resume**: Pause packages or entire buy (with reason)
- **End Early**: Terminate the buy before scheduled end date

#### What Cannot Be Changed
- Core package hypotheses or inventory sources
- The original brief (would require new proposal)
- Already-delivered impressions
- Pricing/CPM rates (without new negotiation)
- Measurement methodology mid-flight
- Provided signals or AEE configuration

### Brief Requirements

A brief must provide sufficient context for publishers to create relevant proposals:

#### Required Elements
- **Objectives**: What the campaign needs to achieve (sales, awareness, etc.)
- **Budget**: Total amount and expected CPM range with currency
- **Timing**: Flight dates for the campaign
- **Geography**: Countries/regions for delivery (hard requirement)
- **Creative**: Format requirements and what assets will be provided
- **Measurement**: How success will be measured and data sharing approach

#### Recommended Elements  
- **Target Audience**: Description of who should be reached
- **Brand Safety**: Any content restrictions or competitive separation needs
- **Preferred Inventory**: Types of media or specific publishers if relevant
- **Constraints**: Frequency caps, viewability requirements, etc.

#### Technical Elements
- **Provided Signals**: Structured data about available targeting signals
- **AEE Configuration**: If using real-time decisioning

The brief should be written in natural language with technical requirements clearly specified. Publishers' AI agents will interpret the brief and create appropriate packages.

## Specification

### get_proposal
The orchestrator requests a proposal from the publisher by providing a brief that describes objectives, target audience, available signals, measurement requirements, and budget range. The publisher responds with packages that match the brief as well as the creative assets required for each.

The proposal phase may include multiple iterations where the principal requests changes or updates to the proposed packages.

#### Request: Initial Proposal
The orchestrator should ensure that the request includes all necessary information for the publisher to create accurate packages. A proposal parser and validator will be included as part of the reference implementation, with suggestions like always providing a currency when quoting a price, being precise about measurement resolution, and being clear about creative formats and assets.

The provided signals are described separately from the brief since they come from the orchestrator and have technical implementation implications.

```json
{
  "brief": "Advertiser is a well-known sports brand looking for high-income sports enthusiasts interested in premium running gear. US only. Creative will be 6 and 15 second video with optional logo, overlay text, and endcap image. Horizontal, square, and vertical video assets will be provided. Only edge-to-edge placements or full-screen placements should be considered. The campaign will be measured based upon incremental sales at a large sports retailer, using DMA exclusions to compare packages. Approximately 50,000 exposures in a DMA will be needed to be able to see meaningful impact on sales. The media buy will run from July 1 to July 31 with an approximate budget of $150,000 USD. The principal is expecting to pay $20-25 USD CPM.",
  "provided_signals": [
    {
        "must_not_be_present": true,
        "id": "brand-safety-us-sports",
        "description": "Brand safety check for this advertiser" // description is optional
    },
    {
        "id": "recent-site-visitor",
        "targeting_direction": "include",
        "description": "Audience segment for remarketing, including approximately 0.5% of user profiles. Should be present in at least one package. Lookalikes are ok on O&O inventory."
    }
  ]
}
```

#### Response: Initial Packages
The publisher responds with packages that match the brief, pricing, estimated delivery and capacity, and required creative assets. The agent may also provide notes for the principal about potential issues or questions. The proposal should include an ID that the orchestrator can use to refer to this proposal without having to send the full context again, as well as to accept the proposal if desired.

```json
{
    "proposal_id": "july_sports_v1",
    "expiration_date": "2025-06-15 18:00:00 PST",       // optional expiration date to prevent reservation holds from impacting delivery
    "total_budget": 150000,
    "currency": "USD",
    "start_time": "2025-07-01 00:00:00 PST",
    "end_time": "2025-07-31 00:00:00 PST",
    "notes": "The brief was unclear about age, gender, or geographic preferences. Please provide more detail if available.",
    "creative_formats": [
    {
      "name": "E2E mobile video",
      "assets": {
        "video": {
          "formats": ["mp4", "webm"],
          "resolutions": [
            { "width": 1080, "height": 1080, "label": "square" },
            { "width": 1920, "height": 1080, "label": "horizontal" }
          ],
          "max_file_size_mb": 50,
          "duration_options": [6, 15]
        },
        "companion": {
          "logo": { "size": "300x300", "format": "png" },
          "overlay_image": { "size": "1080x1080", "format": "jpg", "optional": true }
        }
      },
      "description": "An immersive mobile video that scrolls in-feed"
    }
  ],
    "media_packages": [
        {
            "package_id": "abcd1",
            "name": "Remarketing with lookalikes",
            "description": "Run of site package using the provided audience to create lookalike users to ensure sufficient reach for measurement",
            "delivery_restrictions": "US only. Restricted to top 50 DMAs to ensure measurement reach.",
            "provided_signals": {
                "included_ids": ["recent-site-visitor"],
                "excluded_ids": ["brand-safety-us-sports"]
            },
            "cpm": 22.00,
            "budget": 25000,
            "budget_capacity": 150000, // could spend more here
            "creative_formats": "E2E mobile video"
        },
        {
            "package_id": "abcd2",
            "name": "Premium sports",
            "description": "Runs on our premium sports inventory across sites like 'Basketball City Gazette' and 'Yoga for Tall People'",
            "delivery_restrictions": "US only",
            "provided_signals": {
                "excluded_ids": ["brand-safety-us-sports"]
            },
            "cpm": 18.00,
            "budget": 65000,
            "budget_capacity": 65000, // this is all the projected inventory
            "creative_formats": "E2E mobile video"
        },
        {
            "package_id": "abcd3",
            "name": "Home page interstitial for runners",
            "description": "Non-skippable vertical video for known runners based on past browsing and contributed data",
            "delivery_restrictions": "US only",
            "provided_signals": {
                "excluded_ids": ["brand-safety-us-sports"]
            },
            "cpm": 47.00,
            "budget": 60000,
            "creative_formats": "Vertical mobile video"
        }
    ]
}
```

#### Request: Updates to a proposal
Passing the proposal_id tells the publisher to make changes to a proposal. The get_proposal call should not be used once a proposal has been accepted.

Any responses to the publisher's notes should be added to the brief, and all fields of the initial request should be provided again in subsequent requests, maeaning that the only state the publisher needs to maintain is the proposal ID.


```json
{
  "brief": "Advertiser is a well-known sports brand looking for high-income sports enthusiasts interested in premium running gear. US only. Creative will be 6 and 15 second video with optional logo, overlay text, and endcap image. Horizontal, square, and vertical video assets will be provided. Only edge-to-edge placements or full-screen placements should be considered. The campaign will be measured based upon incremental sales at a large sports retailer, using DMA exclusions to compare packages. Approximately 50,000 exposures in a DMA will be needed to be able to see meaningful impact on sales. The media buy will run from July 1 to July 31 with an approximate budget of $150,000 USD. The principal is expecting to pay $20-25 USD CPM. There are no additional gender, geography, or age preferences.",
  "provided_signals": [
    {
        "must_not_be_present": true,
        "id": "brand-safety-us-sports",
        "required_aee_fields": "content_id, URL, or adjacent posts",
        "description": "Brand safety check for this advertiser" // description is optional
    },
    {
        "id": "recent-site-visitor",
        "targeting_direction": "include",
        "required_aee_fields": "RampID or ID5",
        "description": "Audience segment for remarketing, including approximately 0.5% of user profiles. Should be present in at least one package. Lookalikes are ok on O&O inventory."
    }
  ],
  "proposal_id": "july_sports_v1",
  "requested_changes": [
    {
        "package_id": "abcd3",
        "field": "delivery_restrictions",
        "notes": "With a $47 CPM and a $65K budget, only 25 DMAs will have sufficient traffic for measurement. Please restrict delivery to the top 25 DMAs or reduce the price to facilitate broader testing."
    }
  ]
}
```

#### Response: Updates to a proposal
The publisher can respond to the requested changes. Any response should change the `proposal_id`, but the package IDs may stay the same.

The update call and response continue until the principal abandons or accepts the proposal.

### accept_proposal

When the principal is ready to proceed with the buy, the orchestrator accepts the proposal. Upon receiving this request, the publisher sets up the media buy and returns the media_buy_id to the orchestrator.

#### Request

```json
{
  "proposal_id": "july_sports_v2",
  "accepted_packages": ["abcd1", "abcd2", "abcd3"],
  "billing_entity": "Nike Inc.",
  "po_number": "NIKE-2025-07-001"
}
```

#### Response

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "status": "pending_creative",
  "creative_deadline": "2025-06-25T00:00:00Z",
}
```

### add_creative_assets

For the media buy to go live, the principal must provide the necessary creative assets (often requiring approval by the publisher). For publishers that generate or adapt creative on behalf of the principal, creatives may require approval by the buyer.

The buyer should provide a mechanism (third-party ad server, measurement tag, log-level data endpoint, clean room) to receive exposure data from the publisher.


#### Request

Raw assets should not be sent via MCP protocol to minimize token usage. Instead, they should be uploaded to a shared cloud bucket (which the orchestrator should provide).

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "packages": ["abcd1", "abcd2"],
  "assets": [
    {
      "creative_id": "nike_run_6s_vertical",
      "format": "E2E mobile video",
      "name": "Nike Run - 6s Vertical",
      "video_url": "https://cdn.nike.com/creatives/run_6s_vert.mp4",
      "companion_assets": {
        "logo": "https://cdn.nike.com/logos/swoosh_300.png",
        "overlay_image": "https://cdn.nike.com/endcards/run_cta.jpg"
      },
      "click_url": "https://nike.com/running?cid=social_2025",
      "package_assignments": ["abcd1", "abcd2"]
    }
  ]
}
```

#### Response  

```json
{
  "status": "received",
  "assets": [
    {
      "creative_id": "nike_run_6s_vertical",
      "status": "pending_review",
      "estimated_approval_time": "2025-06-26T18:00:00Z"
    }
  ]
}
```

### check_media_buy_status
The buyer should call `check_media_buy_status` for any pending media buy at least once a day until it is in status "ready". Any media buy that is not in "ready" status prior to the start date runs the risk of underdelivering.

#### Request

```json
{
  "media_buy_id": "buy_nike_sports_2025_07"
}
```

#### Response - Pending

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "status": "pending_creative"
}
```

#### Response - Live

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "status": "live",
  "flight_progress": {
    "days_elapsed": 14,
    "days_remaining": 17,
    "percentage_complete": 45
  },
  "delivery": {
    "impressions": 3409091,
    "spend": 75000,
    "pacing": "on_track"
  },
  "packages": [
    {
      "package_id": "abcd1",
      "status": "delivering",
      "spend": 12500,
      "pacing": "on_track"
    },
    {
      "package_id": "abcd2", 
      "status": "delivering",
      "spend": 32500,
      "pacing": "slightly_behind"
    }
  ],
  "issues": [],
  "last_updated": "2025-07-15T12:00:00Z"
}
```

### update_media_buy_performance_index

On a regular basis (ideally daily), the principal should share a report on performance vs index by package, including the time range for the measured exposures. The publisher can use this performance data to optimize packages.

#### Request

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "reporting_period": {
    "start": "2025-07-01T00:00:00Z",
    "end": "2025-07-14T23:59:59Z"
  },
  "package_performance": [
    {
      "package_id": "abcd1",
      "performance_index": 123
    },
    {
      "package_id": "abcd2",
      "performance_index": 80
    },
    {
      "package_id": "abcd3",
      "sufficient_data": false
    }
  ]
}
```

#### Response

```json
{
  "acknowledged": true,
}
```

### get_media_buy_delivery

The publisher should provide billable data on delivery by package to date, as well as media metrics like views, clicks, and completions.


#### Request

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "date_range": {
    "start": "2025-07-01T00:00:00Z",
    "end": "2025-07-14T23:59:59Z"
  }
}
```

#### Response

```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "reporting_period": {
    "start": "2025-07-01T00:00:00Z", 
    "end": "2025-07-14T23:59:59Z"
  },
  "totals": {
    "impressions": 3409091,
    "spend": 75000.00,
    "clicks": 40909,
    "video_completions": 2236364
  },
  "by_package": [
    {
      "package_id": "abcd1",
      "impressions": 568182,
      "spend": 12500.00
    },
    {
      "package_id": "abcd2",
      "impressions": 1805556,
      "spend": 32500.00
    }
  ],
  "currency": "USD"
}
```

### update_media_buy

The principal uses `update_media_buy` to request changes to packages, including updating frequency caps, budgets, pacing, and creative. The principal may also request new packages or iterations on the active packages.

#### Request Examples

**Adding approved creative to package rotation:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "action": "add_creative_to_rotation",
  "creative_id": "nike_run_15s_testimonial",
  "package_id": "abcd2"
}
```

**Removing creative from a package:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07", 
  "action": "remove_creative_from_rotation",
  "creative_id": "nike_run_6s_vertical",
  "package_id": "abcd1"
}
```

**Budget reallocation between packages:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "action": "change_package_budget",
  "package_id": "abcd1",
  "budget": 35000  // Was 25000
}
```

**Increasing total media buy budget:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "action": "change_budget",
  "budget": 170000, // was 150000
}
```

**Pausing a package:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "action": "pause_package", // can also be unpause
  "package_id": "abcd3"
}
```

**Pausing entire media buy:**
```json
{
  "media_buy_id": "buy_nike_sports_2025_07",
  "action": "pause_media_buy",
  "reason": "Product recall requires halting all advertising" // reason is optional
}
```


#### Response

```json
{
  "status": "accepted",
  "implementation_date": "2025-07-16T00:00:00Z",
  "notes": "Changes will take effect at midnight Pacific. Budget reallocation may take 24 hours to fully optimize."
}
```

#### Response - rejected

```json
{
  "status": "rejected", // note this could be "partially accepted"
  "reason": "Can't reduce budget beneath amount delivered"
}
```


## AEE (Agentic Execution Engine) Integration

### AEE Protocol Flow

1. **Publisher's ad server** makes OpenRTB request to Principal's AEE
2. **AEE evaluates** the impression against active signals
3. **AEE responds** with signal presence/absence
4. **Publisher applies** package-level decisioning

### OpenRTB Request from Publisher to AEE

```json
{
  "id": "imp_12345",
  "imp": [{
    "id": "1",
    "video": {
      "mimes": ["video/mp4"],
      "maxduration": 30,
      "protocols": [2, 3, 5, 6],
      "w": 1920,
      "h": 1080
    }
  }],
  "site": {
    "domain": "premiumsports.com",
    "cat": ["IAB17"],
    "page": "https://premiumsports.com/marathon-training"
  },
  "user": {
    "ext": {
      "rampid": "XY123456",
      "id5": "ID5_ABC789"
    }
  },
  "ext": {
    "acp": {
      "media_buy_id": "buy_nike_sports_2025_07",
      "packages": ["pkg_001", "pkg_002", "pkg_003"],
      "publisher": "premium_sports_network"
    }
  }
}
```

### AEE Response

```json
{
  "signals": {
    "present": ["nike_site_visitors", "sports_enthusiasts"],
    "absent": ["competitor_viewers"]                            // debug only
  },
  "packages": {
    "eligible": ["pkg_001", "pkg_002"],
    "ineligible": ["pkg_003"],
    "reasons": {
      "pkg_003": "frequency_cap_exceeded"                        // debug only
    }
  },
  "metadata": {
    "aee_version": "1.0",
    "processing_time_ms": 15,
    "timestamp": "2025-07-15T14:30:00Z"
  }
}
```

## Version History

- **1.0**: Initial specification (July 2025)