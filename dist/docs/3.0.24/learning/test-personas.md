---
title: Learner test personas
description: "AdCP documentation test personas for evaluating how content serves different user types — from legacy builders to enterprise buyers."
"og:title": "AdCP — Learner test personas"
---

# Learner test personas

Seven personas for testing how well the AdCP documentation, website, and Addie serve different user types. Personas 1-3 are build-side (engineering implementation). Personas 4-6 are buy-side (strategy and adoption at different scales). Persona 7 tests the certification build project experience for non-coders. Each represents a realistic session and set of questions.

> **Relationship to character bible**: The character bible (see `specs/character-bible.md`) defines the illustrated characters used in walkthrough panels (Alex, Sam, Jordan, Maya, etc.). Test personas here are a separate concept — they simulate real user journeys to evaluate content quality. Where a test persona maps to a walkthrough character's role, we note the connection.

---

## Persona 1: Marcus Chen — Legacy AdCP builder

### Role
Senior engineer at an agency tech team. Built a buyer agent integration against AdCP 2.5 about nine months ago. It runs in production, placing media buys for a handful of brands.

### Background
Marcus's integration handles product discovery, creative sync, and media buy creation over MCP. He wrote it against the 2.5 schemas and hasn't touched it since launch. He saw the v3 RC announcement in Slack and knows he needs to migrate, but hasn't read the changelog yet. He's used to the protocol and doesn't need anyone to explain what MCP is or how tasks work.

### What he already knows
- The core task flow: `get_products` -> `sync_creatives` -> `create_media_buy` -> `get_media_buy_delivery`
- How `adagents.json` works for publisher discovery
- The v2 channel enum (`display`, `video`, `audio`, `native`, `social`, `ctv`, `podcast`, `dooh`, `retail`)
- Creative IDs as string arrays on packages
- `promoted_offerings` as a creative asset type
- `fixed_rate` and `price_guidance.floor` in pricing options
- `geo_postal_codes` and `geo_metros` as flat string arrays
- `optimization_goal` as a single object on a package
- How `adcp-extension.json` works for capability discovery

### What he doesn't know
- That `native` was removed as a channel (he has packages with `channels: ["native"]`)
- That `video` split into `olv`, `linear_tv`, and `cinema`
- That `creative_ids` became `creative_assignments` with weighting
- The new accounts model (`sync_accounts`, `list_accounts`, billing models)
- That `promoted_offerings` was replaced by first-class catalogs (`sync_catalogs`)
- That `brand_manifest` was replaced by `brand` ref (`{ domain, brand_id }`)
- That `adcp-extension.json` was replaced by `get_adcp_capabilities`
- That geo targeting now requires system specification
- That `optimization_goal` became `optimization_goals` (array, discriminated union)
- The existence of Brand Protocol, Governance, Sponsored Intelligence, or the Registry API

### Misconceptions and blind spots
- Assumes `native` is still a valid channel. Will be confused when validation fails.
- Assumes capability discovery still uses `adcp-extension.json`. Will look for agent card extension docs that no longer exist.
- Thinks `account_id` is just a string he passes. Doesn't know about `AccountReference` objects or the explicit vs. implicit account model.
- Expects `promoted_offering` to still be a string field on media buys.
- Assumes pricing fields haven't changed names.
- Will probably search for "migration" or "upgrade" rather than "what's new."

### Primary goal
Understand every breaking change that affects his existing integration, get a checklist of what to update, and estimate the migration effort (hours, not weeks).

### Key questions he'd ask
1. "What broke between AdCP 2.5 and 3.0?"
2. "Is there a migration guide for v2 to v3?"
3. "What replaces the native channel?"
4. "How do I update my creative_ids to the new format?"
5. "What happened to adcp-extension.json?"
6. "Do I need to implement the accounts protocol or can I skip it?"
7. "Can I run my v2 integration alongside v3 during migration?"

### Pages he'd likely visit
1. `/docs/reference/whats-new-in-v3` — First stop, looking for a summary of changes
2. `/docs/reference/migration/channels` — His `native` and `video` packages are broken
3. `/docs/reference/migration/pricing` — Fixing `fixed_rate` and `price_guidance.floor`
4. `/docs/reference/migration/creatives` — `creative_ids` to `creative_assignments`
5. `/docs/reference/migration/catalogs` — Replacing `promoted_offerings`
6. `/docs/reference/migration/geo-targeting` — System specification on geo fields
7. `/docs/reference/migration/optimization-goals` — Single goal to array
8. `/docs/reference/migration/brand-identity` — `brand_manifest` to `brand` ref
9. `/docs/accounts/overview` — Understanding the new accounts model
10. `/docs/protocol/get_adcp_capabilities` — Replacing `adcp-extension.json`

### Success criteria
- He can produce a line-item list of every code change his integration needs
- He understands which changes are renames (easy) vs. structural (harder)
- He knows which new protocol domains (accounts, governance, brand protocol) are required vs. optional for his use case
- He has enough schema detail to start writing code without guessing
- Total time from landing to "I know what I need to do": under 45 minutes

