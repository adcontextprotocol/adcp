-- Add Prebid domain expertise to Addie's knowledge base.
-- Covers Prebid.js, Prebid Server, header bidding concepts,
-- AdCP Sales Agent + Prebid/AXE integration, and common troubleshooting.

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'Prebid Expertise',
  'Deep knowledge of Prebid.js, Prebid Server, header bidding, and how AdCP Sales Agents integrate with Prebid via AXE',
  'You have comprehensive Prebid documentation indexed. Use search_repos with repo_id "prebid-docs" for the full docs site, "prebid-js" for source code and module docs, and "prebid-server" for server source.

## Prebid.js

Client-side header bidding library that runs in the browser:
- Collects bids from 200+ demand partners (SSPs/exchanges) in parallel before the ad server call
- Passes winning bid info to the ad server (typically Google Ad Manager) via key-value targeting
- Modular architecture: core wrapper + bidder adapters + optional modules (consent, currency, floors, identity, analytics, etc.)
- Configured via pbjs.setConfig() and adUnits array defining placements, media types (banner, video, native), and bidder params
- Each bidder adapter has its own required params (documented per-adapter)

## Prebid Server

Server-side header bidding that handles bid requests on the server:
- Reduces client-side latency and battery drain, essential for mobile apps
- Supports AMP, CTV, DOOH, and mobile app environments where client-side JS can''t run
- Has its own bidder adapters (Go-based, separate from Prebid.js adapters)
- Works alongside Prebid.js via s2sConfig (hybrid client+server) or standalone
- Two implementations: prebid-server (Go) and prebid-server-java

## Key Concepts

- **Bid adapters**: Each SSP/exchange has an adapter with bidder-specific params. Configured per ad unit.
- **Modules**: Optional add-ons for consent management (GDPR/TCF, USP/CCPA, GPP), currency conversion, price floors, user identity (UID2, SharedID, etc.), real-time data (RTD), and analytics.
- **Price granularity**: Controls how bid prices are bucketed for key-value targeting. Options: low, medium, high, auto, dense, or custom buckets.
- **Ad server integration**: Prebid sets targeting keys (hb_bidder, hb_adid, hb_pb, hb_size, hb_format) on the ad server request. Line items in GAM compete with other demand based on hb_pb value.
- **First-party data**: Bidders and ad units receive first-party data via ortb2 config (site, user, imp level).
- **Auction mechanics**: First-price auction. sendAllBids sends keys for every bidder; targetingControls.allowTargetingKeys controls which keys are set.

## AdCP Sales Agent + Prebid Integration

The AdCP Sales Agent (reference implementation: salesagent repo) integrates with Prebid through the AXE (Agentic eXecution Engine) in a two-phase workflow:

**Phase 1 - Offline Setup:**
1. Buyer Agent creates campaigns with targeting and budgets via AdCP
2. Signal Agents attach audiences, brand suitability rules, contextual signals
3. Orchestrator maps campaigns to opaque AXE segment IDs and syncs data to the RTD module
4. Sales Agent creates ad server line items (in GAM/Kevel) targeting AXE key-values (axei for include, axex for exclude, axem for creative macros)

**Phase 2 - Real-Time Serving (via Prebid):**
1. User visits publisher page, triggering ad request
2. Ad server initiates request; Prebid''s RTD module sends OpenRTB request to AXE
3. AXE evaluates user/context against segment rules and returns segment decisions
4. Segment values (axei/axex/axem) are passed as key-values to the ad server
5. Ad server matches line items to segments and serves the appropriate ad

Publishers support this by integrating Prebid''s RTD module, accepting AXE key-value targeting, and declaring AXE support in their adagents.json.

## Common Troubleshooting

- **No bids returning**: Check bidder params match adapter docs, verify ad unit config (sizes, mediaTypes), check consent/privacy settings aren''t blocking, inspect network tab for bid request/response.
- **Bids not winning in GAM**: Verify line item setup matches price granularity buckets, check key-value targeting is set correctly (hb_pb, hb_bidder), ensure line items have correct priority.
- **Latency issues**: Check bidderTimeout setting, consider moving slow bidders to server-side (s2sConfig), reduce number of bidders per ad unit.
- **GDPR/consent problems**: Ensure CMP loads before Prebid, verify consentManagement module config (gdpr.cmpApi, usp.cmpApi), check that consent string is being passed to bidders.
- **Currency mismatch**: Load the currency module if bidders respond in different currencies, configure adServerCurrency.
- **Price floors not working**: Verify the priceFloors module is loaded, check floor data format, ensure floors are set before auction.

## Prebid vs AdCP

Prebid and AdCP are complementary:
- Prebid optimizes yield per impression (real-time auction for individual ad slots)
- AdCP enables budget allocation across many partners over time (campaign-level)
- A publisher can use both: Prebid for programmatic demand, AdCP for direct/agentic campaigns
- The Sales Agent bridges them: it creates ad server line items from AdCP campaigns, and Prebid''s RTD module handles real-time execution via AXE',
  162,
  'system'
);
