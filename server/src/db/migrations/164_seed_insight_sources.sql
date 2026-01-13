-- Seed initial high-quality insight sources
-- These represent foundational thinking that should inform Addie's core knowledge

-- ============================================================================
-- ADOPTION PHILOSOPHY (from Ben Masse email exchange)
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$The key insight about AdCP adoption is that it won't happen through a "rip and replace" approach. The industry has too much invested in existing infrastructure.

Instead, adoption will happen through:
1. New use cases that existing systems can't handle well (like AI-powered creative optimization)
2. Gradual integration where AdCP handles the "last mile" of personalization
3. Middleware layers that translate between legacy systems and AdCP

The audio industry is a good example - they adopted programmatic without abandoning their existing trafficking systems. AdCP can follow a similar path.

Trust is built through transparency and control. Publishers need to see exactly what's happening with their inventory. Advertisers need confidence that their brand safety requirements are being met. AdCP's machine-readable context provides this transparency in a way that opaque bidding systems never could.$content$,
  'adoption',
  'Ben Masse',
  'Triton Digital, audio advertising expert',
  'seed',
  'Key insights from email exchange about realistic AdCP adoption paths'
);

-- ============================================================================
-- AGENTIC ADVERTISING THESIS (core philosophy)
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$The future of advertising is not about better targeting or more efficient bidding. It's about fundamentally reimagining the relationship between advertisers and publishers.

Today's programmatic advertising is built on adversarial foundations:
- Publishers try to maximize revenue while minimizing what they give away
- Advertisers try to extract value while paying as little as possible
- Both sides use opaque systems that neither fully trusts

Agentic advertising flips this model. AI agents working on behalf of both parties can:
- Share context openly (because machines can process it without human bias)
- Negotiate in real-time based on actual campaign needs
- Build trust through transparency rather than leverage

The key insight is that AI doesn't need to "win" negotiations - it needs to find optimal matches. A publisher's agent and an advertiser's agent can collaborate rather than compete when the underlying protocol (AdCP) makes context machine-readable.

This is why AdCP matters: it's not just a technical standard, it's the foundation for a new kind of advertising relationship.$content$,
  'philosophy',
  'Brian O''Kelley',
  'AdCP Founder, AppNexus founder',
  'seed',
  'Core thesis on why agentic advertising represents a paradigm shift'
);

-- ============================================================================
-- TRUST AND TRANSPARENCY
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$The advertising industry has a trust problem that stems from information asymmetry.

In the current model:
- Publishers don't know what advertisers are willing to pay or why
- Advertisers don't know what they're really buying (viewability, fraud, etc.)
- Intermediaries profit from this opacity

AdCP addresses this by making context machine-readable and verifiable:
- Publishers can describe their inventory in rich, structured ways
- Advertisers can specify their requirements precisely
- Both sides can verify that commitments were kept

But trust isn't just about technology. It requires:
1. Governance that represents all stakeholders (hence AgenticAdvertising.org as a member organization)
2. Open standards that no single company controls
3. Reference implementations that prove the concepts work

The MCP (Model Context Protocol) foundation is key here - it's already trusted in the AI community, and AdCP builds on that foundation rather than inventing something new.$content$,
  'trust',
  NULL,
  NULL,
  'seed',
  'Principles around trust and transparency in advertising'
);

-- ============================================================================
-- PRACTICAL IMPLEMENTATION GUIDANCE
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$When implementing AdCP, start with the simplest possible integration:

1. **For Publishers**: Implement a basic AdCP server that exposes your existing inventory through get_products. Don't try to restructure your inventory taxonomy - just expose what you have.

2. **For Advertisers**: Build an AdCP client that can discover publisher inventory. Start by using it alongside your existing buying tools, not replacing them.

3. **For Both**: The creative_sync workflow is often the best starting point because:
   - It solves a real pain point (trafficking creatives is tedious)
   - It's low-risk (you're not changing how money flows)
   - It demonstrates the value of machine-readable context

The mistake most people make is trying to do too much at once. AdCP doesn't require you to change your business model or abandon existing systems. It's an additional capability, not a replacement.

Think of it like adding an API to your existing platform - you're enabling new use cases, not breaking existing ones.$content$,
  'implementation',
  NULL,
  NULL,
  'seed',
  'Practical guidance for getting started with AdCP'
);

-- ============================================================================
-- ALLOCATION VS EFFICIENCY
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$There's a fundamental philosophical difference between "efficiency" and "allocation" in advertising:

EFFICIENCY (the old model):
- Minimize cost per impression/click/conversion
- Treat advertising as a commodity to be optimized
- Win by paying less than competitors for similar inventory
- Zero-sum: your efficiency gain is the publisher's revenue loss

ALLOCATION (the agentic model):
- Match the right message to the right context
- Treat advertising as a value exchange between advertiser and consumer
- Win by creating better matches, not cheaper transactions
- Positive-sum: better allocation increases value for everyone

AdCP is designed for allocation, not efficiency. The protocol makes rich context available so that AI agents can make better matches - not so they can drive down prices.

This is a critical distinction when talking to publishers. They've been burned by "efficiency" technologies that extracted value from their businesses. AdCP should create value, not extract it.$content$,
  'philosophy',
  NULL,
  NULL,
  'seed',
  'Core distinction between efficiency and allocation models'
);

-- ============================================================================
-- AI AGENTS AND ADVERTISING
-- ============================================================================

INSERT INTO addie_insight_sources (
  source_type,
  content,
  topic,
  author_name,
  author_context,
  tagged_by,
  notes
) VALUES (
  'external',
  $content$AI agents change advertising in three fundamental ways:

1. **Complexity becomes manageable**: An AI agent can consider thousands of targeting parameters, creative variations, and placement options simultaneously. Humans can't do this - we simplify to manage complexity. This means AI can optimize across dimensions humans ignore.

2. **Real-time becomes meaningful**: When an AI agent makes decisions in milliseconds, it can respond to actual context - what article is being read, what the user journey looks like, what adjacent content surrounds the ad. RTB gave us "real-time" but humans still pre-define the rules.

3. **Negotiation becomes collaborative**: Two AI agents can exchange information and find optimal solutions in ways that human negotiations can't. This requires a shared protocol (AdCP) and a foundation of trust (verifiable context).

The opportunity for advertising is not "AI-powered targeting" (that's just better efficiency). It's AI agents that can genuinely represent the interests of their principals - advertisers, publishers, and even consumers - and negotiate outcomes that work for everyone.

This requires protocols, not just models. AdCP provides the protocol; the models come from the AI companies. Together, they enable a new kind of advertising.$content$,
  'ai-agents',
  NULL,
  NULL,
  'seed',
  'How AI agents fundamentally change advertising'
);