---

## Persona 2: Ravi Mehta — AI ad network builder

### Role
Engineering lead at an AI ad network startup (think Kontext or Koah). His company aggregates ad inventory across multiple AI platforms — AI assistants, AI search engines, generative AI experiences — and sells it to agencies and brands through a unified interface.

### Background
Ravi's company has partnerships with a dozen AI platforms that serve ads in their conversational and search experiences. The company's value prop is aggregation: agencies don't want to integrate with each AI platform individually, and AI platforms don't want to build their own sales teams. His ad network sits in the middle — accepting advertiser data (catalogs, budgets, brand guidelines) from agencies and distributing it to the right AI platforms.

He's been building custom integrations with each AI platform and each agency. It doesn't scale. He heard about AdCP from a partner platform that's considering implementing it. He's evaluating whether AdCP could be the standard interface on both sides of his business: buyer agents pushing data in via AdCP on the demand side, and his network pushing that data out to AI platforms on the supply side.

He knows ad tech deeply (ran ad ops at a mid-size SSP before this) and has built MCP servers before (his company already has an MCP-based prototype). He's technically fluent and reads protocol specs directly.

### What he already knows
- How ad networks aggregate supply and demand
- The difference between first-party platforms (walled gardens) and networks (multi-platform)
- MCP basics — he's built an MCP server, understands tool exposure, knows how clients connect
- Traditional programmatic: OpenRTB, prebid, SSP/DSP mechanics
- His company's pain: custom integrations per platform and per agency don't scale
- That AI platforms generate creative from brand data — his network needs to pipe that data through
- Account management across multiple advertisers and platforms
- OAuth, API key management, multi-tenant architecture

### What he doesn't know
- That AdCP has a specific `sponsored_intelligence` channel for his use case
- How `sync_catalogs` standardizes the catalog pipe he's been building custom for each platform
- How the accounts model works for a network (implicit accounts, agent-trusted model) vs. a first-party platform (explicit accounts, walled garden)
- How `adagents.json` works — he needs it for buyer agents to discover his network, and he needs to understand it from the AI platforms he connects to
- How governance policies flow through a network — do brands push content standards to his network, and does his network push them to each AI platform?
- How `optimization_goals` and `sync_event_sources` work across the network boundary — his network aggregates delivery data from multiple platforms
- Whether AdCP handles the network topology: buyer agent → ad network → AI platform, or if it assumes direct buyer-to-seller
- How Sponsored Intelligence works when the AI platform hosts the session but the brand was introduced through his network

### Misconceptions and blind spots
- **Assumes AdCP is buyer-to-seller only.** His business is a network in the middle. He's worried the protocol doesn't account for intermediaries — that he'd have to pretend to be either a buyer or a seller.
- **Thinks accounts are simple.** His network manages accounts on behalf of agencies who manage accounts on behalf of brands. He's used to this complexity but doesn't know how AdCP's account model handles multi-level delegation.
- **Assumes he needs to build the catalog pipe himself.** He's been building custom catalog sync integrations with each AI platform. Doesn't realize `sync_catalogs` is a standard that could work on both sides of his business.
- **Conflates his network's products with the underlying platform's products.** He sells "sponsored responses across AI assistants" as a single product, but each underlying AI platform has its own product IDs, pricing, and formats. He needs to understand how to model aggregated products in AdCP.
- **Thinks governance is pass-through.** Assumes he just forwards brand safety rules from buyer to platform. Doesn't know about governance policies as structured objects that his network could enforce at the routing layer before forwarding to platforms.

### Primary goal
Determine whether AdCP works for a network topology (buyer → network → platform). If yes, understand how to model his business: how does his network appear to buyers (as a seller agent), how does it interact with AI platforms (as a buyer or operator), and how do catalogs, accounts, and governance flow through the network layer.

### Key questions he'd ask
1. "Does AdCP support a network in the middle, or is it strictly buyer-to-seller?"
2. "How do I model my ad network's products when they aggregate across multiple AI platforms?"
3. "How do accounts work for a network? Agencies have accounts with me, I have accounts with each AI platform."
4. "Can I use `sync_catalogs` on both sides — accept catalogs from agencies and forward them to AI platforms?"
5. "How do governance policies and content standards flow through a network?"
6. "How does delivery reporting work when I'm aggregating across multiple platforms?"
7. "What does my `adagents.json` look like? I represent multiple publisher properties that aren't mine."
8. "How does SI work when I'm the intermediary — the brand was introduced through my network but the session runs on the AI platform?"
9. "What's the account model — `require_operator_auth: false` since I'm agent-trusted?"
10. "Are there other networks using AdCP or am I the first?"

