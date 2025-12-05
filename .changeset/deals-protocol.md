---
"adcontextprotocol": major
---

Add Deals Protocol for inventory package discovery and activation.

**New Protocol:**
- Deals Protocol enables buyer agents to discover and activate pre-packaged and ad-hoc inventory deal packages from SSPs and curation platforms
- Alternative to Media Buy Protocol for package-based buying

**Tasks:**
- `get_deals`: Discover deal packages using natural language descriptions
- `activate_deal`: Activate deals on SSP platforms

**Core Schemas:**
- `deal.json`: Deal package with pricing, targeting, and platform availability
- `deal-pricing.json`: Pricing configuration with Floor, Fixed, and Market types, plus optional margins for curated deals
- `deal-targeting.json`: Targeting parameters including geo, devices, allow/block lists, and segments

**Deal Types:**
- **PMP (Private Marketplace)**: Direct deals with fixed or floor pricing
- **Curated**: Enhanced inventory packages with margin-based pricing

**Architecture:**
- Deals Agents integrate with Signals Agents (using Signals Protocol) to include audience targeting
- Buyer Agents interact with Deals Agents (using Deals Protocol) without directly accessing Signals Agents
- Parallel architecture to Media Buy Protocol's Sales Agent integration

**Documentation:**
- Protocol overview and specification
- Task reference documentation
- Integration examples with Signals Protocol
- Renamed from Curation Protocol to Deals Protocol
