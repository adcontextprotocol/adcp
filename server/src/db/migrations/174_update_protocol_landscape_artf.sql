-- Migration: 174_update_protocol_landscape_artf.sql
-- Add ARTF and Prebid.org to the agentic protocol landscape perspective

UPDATE perspectives
SET content = '## Overview

As AI agents become more capable, they need standardized ways to communicate with each other and with business systems. The emerging **agentic protocol landscape** addresses this through two complementary approaches: horizontal middleware that provides foundational agent-to-agent communication, and vertical protocols that enable specific business transactions.

### Why Standards Matter

Without open standards, the AI agent ecosystem risks fragmenting into proprietary silos where agents from different vendors cannot interoperate. Open standards enable:

- **Interoperability** - Agents from different vendors can work together
- **Innovation** - Developers can build on shared infrastructure rather than reinventing basics
- **Trust** - Open governance ensures standards evolve for the community''s benefit
- **Choice** - Businesses aren''t locked into single vendor ecosystems

### The Horizontal/Vertical Framework

The agentic protocol landscape can be understood through two layers:

**Horizontal Middleware** provides the foundational layer for agent-to-agent communication. It defines how agents discover each other, exchange messages, share context, and coordinate actions - regardless of what specific business domain they operate in.

**Vertical Transaction Protocols** define how agents conduct specific types of business transactions. These protocols build on the foundational layer to enable domain-specific workflows.

## Horizontal Middleware

### Agentic AI Foundation (AAIF)

The Agentic AI Foundation is a vendor-neutral home for open source agentic AI projects hosted by the Linux Foundation. AAIF provides open governance, funding for community programs, and coordination to ensure standards evolve for the community''s benefit rather than any single company''s interests.

**Founding projects contributed to AAIF:**

- **Model Context Protocol (MCP)** - Anthropic''s protocol for connecting AI assistants to external tools and data sources
- **Agent2Agent (A2A)** - Google''s protocol for communication between AI agents
- **Agents.md** - OpenAI''s specification for agent capability documentation, adopted by 60,000+ projects
- **Goose** - Block''s open source, local-first AI agent framework

**Members include:** Amazon Web Services, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI, Shopify, Snowflake, and many others.

AAIF aims to be "what the W3C is for the Web" - a set of standards and protocols that guarantee interoperability, open access, and freedom of choice.

## Vertical Transaction Protocols

### Ad Context Protocol (AdCP)

AdCP is an open standard for AI-powered advertising workflows. It enables agents to express advertising intent, discover inventory, exchange signals, and execute media buys across publishers and platforms through a unified interface.

**Key capabilities:**

- Natural language inventory discovery and brief-based targeting
- Signal activation for audiences, contexts, and locations
- Media buy creation and optimization
- Creative format discovery and asset management

AdCP uses a task-first architecture where core advertising tasks can be accessed through multiple underlying protocols (MCP, A2A, or future protocols from AAIF).

### Agentic Commerce Protocol (ACP)

ACP is an open standard for AI-powered commerce. It enables buyer agents, merchant systems, and payment providers to coordinate checkout flows, share credentials, and complete purchases in a secure, auditable way.

**Key capabilities:**

- Product discovery and catalog navigation
- Cart management and checkout coordination
- Payment credential handling
- Order fulfillment and tracking

ACP is open source under Apache 2.0 license, allowing any business to implement the specification to transact with any AI agent or payment processor.

## Traditional Standards

Agentic protocols don''t replace existing industry infrastructure - they build on top of it. Traditional standards continue to provide essential capabilities that the agentic layer leverages.

### IAB Tech Lab

The Interactive Advertising Bureau (IAB) Tech Lab develops and maintains technical standards for the digital advertising industry. These standards form the underlying infrastructure that agentic advertising systems interact with.

**Key standards:**

- **OpenRTB** - Real-time bidding protocol for programmatic advertising
- **VAST** - Video ad serving template for video advertising
- **Open Measurement** - Viewability and verification measurement
- **ads.txt / sellers.json** - Supply chain transparency
- **ARTF (Agentic RTB Framework)** - Enables custom algorithms to run as containerized services within DSPs and SSPs

When an AI agent executes a media buy through AdCP, the underlying transaction often flows through OpenRTB-compatible systems or header bidding wrappers. Agentic protocols provide the AI-native interface; traditional protocols handle the execution.

### Prebid.org

Prebid.org is an independent organization maintaining open-source header bidding solutions. While OpenRTB defines how programmatic systems communicate, many publishers use Prebid''s header bidding wrappers to orchestrate unified auctions.

**Key projects:**

- **Prebid.js** - Client-side header bidding wrapper for web
- **Prebid Server** - Server-side header bidding solution
- **Prebid Mobile** - Header bidding for mobile apps

### How These Standards Relate

Understanding where each standard operates helps clarify their complementary roles:

| Layer | Standard | What It Does |
|-------|----------|--------------|
| **Agent Communication** | AAIF (MCP, A2A) | How agents discover each other and exchange messages |
| **Transaction Protocol** | AdCP | How buyer and seller agents negotiate and execute media buys |
| **Platform Infrastructure** | ARTF | How custom algorithms (identity, fraud, segmentation) run within ad platforms |
| **Bidding Protocol** | OpenRTB | How bid requests and responses flow between programmatic systems |
| **Header Bidding** | Prebid | How publishers run unified auctions across demand sources |

ARTF and AdCP address different problems: ARTF enables service providers to deploy platform-independent algorithms *within* DSPs and SSPs for real-time bidstream processing. AdCP enables agents to communicate *between* platforms to discover inventory and execute transactions. A media buy negotiated via AdCP might ultimately flow through platforms running ARTF-containerized services for identity resolution or fraud detection.

## Get Involved

The agentic protocol landscape is being built in the open. Whether you''re interested in horizontal middleware, vertical protocols for advertising or commerce, or traditional ad tech standards, there are opportunities to participate and shape the future.

- **[AgenticAdvertising.org](https://agenticadvertising.org/about)** - The independent industry organization advancing open standards for AI-powered advertising
- **[Agentic AI Foundation](https://aaif.io/)** - The Linux Foundation project providing vendor-neutral governance for agentic AI standards
- **[Agentic Commerce Protocol](https://www.agenticcommerce.dev/)** - Open standard for AI-powered commerce transactions
- **[Model Context Protocol](https://modelcontextprotocol.io/)** - Protocol for connecting AI assistants to external tools and data sources
- **[IAB Tech Lab](https://iabtechlab.com/)** - Develops technical standards for digital advertising
- **[ARTF Specification](https://iabtechlab.com/standards/artf/)** - Agentic RTB Framework for containerized platform services
- **[Prebid.org](https://prebid.org/)** - Open-source header bidding solutions
- **[AdCP Slack Community](https://join.slack.com/t/agenticads/shared_invite/zt-3h15gj6c0-FRTrD_y4HqmeXDKBl2TDEA)** - Join the conversation with developers building the agentic advertising ecosystem',
    tags = ARRAY['ecosystem', 'protocols', 'standards', 'AAIF', 'MCP', 'A2A', 'ARTF', 'IAB', 'Prebid']
WHERE slug = 'agentic-protocol-landscape';