### Pages he'd likely visit
1. `/docs/sponsored-intelligence/overview` — Core page, looking for network-specific guidance
2. `/docs/building/implementation/seller-integration` — How to appear as a seller to buyer agents
3. `/docs/accounts/overview` — Network account model (agent-trusted, implicit accounts)
4. `/docs/building/integration/accounts-and-agents` — Multi-level account delegation
5. `/docs/creative/catalogs` — Catalog sync mechanics for pass-through
6. `/docs/governance/overview` — How governance flows through intermediaries
7. `/docs/media-buy/product-discovery/media-products` — Modeling aggregated products
8. `/docs/media-buy/advanced-topics/accounts-and-security` — `adagents.json` for networks
9. `/docs/protocol/get_adcp_capabilities` — What capabilities a network declares
10. `/docs/sponsored-intelligence/overview` — SI through a network intermediary
11. `/docs/building/integration/mcp-guide` — MCP server patterns (he's familiar but wants AdCP-specific guidance)
12. `/docs/reference/media-channel-taxonomy` — `sponsored_intelligence` channel definition

### Success criteria
- He understands how his network appears to buyers (seller agent with implicit accounts) and how it interacts with AI platforms (operator with explicit accounts on each platform)
- He can model his aggregated products — products that span multiple underlying AI platforms with different pricing
- He knows how catalogs flow through: buyer → his network → AI platform, using `sync_catalogs` on both legs
- He understands the governance flow — content standards from brands can be enforced at his network layer and forwarded to platforms
- He can explain the account chain: brand → agency → his network → AI platform, and how AdCP models each relationship
- He has enough to architect the AdCP integration on both sides of his business
- Total time from landing to "I can write an architecture doc": under 90 minutes

---

## Persona 3: Tomoko Hayashi — AI platform ad infrastructure lead

### Role
Senior product manager on the ads team at a major AI assistant platform. Think ChatGPT-scale: hundreds of millions of users, strong commercial intent signals, and leadership has decided to build an ad-supported tier. She's responsible for the demand-side architecture — how advertiser data and budgets flow into the platform.

### Background
Tomoko's team has already built the serving infrastructure — the platform can render sponsored responses, inject contextual recommendations, and handle brand experience sessions. The LLM is good at generating relevant, on-brand content when it has the right inputs. The hard problem now is plumbing: how do hundreds of advertisers get their product catalogs, conversion events, brand guidelines, and content standards into the platform at scale? And how do agencies and their AI agents discover the platform's ad products and execute buys programmatically?

She's evaluated two approaches: (1) build a proprietary API and let each buyer integrate one-by-one, or (2) adopt an open standard so any compliant buyer agent can plug in. She's looking at AdCP for option 2. She's also been pitched by traditional SSPs (prebid, GAM) and is skeptical — the bid request model sends thin signals out to a remote decision-maker that doesn't have the conversation context. Her platform has the context. She wants the data to come to her.

### What she already knows
- Her platform's LLM capabilities — what it can generate when given the right brand data and context
- How ad serving works internally on her platform (sponsored response ranking, context matching, session management)
- The scale problem: onboarding advertisers one-by-one through a proprietary API doesn't scale
- That traditional programmatic (bid requests out, ads back) is a poor fit because the remote bidder doesn't have conversation context
- Basic ad tech: CPM, CPC, cost-per-engagement, fill rate, frequency capping
- That her platform needs advertiser product data to generate good ads — they've been scraping it manually for early tests
- OAuth, API design, webhook patterns — she's technical enough to evaluate protocol specs

### What she doesn't know
- That AdCP has a specific `sponsored_intelligence` channel designed for her platform's use case
- How `sync_catalogs` works as the standard pipe for getting advertiser product data in at scale
- How `sync_event_sources` lets advertisers push conversion signals in so the platform can optimize on real outcomes
- How governance policies let brands push content standards in — suitability rules the platform enforces at generation time
- How `brand.json` provides brand identity (voice, visual guidelines, positioning) that improves generated creative quality
- That `optimization_goals` on media buys tell the platform what success looks like for each campaign
- What MCP is and how it differs from building a REST API (she's been assuming she'd build REST)
- How `adagents.json` works for buyer agents to discover her platform
- How accounts work — whether she should require OAuth per advertiser or let buyer agents declare brands
- That Sponsored Intelligence is a separate protocol for multi-turn brand experiences, not just "fancy sponsored responses"

### Misconceptions and blind spots
- **Thinks the choice is proprietary API vs. SSP.** Doesn't yet see that AdCP is a third option: an open standard designed for her exact use case — receiving data in, not sending bid requests out.
- **Assumes she needs to build a REST API.** Doesn't know MCP exists as a transport that AI agents already speak natively. Her platform's buyer agents are LLMs — they already know how to call MCP tools.
- **Underestimates the catalog problem.** Her team has been manually onboarding product feeds from early advertisers. She knows this doesn't scale but doesn't realize `sync_catalogs` solves it as a standard.
- **Thinks of brand safety as a blocklist.** Doesn't know about governance policies that let brands push suitability rules into the platform — rules the LLM enforces during creative generation, not as post-hoc filtering.
- **Conflates sponsored responses with SI.** Thinks brand experience handoffs are just richer sponsored responses. Doesn't understand that SI is a separate session lifecycle where the brand's own agent takes over the conversation.
- **Assumes conversion tracking requires her own pixel/SDK.** Doesn't know `sync_event_sources` lets advertisers push their existing conversion data in so the platform can optimize without building its own measurement stack.
- **Hasn't thought about the "why not just do programmatic?" question from the other side.** She needs to articulate to her leadership why AdCP is better for her platform than integrating with an SSP — the answer is that programmatic sends thin signals out while AdCP brings rich data in, and her LLM can use that data to make better ad decisions than any remote bidder could.

### Primary goal
Decide whether to adopt AdCP as the standard interface for her platform's demand-side plumbing. If yes, understand what she needs to build (MCP server, account model, catalog ingestion, product schema) and how it compares to the alternative (proprietary REST API or SSP integration). Write a technical design doc her engineering team can act on.

### Key questions she'd ask
1. "How does AdCP get advertiser product data into my platform? Is there a standard for catalog sync?"
2. "Can advertisers push conversion events in so we can optimize on real outcomes instead of proxy metrics?"
3. "How do brand safety and content standards work? Can brands push suitability rules that my LLM enforces during creative generation?"
4. "Why would I adopt an open standard instead of building my own API? What do I get?"
5. "What's MCP and why would I build an MCP server instead of a REST API?"
6. "How do buyer agents discover my platform and its ad products?"
7. "What's the account model? Do I need OAuth per advertiser or is there a simpler path?"
8. "What's the difference between sponsored responses and Sponsored Intelligence?"
9. "Why is this better than integrating with a traditional SSP? How do I explain this to my leadership?"
10. "Who else is doing this? Are there reference implementations?"

### Pages she'd likely visit
1. `/docs/intro` — Starting point, looking for AI-specific framing
2. `/docs/sponsored-intelligence/overview` — The core page for her use case — expects to find the reversed data flow argument, catalog sync, governance, and product modeling
3. `/docs/creative/catalogs` — Deep dive on catalog sync — this is her biggest operational pain point
4. `/docs/building/implementation/seller-integration` — What she'd need to build as a seller agent
5. `/docs/governance/overview` — How content standards work as an "oracle" the platform queries/receives
6. `/docs/media-buy/media-buys/optimization-reporting` — How optimization goals and conversion events work
7. `/docs/accounts/overview` — Understanding account models (walled garden vs. agent-trusted)
8. `/docs/building/integration/mcp-guide` — Why MCP instead of REST, what an MCP server looks like
9. `/docs/sponsored-intelligence/overview` — Understanding the SI session lifecycle vs. sponsored responses
10. `/docs/media-buy/product-discovery/media-products` — How to model her inventory as products
11. `/docs/protocol/get_adcp_capabilities` — What capabilities she'd declare
12. `/docs/building/understanding/adcp-vs-openrtb` — Ammunition for the "why not SSP?" conversation with leadership

### Success criteria
- She can articulate to her leadership why AdCP is better for her platform than SSP integration — the reversed data flow argument: "We have the conversation context. AdCP brings us the brand data, conversion signals, and suitability rules so our LLM can make great ad decisions locally. SSPs would make us send thin bid requests to a remote system that doesn't have our context."
- She understands the data pipes: `sync_catalogs` for product data, `sync_event_sources` for conversion signals, governance policies for content standards, `brand.json` for brand identity, `optimization_goals` for success definitions
- She can describe the account model she'd implement and why (walled garden with OAuth, since she's a first-party platform)
- She knows the difference between implementing sponsored responses (product-level, catalog-driven) and SI (session-level, brand agent handoff)
- She can spec the MCP server her team would build: which tasks to implement, which capabilities to declare, how catalog ingestion maps to her existing infrastructure
- She has a clear comparison: AdCP (open standard, data flows in, any buyer agent can plug in) vs. proprietary API (custom per buyer, same data flow but no ecosystem) vs. SSP (wrong direction — sends signals out)
- Total time from landing to "I can write a technical design doc": under 90 minutes

---

## Persona 4: Daniela Reyes — Agency trading desk exec

### Role
VP of Programmatic at a mid-size independent agency. Her team manages $200M+ in annual digital spend across 30+ brands. She reports to the CEO and sits on the agency's AI transformation committee.

### Background
Daniela came up through trading desks — she ran programmatic operations at a holding company before joining this independent shop. She knows DSPs, SSPs, OpenRTB, and prebid inside and out. Her team is 15 traders and 3 engineers who maintain custom bidding algorithms and reporting dashboards.

She's been hearing about "AI media" from clients and at industry conferences. Two of her largest clients (a CPG brand and a financial services company) have asked her team to "figure out how to buy ads on ChatGPT and Perplexity." She tried to set up direct deals with those platforms but each requires a different API, different creative specs, different reporting formats. She's looking for a standard way to buy across AI surfaces the same way her team buys across traditional programmatic.

She's not an engineer — she doesn't write code. But she evaluates technology, makes buy/build decisions, and briefs her engineering team on what to implement. She reads docs at the conceptual level, skims schemas for shape, and focuses on workflow, economics, and competitive advantage.

### What she already knows
- Programmatic advertising deeply: DSPs, SSPs, ad exchanges, OpenRTB bid/response flow
- Campaign management: flights, budgets, pacing, optimization, frequency capping
- Creative trafficking: tag management, VAST/VPAID, DCO
- Measurement: viewability, brand safety vendors (IAS, DV), attribution, MMM
- Agency economics: margins, managed service vs. self-serve, platform fees
- That AI platforms are a new media channel and clients are asking for it
- That the current approach (direct deals per platform) doesn't scale

### What she doesn't know
- That AdCP exists as a standard for AI media buying
- What "reversed data flow" means and why it matters for her agency
- That her team could use a single buyer agent to buy across multiple AI platforms
- How catalogs replace creative tags — instead of trafficking assets, you push product data
- That AI platforms generate the creative from her brand's data
- How accounts work across platforms — does she need separate logins everywhere?
- What governance looks like in AI media — are IAS and DV relevant, or is it different?
- That optimization goals replace the DSP optimization algorithms she's used to
- What MCP is and why it matters (she thinks in terms of APIs and dashboards)
- That Sponsored Intelligence exists as a deeper brand engagement format
- How pricing works — is it auction-based like RTB, or fixed, or something else?

### Misconceptions and blind spots
- **Maps everything to programmatic.** She'll try to understand AdCP through the lens of DSPs and SSPs. "So the buyer agent is like a DSP?" "Is adagents.json like ads.txt?" Some of these analogies help, some mislead.
- **Expects a UI.** She's used to DSP dashboards. The idea that her buyer agent does everything programmatically, without a campaign management UI, is unfamiliar. She'll want to know where the dashboard is.
- **Thinks creative is her job.** In traditional programmatic, the agency builds creative and traffics it. In AI media, the platform generates creative from brand data. This is a big mental shift.
- **Assumes brand safety means the same vendors.** She'll look for IAS/DV integration. The idea that governance is built into the protocol (content standards enforced at generation time) rather than bolted on as third-party verification is new.
- **Underestimates the catalog workflow.** She thinks of product feeds as a retail media thing. Doesn't realize that ALL AI media buying starts with pushing catalogs and brand data into platforms.
- **Thinks of AI media as "just another channel."** She'll want to add it to her existing programmatic stack as a new line item. The paradigm shift — data flows in, not bid requests out — requires rethinking the workflow, not just adding a channel.

### Primary goal
Understand whether AdCP is the right standard for her agency to adopt for AI media buying. Build a business case for her CEO and a technical brief for her engineering team. Figure out the competitive advantage: if she adopts this before other agencies, does she win?

### Key questions she'd ask
1. "How is buying ads on AI platforms different from buying on a DSP?"
2. "Is there a standard way to buy across ChatGPT, Perplexity, and other AI platforms?"
3. "What does a campaign workflow look like? Where does my team fit?"
4. "Do I still need to build creative, or does the platform handle that?"
5. "How does brand safety work? Can I use IAS/DV?"
6. "What's the pricing model? Is it auction-based?"
7. "How do I report on this? Can I get it into my existing dashboards?"
8. "What do I need my engineering team to build?"
9. "How do accounts and billing work across multiple platforms?"
10. "Is anyone else doing this? What's the competitive landscape?"

### Pages she'd likely visit
1. `/` — Homepage, looking for "what is this and why should I care"
2. `/docs/intro` — Orientation, hoping for a clear value prop
3. `/docs/building/understanding/adcp-vs-openrtb` — Directly answers her "how is this different" question
4. `/docs/sponsored-intelligence/overview` — The core guide for her use case (she's the buyer)
5. `/docs/sponsored-intelligence/workflow` — Wants to see what the workflow looks like, even if she won't code it
6. `/docs/building/implementation/seller-integration` — Might read this to understand the other side
7. `/docs/governance/overview` — How brand safety works in this world
8. `/docs/creative/catalogs` — Understanding the catalog workflow
9. `/docs/accounts/overview` — How multi-platform billing works
10. `/docs/reference/media-channel-taxonomy` — Looking for `sponsored_intelligence` in the channel list

### Success criteria
- She can explain to her CEO why AI media is different from adding a new DSP, and why adopting a standard matters
- She can brief her engineering team on what to build: "We need a buyer agent that speaks AdCP. Here's the workflow: push catalogs, discover products, create media buys, pull delivery reports."
- She understands the creative paradigm shift: agencies provide brand data and catalogs, platforms generate creative
- She knows the governance model: content standards are protocol-level, generation-time enforcement, not third-party bolt-ons
- She can estimate the engineering investment and timeline for her 3-person eng team
- She sees the competitive advantage: first agency to have a working buyer agent can serve client demand for AI media faster than agencies doing direct deals
- Total time from landing to "I can present this to my CEO": under 60 minutes

---

## Persona 5: James Okafor — Brand media transformation leader

### Role
Global head of media at a Fortune 500 consumer electronics brand. Reports to the CMO. Manages a $500M annual media budget across three agency partners and a growing in-house team. He chairs the brand's "Media of the Future" initiative.

### Background
James has been in brand-side media for 15 years, moving from media planner to running the entire function. He's navigated every major shift: programmatic, social, retail media, CTV. He knows the agency relationship well — he briefs agencies on strategy and KPIs, they execute campaigns and report back. His in-house team handles retail media (Amazon, Walmart) directly and is experimenting with bringing more programmatic in-house.

His CMO has flagged AI media as the next priority. Consumers are increasingly using AI assistants to research and buy products. His brand's products are showing up in AI-generated responses — sometimes accurately, sometimes not. He wants to move from "hope the AI mentions us correctly" to "actively reach consumers in AI experiences with accurate brand messaging."

He's not technical. He thinks in terms of media strategy, brand equity, consumer journeys, and ROAS. He evaluates technology through the lens of business outcomes, agency relationships, and organizational readiness.

### What he already knows
- Media strategy and planning at scale: reach, frequency, GRPs, cross-channel allocation
- Agency management: briefing, negotiation, performance evaluation, fee structures
- Retail media: he's been through the learning curve of Amazon Ads, Walmart Connect, Instacart Ads
- Brand safety as a business risk: he's had brand safety incidents and knows the cost
- That consumers are using AI assistants to research purchases in his category
- That his competitors are starting to experiment with AI advertising
- The in-house vs. agency dynamic: some capabilities are better owned, others are better outsourced

### What he doesn't know
- What AdCP is or that a standard exists for AI advertising
- How AI advertising actually works — he's seen demos but doesn't understand the mechanics
- That the creative is generated by the AI platform from his brand's data (catalogs, brand guidelines)
- That he can push his brand's content standards into AI platforms to control how his brand appears
- That "catalog quality drives ad quality" — his product data is the creative input
- How governance works differently in AI media (generation-time enforcement vs. post-hoc verification)
- That Sponsored Intelligence lets his brand have multi-turn conversations with consumers
- How pricing works on AI platforms — it's not the same as programmatic auctions
- What his agencies need from him to execute AI media campaigns (catalogs, brand.json, content standards)
- That the organizational model for AI media looks more like retail media (data + content) than traditional programmatic (creative + targeting)

### Misconceptions and blind spots
- **Thinks AI advertising is banner ads in AI apps.** Imagines display ads next to ChatGPT's responses. Doesn't realize the AI generates the ad from his brand data — the "ad" is a sponsored response that looks and feels native to the AI experience.
- **Assumes his agencies already know how to do this.** They don't. AI media is new enough that his agencies are figuring it out too. He needs to understand enough to evaluate their proposals and push them in the right direction.
- **Thinks brand safety means the same thing.** In traditional media, brand safety = avoiding bad content adjacency. In AI media, brand safety = controlling how the AI talks about your brand. Different problem, different solution.
- **Underestimates the data requirement.** His team manages product feeds for retail media and a DAM for creative assets. He doesn't realize that AI media requires even richer brand data — product catalogs, brand voice guidelines, content standards — and that the quality of this data directly determines ad quality.
- **Assumes it's an agency problem.** He'll want to brief his agency and have them figure it out. But AI media requires brand-side inputs (catalogs, brand identity, content standards) that the agency can't generate. He needs to own the data pipeline.
- **Thinks Sponsored Intelligence is fancy retargeting.** Needs to understand that SI is a new engagement model — the consumer has a conversation with his brand inside an AI assistant.

### Primary goal
Understand what AI advertising is, whether his brand should invest, and what organizational changes are needed. Build the business case for the CMO. Brief his agencies on what to do differently. Identify what his in-house team needs to own vs. delegate.

### Key questions he'd ask
1. "What is AI advertising and how is it different from what we do today?"
2. "How do consumers experience ads in AI assistants?"
3. "Can I control how the AI talks about my brand?"
4. "What data does my team need to provide?"
5. "How does brand safety work when the AI generates the creative?"
6. "What should I ask my agencies to do?"
7. "How do I measure this? Can I get ROAS?"
8. "What does pricing look like compared to programmatic?"
9. "Is there a way to test this without a big investment?"
10. "What are my competitors doing?"

### Pages he'd likely visit
1. `/` — Homepage, looking for the big picture
2. `/docs/intro` — "Explain this to me like I'm a CMO"
3. `/docs/sponsored-intelligence/overview` — Core guide, but may bounce if it's too technical
4. `/docs/building/understanding/adcp-vs-openrtb` — Wants the comparison to what he knows
5. `/docs/creative/catalogs` — Understanding what data his team needs to provide
6. `/docs/governance/overview` — Brand safety and content standards (high priority for him)
7. `/docs/governance/content-standards/overview` — Deep dive on brand control
8. `/docs/sponsored-intelligence/overview` — Understanding the conversational engagement model
9. `/docs/creative/brand-json` — What brand identity data he needs to create
10. `/docs/learning/basics/intro` — Might try the certification to learn structured content

### Success criteria
- He can explain to his CMO what AI advertising is and why it's different from programmatic — not just "ads in AI apps" but "AI generates ads from our brand data"
- He understands the organizational implications: his team needs to own brand data quality (catalogs, brand identity, content standards) the same way they own retail media product feeds
- He can brief his agencies: "We need you to build or adopt a buyer agent that speaks AdCP. Here's what we'll provide: product catalogs, brand.json, content standards. Here's what we expect: AI media campaigns across the major AI platforms with delivery reporting."
- He knows the governance story: "We push our content standards into AI platforms. They enforce them at generation time. No more hoping the AI says the right thing about our brand."
- He sees Sponsored Intelligence as a new consumer engagement channel, not just ads
- He can articulate the competitive risk: "If we don't invest in AI media data quality now, our competitors will have better-performing ads in AI experiences because their brand data is richer"
- He has a phased plan: (1) audit brand data readiness, (2) pilot with one agency on one AI platform, (3) scale through AdCP standard
- Total time from landing to "I can present this to the CMO": under 45 minutes

---

## Persona 6: Priya Sharma — SMB e-commerce founder

### Role
Founder and sole operator of a direct-to-consumer skincare brand. Runs on Shopify. Does $2M annual revenue. Handles marketing herself with occasional freelance help. Has a product catalog of 40 SKUs.

### Background
Priya built her brand on Instagram and Google Shopping. She manages her own Meta Ads, Google Ads, and recently started on Amazon. Each platform has its own ad manager, its own creative requirements, its own pixel/conversion setup. It's manageable at three platforms, but she's hearing from her customers that they found her products through ChatGPT and Perplexity recommendations — and she has no presence there. No ads, no brand profile, no control over how her products are described.

She looked into advertising on ChatGPT and found it requires a direct sales relationship. Perplexity has a different program. Every AI platform is different. She doesn't have an agency, she doesn't have engineers, and she doesn't have time to set up and manage five more platforms individually.

She's technically capable — she can configure Shopify apps, set up Meta pixels, use Zapier — but she doesn't write code. She thinks in terms of "connect my store to this platform" and "set a budget and let it run."

### What she already knows
- How to run ads on Meta, Google, and Amazon — campaign setup, budgets, targeting, creative
- That Shopify has app integrations that connect her store to ad platforms
- Product feed management — she maintains her Google Merchant Center feed
- Basic measurement: ROAS, CPA, attribution windows
- That her products are appearing in AI assistant responses, sometimes with wrong prices or discontinued items
- That she can't currently control or improve how AI platforms represent her brand

### What she doesn't know
- That AdCP exists or what "agentic advertising" means
- That there's a standard way to connect to multiple AI platforms at once
- That her existing Shopify product feed is basically a catalog she could push to AI platforms
- That AI platforms generate ads from her product data — not from creative she uploads
- That brand.json could establish her brand identity across all AI platforms
- That content standards could prevent AI platforms from making claims about her products she hasn't approved
- That she'd likely work through a partner (ad network, Shopify app) rather than implementing AdCP directly
- What MCP or A2A are — she thinks in terms of apps and integrations, not protocols

### Misconceptions and blind spots
- **Thinks advertising on AI platforms means a dashboard.** She expects something like Meta Ads Manager — upload creative, set targeting, set budget, launch. The idea that AI platforms generate the ad from her data is unfamiliar.
- **Assumes she needs to do it platform by platform.** Just like she has separate accounts on Meta, Google, and Amazon, she assumes she'd need separate accounts on ChatGPT, Perplexity, Claude, Gemini, etc.
- **Doesn't realize her product feed is already most of what she needs.** Her Google Merchant Center feed has titles, descriptions, prices, images, availability. That's a product catalog. She just needs to push it to AI platforms through a standard pipe.
- **Thinks she can't afford this.** Associates "AI advertising" with enterprise budgets. Doesn't know that AI ad networks could let her start with $500/month across multiple platforms.
- **Underestimates the brand control problem.** Her products are already being discussed in AI conversations — sometimes incorrectly. She hasn't connected this to the opportunity: if she pushes accurate product data AND brand guidelines, the AI has the right information instead of guessing.

### Primary goal
Figure out if she can advertise on AI platforms without hiring an agency or an engineer. Understand what she'd need to provide (her product data, her brand info) and who would help her do it (a Shopify app, an ad network, a partner). Start small and see if it works.

### Key questions she'd ask
1. "Can I advertise on ChatGPT and Perplexity? How?"
2. "Do I need an agency or can I do this myself?"
3. "Can I just connect my Shopify store?"
4. "How much does it cost to get started?"
5. "Do I need to make new creative or does the AI do that?"
6. "How do I make sure the AI gets my products right — prices, descriptions, availability?"
7. "Can I control what the AI says about my brand?"
8. "How do I know if it's working? Can I see ROAS?"
9. "Is there a Shopify app for this?"
10. "What's the difference between this and just doing Google Ads?"

### Pages she'd likely visit
1. `/` — Homepage, looking for plain-language explanation
2. `/docs/intro` — Might bounce if too technical
3. `/docs/sponsored-intelligence/overview` — If the buyer section catches her, she'll read it
4. `/docs/creative/catalogs` — Wants to know if her Shopify feed works
5. `/docs/brand-protocol/brand-json` — Wants to control her brand representation
6. `/docs/governance/overview` — Wants to prevent AI from making wrong claims about her products
7. `/docs/learning/overview` — Might try the basics to understand the landscape

### Success criteria
- She understands that her existing product feed is the main ingredient she needs
- She knows she'd work through a partner (ad network, Shopify app) that handles the protocol plumbing
- She sees the value: one integration (through a partner) reaches all AI platforms vs. setting up each one individually
- She understands the brand control story: push accurate data and guidelines so AI platforms represent her brand correctly
- She's not scared off by protocol jargon — the content meets her where she is
- She has a clear next step: find an AdCP-connected partner that works with Shopify
- Total time from landing to "I know what to do next": under 20 minutes

---

## Persona 7: Lisa Tran — Non-coder doing a build project

### Role
VP of Digital at a mid-market retail brand. Manages the brand's digital media strategy and vendor relationships. Comfortable with AI coding assistants (uses Cursor daily for internal tooling prototypes) but has never written TypeScript or JavaScript by hand.

### Background
Lisa completed the C-track certification modules (C1-C3) and is starting the C4 build project. She's used Cursor to build small internal tools — Slack bots, spreadsheet automations, simple dashboards — by describing what she wants and iterating on the output. She's never read a stack trace, doesn't know what `npm` is, and thinks of "running code" as "it works when I press play in Cursor."

She passed C1-C3 because the material is conceptual — buying workflows, product discovery, campaign strategy. C4 asks her to build a working buyer agent. She understands what the agent should do (discover products, create media buys, sync creatives) but the gap between "I can describe it" and "it runs" is where she'll struggle.

### What she already knows
- AdCP buying concepts from C1-C3: product discovery, media buys, creative sync, targeting, optimization goals
- How to describe what she wants to an AI coding assistant in plain language
- The iterate-with-AI workflow: describe → generate → test → describe again
- Her brand's media buying needs — she has real context for the scenario
- That `@cptestagent` is the sandbox seller she'll test against

### What she doesn't know
- What a "running MCP server" means or how to verify one is running
- How to read error messages — she'll see `TypeError: Cannot read properties of undefined` and not know what to do
- That `npm install` or `pip install` might be needed before the code runs
- How to "paste JSON responses back" — she may not know what JSON looks like vs. other terminal output
- That her AI coding assistant needs the adcp client library specified in the prompt
- How to connect her local agent to Addie for the validation phase

### Where she'll get stuck
- **First build attempt fails.** Her AI coding assistant produces code that doesn't run. She sees an error in the terminal but doesn't know which part is the error vs. normal output.
- **Doesn't know how to iterate.** She knows how to iterate in Cursor for simple tools, but a multi-file TypeScript project with dependencies is different from a single-file Slack bot.
- **Confuses specification problems with code problems.** If the agent doesn't handle error cases, is that because her specification was incomplete or because the AI coding assistant made a mistake? She can't tell.
- **Validation phase is confusing.** "Run this MCP tool call against your local agent" — she doesn't know what that means mechanically.

### What she needs from Sage
- **Phase 1 (Specify)**: She'll do well here. She can describe a buying workflow in AdCP terms. Sage should confirm her specification is complete enough for the coding assistant.
- **Phase 2 (Build)**: When the build fails, she needs Sage to teach the debug loop — not debug for her. "Copy that error message, paste it back to Cursor, and say 'this error appeared when I tried to run it.'" If it fails again, "Tell Cursor what you're trying to build and that it should fix the error." She needs to learn that 2-3 cycles is normal, not a sign she's failing.
- **Phase 3 (Validate)**: She needs clear, mechanical instructions. Not "run get_products against your agent" but guidance on exactly how to invoke the tool and what output to copy back.
- **Phase 4 (Explain)**: She'll do well here — she understands the concepts.
- **Phase 5 (Extend)**: Same pattern as Phase 2 — specify the change, iterate with the coding assistant, bring back results.

### Success criteria
- She completes the build project without anyone writing code for her
- She learns the debug loop: error → paste to assistant → iterate
- She's not blocked for more than 5 minutes on any mechanical step
- The experience feels like coaching, not like failing at engineering
- She'd recommend the certification to a peer who also doesn't code
