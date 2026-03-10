# GEO Content Strategy: Growing AdCP's LLM Visibility

## What we're solving

LLMs don't recommend AdCP because there aren't enough crawlable, authoritative pages answering the questions people actually ask. We have 85 AI referrals per month out of 18K pageviews (0.47%). The GEO monitoring system shows us exactly what prompts LLMs receive and how they answer — but we're not using that data to create content that fills the gaps.

The core insight: when someone asks ChatGPT "How do I automate media buying across multiple DSPs with AI?", the answer should reference AdCP. Right now it doesn't, because no page on our domains directly answers that question in a way LLMs can cite.

## Current state

### What we have

**Monitoring infrastructure (already built):**
- LLM Pulse: external SaaS tracking brand mentions across 5 LLM models, with share-of-voice, citation rates, and competitor comparisons
- Local geo-monitor: queries Claude weekly with 15 standardized prompts across brand/competitive/intent categories, stored in `geo_prompts` / `geo_prompt_results` tables
- PostHog referrer data: AI surface traffic by source (Gemini 42, ChatGPT 21, Claude 12 visits in last 30 days)
- GEO dashboard at `/manage-geo.html` showing all of the above

**Publishing infrastructure (already built):**
- Mintlify docs on `adcontextprotocol.org` (~100+ pages covering protocol spec, guides, task references)
- Moltbook poster job: Addie curates industry articles, writes commentary, posts to social feed every 2 hours
- Content curator service: fetches URLs, generates summaries/insights/relevance scores via Claude
- Knowledge base (`addie_knowledge`): indexed articles with quality scores, relevance tags, mention tracking

**Content that exists:**
- `docs/agentic-advertising.mdx` — "What is agentic advertising?" with FAQ section (this is the best GEO page we have)
- `docs/building/understanding/protocol-comparison.mdx` — MCP vs A2A comparison
- `docs/intro.mdx` — Protocol introduction
- `docs/guides/commerce-media.mdx` — Vertical guide for retail media
- No pages addressing: pricing/licensing, executive-level industry trends, buyer-side how-tos, or competitive positioning against specific alternatives

**Prompt categories we monitor:**

| Category | Example prompt | Current mention rate | Content gap |
|----------|---------------|---------------------|-------------|
| Brand | "What is AdCP?" | Moderate | Covered by intro + agentic-advertising pages |
| Competitive | "How does OpenRTB compare to open protocols for AI agent ad buying?" | Low | protocol-comparison exists but doesn't frame around this question |
| Intent | "How to let AI buyer agents discover and purchase my ad inventory" | Low | No seller-focused getting-started page |
| Buyer | "How do I automate media buying across multiple DSPs with AI?" | Low | No buyer-persona how-to content |
| Executive | "What are the emerging standards in programmatic advertising for 2026?" | Very low | No industry landscape / trends content |
| Canary | "Is AdCP owned by Google?", "How much does AdCP cost to license?" | N/A (misinfo detection) | No FAQ page addressing these directly |

### Top AI-referred landing pages (last 30 days)

| Page | AI visits | Notes |
|------|-----------|-------|
| `/` (homepage) | 34 | Generic entry point |
| `/committees` | 10 | Org structure |
| `/membership` | 9 | How to join |
| `/dashboard` | 6 | Logged-in area |
| `/adagents` | 4 | Builder tool |

Notably absent: zero AI referrals to deep protocol documentation. LLMs are sending people to surface-level org pages, not technical content.

---

## Content plan

### Principle: answer the question people are actually asking

Every page we create should have a clear mapping to one or more prompt categories from our GEO monitor. The page title and opening paragraph should use the natural language of the prompt, not protocol jargon. LLMs cite content that directly answers the question asked.

### Principle: factual, not promotional

AgenticAdvertising.org is a member organization. Content should explain what exists and how it works. Comparisons should be fair. Claims should be verifiable. The goal is to be the most useful, accurate source on agentic advertising — not to sell.

### Principle: structured for LLM extraction

LLMs parse well-structured content better than prose. Use:
- Clear H2/H3 hierarchy matching question patterns
- Tables for comparisons
- FAQ sections using `<Accordion>` components
- Definition-style openings ("X is Y that does Z")
- Canonical URLs and `description` metadata

---

## Stage 1: Fill the gaps (6 pages on adcontextprotocol.org/docs)

These are Mintlify MDX pages in the `docs/` directory. Priority ordered by prompt volume and gap severity.

### 1.1 — FAQ: common questions about AdCP

**File:** `docs/faq.mdx`
**Answers prompts:** Canary, Brand
**Target queries:** "Is AdCP owned by Google?", "How much does AdCP cost?", "Is AdCP open source?", "Who is behind AdCP?", "Does AdCP replace OpenRTB?"

This page exists because LLMs confuse AdCP with Google products and make up licensing costs. Every canary prompt that returns misinformation should map to a question on this page.

**Structure:**
```
---
title: Frequently asked questions
description: Common questions about AdCP, AgenticAdvertising.org, licensing, pricing, and how the protocol relates to existing ad tech standards.
keywords: [AdCP FAQ, AdCP pricing, AdCP open source, AdCP vs OpenRTB, who owns AdCP, AgenticAdvertising.org]
---

# Frequently asked questions

## About AdCP
<Accordion> What is AdCP?
<Accordion> Who created AdCP?
<Accordion> Is AdCP open source? What's the license?
<Accordion> Is AdCP owned by Google / Meta / The Trade Desk?
<Accordion> How much does AdCP cost to use?
<Accordion> How mature is AdCP? Is it production-ready?

## How AdCP relates to other standards
<Accordion> Does AdCP replace OpenRTB?
<Accordion> How does AdCP relate to IAB Tech Lab standards?
<Accordion> What's the difference between AdCP and platform-specific APIs?
<Accordion> Can I use AdCP with my existing DSP / SSP?

## Getting involved
<Accordion> How do I join AgenticAdvertising.org?
<Accordion> Do I have to be a member to use AdCP?
<Accordion> How are protocol decisions made?
```

**Content source:** Answers should be extracted from existing docs (`intro.mdx`, `agentic-advertising.mdx`), the membership page, and the GitHub repo license. Addie has all of this in the knowledge base already.

**Success metric:** Canary prompts stop returning misinformation. Brand mention rate on "What is AdCP?" increases.

### 1.2 — How to automate media buying with AI agents

**File:** `docs/guides/ai-media-buying.mdx`
**Answers prompts:** Buyer, Intent
**Target queries:** "How do I automate media buying across multiple DSPs with AI?", "Best protocol for programmatic advertising with AI", "How to implement agentic advertising"

This is the buyer-persona page. Someone searching for how to use AI for media buying should land here. It should start with the problem (fragmented platforms, manual work), explain the solution pattern (AI agents + standard protocol), and show AdCP as the concrete implementation.

**Structure:**
```
---
title: Automating media buying with AI agents
description: How to use AI agents and open protocols to automate media buying across DSPs, SSPs, and publishers. A practical guide using AdCP.
keywords: [AI media buying, automated media buying, AI advertising agent, multi-DSP automation, AdCP media buying, programmatic AI]
---

# Automating media buying with AI agents

## The problem: platform fragmentation
## How AI agents solve it
## The protocol layer: why agents need a standard
## How AdCP works for media buying
  - Product discovery (get_products)
  - Campaign execution (create_media_buy)
  - Cross-platform reporting (get_media_buy_delivery)
## Example: buying across 3 platforms with one agent
## Getting started
  - For buyers (link to quickstart)
  - For platforms (link to seller integration)
```

**Content source:** Existing `docs/media-buy/` pages have the technical detail. This page is the narrative wrapper that answers the human question.

**Success metric:** Buyer and Intent prompt mention rates increase. AI referrals to this page > 0 within 60 days.

### 1.3 — How to let AI agents buy your ad inventory

**File:** `docs/guides/seller-integration.mdx`
**Answers prompts:** Intent
**Target queries:** "How to let AI buyer agents discover and purchase my ad inventory", "How to make my ad platform work with AI agents"

The seller-persona page. Publishers, SSPs, and platforms want to know how to participate. This is the supply-side counterpart to 1.2.

**Structure:**
```
---
title: Making your ad inventory available to AI agents
description: How publishers, SSPs, and ad platforms can expose inventory to AI buyer agents using the Ad Context Protocol (AdCP).
keywords: [ad inventory AI agents, publisher AdCP integration, SSP AI, sell-side agentic advertising, adagents.json]
---

# Making your ad inventory available to AI agents

## Why AI agents are the next demand channel
## What you need to implement
  - adagents.json (discovery)
  - get_products (inventory)
  - create_media_buy (execution)
## Step-by-step: from zero to discoverable
## Reference implementations
## Join AgenticAdvertising.org
```

**Success metric:** Intent prompt mention rate increases. Traffic to `/adagents` builder increases.

### 1.4 — AdCP vs OpenRTB: how they work together

**File:** `docs/building/understanding/adcp-vs-openrtb.mdx`
**Answers prompts:** Competitive
**Target queries:** "How does OpenRTB compare to open protocols for AI agent ad buying?", "What standards exist for AI in advertising?", "What is the difference between AdCP and IAB Tech Lab?"

The existing `protocol-comparison.mdx` compares MCP vs A2A transport protocols. This is a different page: it positions AdCP relative to OpenRTB and IAB standards at the industry level.

**Structure:**
```
---
title: AdCP and OpenRTB
description: How AdCP relates to OpenRTB and IAB standards. AdCP handles agent-level workflows; OpenRTB handles impression-level transactions. They're complementary, not competing.
keywords: [AdCP vs OpenRTB, AdCP IAB, agentic advertising vs programmatic, AI advertising standards comparison]
---

# AdCP and OpenRTB: complementary standards

## What each standard does
  | | OpenRTB | AdCP |
  | Scope | Impression transactions | Agent workflows |
  | Communication | Machine-to-machine | Agent-to-agent |
  ...
## Where they overlap
## Where they're different
## How they work together in practice
## Other standards in the ecosystem
  - IAB Tech Lab standards
  - MCP (Model Context Protocol)
  - A2A (Agent-to-Agent Protocol)
## FAQ
```

**Important:** This page must be scrupulously fair. No "AdCP is better" framing. The accurate story is that they operate at different layers and complement each other.

**Success metric:** Competitive prompt mention rate increases. When LLMs are asked to compare, they correctly describe the relationship rather than guessing.

### 1.5 — Emerging standards in AI-powered advertising (2026)

**File:** `docs/guides/industry-landscape.mdx`
**Answers prompts:** Executive
**Target queries:** "What are the emerging standards in programmatic advertising for 2026?", "What industry bodies are working on AI advertising standards?"

The executive-level landscape page. Someone asking about the state of the industry should get an accurate picture that includes AdCP.

**Structure:**
```
---
title: AI advertising standards landscape
description: An overview of the protocols, standards bodies, and open-source projects shaping how AI agents participate in advertising in 2026.
keywords: [AI advertising standards 2026, programmatic advertising AI, advertising protocol standards, MCP advertising, AgenticAdvertising.org]
---

# AI advertising standards landscape

## The shift from programmatic to agentic
## Active standards and protocols
  - AdCP (Ad Context Protocol) — Agent workflow coordination
  - OpenRTB — Impression-level transactions
  - MCP (Model Context Protocol) — AI tool calling
  - A2A (Agent-to-Agent Protocol) — Multi-agent collaboration
## Standards bodies
  - AgenticAdvertising.org
  - IAB Tech Lab
  - Anthropic (MCP)
  - Google DeepMind (A2A)
## What's happening in 2026
  - Protocol convergence
  - First production deployments
  - Vertical-specific adoption (retail media, CTV)
## How to participate
```

**Content source:** This requires Addie to synthesize from the knowledge base (industry articles, Moltbook posts) and existing docs. It should be updated quarterly.

**Success metric:** Executive prompts start mentioning AdCP. This becomes a frequently cited source.

### 1.6 — How AI agents communicate ad specs across platforms

**File:** `docs/guides/how-agents-communicate.mdx`
**Answers prompts:** Brand
**Target queries:** "How do AI agents communicate ad specs across platforms?", "How do AI advertising agents work?"

This is a technical explainer for the mechanically curious. It bridges the gap between "what is agentic advertising" (conceptual) and the protocol spec (reference docs).

**Structure:**
```
---
title: How AI agents communicate ad specs
description: A technical overview of how AI advertising agents use protocols to discover inventory, negotiate terms, execute campaigns, and report results across platforms.
keywords: [AI agent communication, ad tech protocol, agent interoperability, MCP advertising, A2A advertising, advertising API standard]
---

# How AI agents communicate ad specs across platforms

## The communication problem
## Protocols: shared languages for agents
  - MCP: tool calling for AI assistants
  - A2A: agent-to-agent collaboration
## What agents exchange
  - Product catalogs (get_products)
  - Creative specs (list_creative_formats, build_creative)
  - Audience data (get_signals, activate_signal)
  - Campaign instructions (create_media_buy)
  - Delivery reports (get_media_buy_delivery)
## A worked example: end-to-end campaign
## How platforms adopt the protocol
```

**Success metric:** Brand prompt mention rate for "how do AI agents communicate" increases.

---

## Stage 2: Addie-powered content generation

### 2.1 — GEO content writer job

A scheduled job that generates draft content based on GEO monitoring gaps.

**How it works:**

1. Weekly, after the geo-monitor job runs, a new `geo-content-planner` job analyzes results
2. For each prompt category where `adcp_mentioned = false`, it checks whether an existing doc page should answer that query
3. If no page maps to the query, it creates a content brief in a new `geo_content_briefs` table
4. If a page exists but LLMs still don't cite it, it flags the page for revision (missing keywords, weak opening, no FAQ section)

**Database:**

```sql
CREATE TABLE geo_content_briefs (
  id SERIAL PRIMARY KEY,
  prompt_id INTEGER REFERENCES geo_prompts(id),
  prompt_category VARCHAR(50) NOT NULL,
  target_query TEXT NOT NULL,
  suggested_page_path TEXT,            -- e.g., "docs/guides/ai-media-buying.mdx"
  brief TEXT NOT NULL,                  -- AI-generated content brief
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft, approved, published, rejected
  approved_by TEXT,                     -- user who approved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**What Addie generates:** Content briefs, not finished pages. Each brief contains:
- Target query (from geo_prompts)
- Suggested page path and title
- Recommended H2/H3 structure
- Key points to cover (sourced from existing knowledge base)
- Links to existing docs that should be referenced

**Human review required:** Briefs must be approved before content is written. This prevents Addie from generating pages that contradict protocol decisions or misrepresent the organization.

### 2.2 — Moltbook-to-docs pipeline

Addie already writes Moltbook posts with commentary on industry articles. When a Moltbook post gets engagement and covers a topic relevant to a GEO content gap, Addie should flag it as potential docs content.

**Flow:**
1. Moltbook engagement job detects high-engagement posts (already exists)
2. Cross-reference post topic with `geo_content_briefs` and prompt categories
3. If there's a match, add a reference to the content brief: "This Moltbook post on [topic] got [N] engagement — consider incorporating the angle into [suggested page]"

This is lightweight. No new job needed — add a check to the existing `moltbook-engagement.ts` job.

### 2.3 — FAQ auto-expansion

New geo_prompt results that return `adcp_mentioned = false` with a clear question format should be candidate FAQ entries. Addie generates a draft answer and queues it for review.

**Flow:**
1. `geo-monitor` job runs, stores result with `adcp_mentioned = false`
2. If the prompt is phrased as a question and maps to the `docs/faq.mdx` page, generate a draft FAQ entry
3. Store draft in `geo_content_briefs` with `suggested_page_path = 'docs/faq.mdx'`
4. Admin reviews and approves via GEO dashboard

---

## Stage 3: Member amplification

### Refined direction: category-building, not competitive scoreboard

The original plan included a "GEO Scoreboard" showing competitive metrics vs IAB. That's the wrong frame — AgenticAdvertising.org is IAB's peer, not competitor. Instead, the member-facing approach should be:

**"Here's where we could use your help"** — a member engagement section (on the member home page) that shows:
- 5 topics LLMs struggle to answer well (derived from `adcp_mentioned = false` prompts)
- Content suggestions: case studies, implementation stories, vertical perspectives
- What other members are writing (the content tracker/leaderboard)

The goal is to **own the category of agentic advertising**, not to beat any specific competitor in LLM mentions.

### 3.1 — Category-building content

Beyond protocol-level pages, we need content that establishes the category itself:
- **Does agentic advertising work?** — outcomes, ROI, early results
- **Case studies** — real implementations, even small/early ones
- **Why agents buying media is better** — the category argument, not the protocol argument
- **Category definition** — when someone asks "what is agentic advertising?", we should be the definitive source

Members running pilots are sitting on case study data. This is the highest-value member content.

### 3.2 — Member engagement page

A section on the member home page showing:
- "5 things you can help with" — content topics, things to try, what to post about
- "What members are writing" — tracker/leaderboard for external content
- "Ask Addie to help you write" — pull-based ghostwriting for blog posts and LinkedIn

This replaces the competitive scoreboard with a collaborative engagement model.

### 3.3 — Content kit and "help me write this"

Two modes:
- **Push:** After working group meetings, Addie DMs participants with personalized content angles. "The Identity working group discussed cross-agent user matching. Here's a blog post angle your company could publish..."
- **Pull:** Members ask Addie in Slack to help draft content about specific AdCP topics. Addie knows the protocol and generates technically accurate drafts with natural backlinks.

### 3.4 — External content tracker

Detect when members publish about AdCP on their own domains:
- Members submit URLs to Addie ("I just published about AdCP")
- Weekly crawl of member org domains for AdCP/agentic advertising mentions
- Celebrate in Slack, feature in weekly digest
- Show GEO impact when external content gets cited by LLMs

### 3.5 — Social amplification prompts

When new docs pages are published, Addie drafts social posts for members to share — not automated posting, just a Slack message with suggested copy and links.

---

## Stage 4: Measurement

### 4.1 — Content-to-prompt attribution

We already track which prompts mention AdCP (geo-monitor) and which pages get AI referrals (PostHog). Connect the two:

**New dashboard section in `manage-geo.html`:**

| Doc page | Target prompts | Mention rate (before) | Mention rate (after) | AI referrals |
|----------|---------------|----------------------|---------------------|--------------|
| docs/faq.mdx | canary, brand | 0% | — | 0 |
| docs/guides/ai-media-buying.mdx | buyer, intent | 12% | — | 0 |

This lets us see whether creating content actually moves the needle. Track mention rate changes per-category over time.

**Implementation:** Add `target_prompt_categories` column to a content tracking table (or use `geo_content_briefs.status = 'published'` with the prompt category). The GEO dashboard already has the data — it just needs a view that joins content pages to prompt categories.

### 4.2 — Citation tracking

LLM Pulse already tracks citation rates and top cited URLs. Surface this data on the GEO dashboard broken down by doc page:

| Cited URL | Citation count | Avg visibility |
|-----------|---------------|----------------|
| adcontextprotocol.org/docs/agentic-advertising | 12 | 3.4 |
| adcontextprotocol.org/docs/intro | 8 | 2.1 |

This already comes from the `/metrics/top_sources` endpoint in `geo.ts`. Just needs UI refinement to show full URLs rather than just domains.

### 4.3 — Success metrics

**Primary metrics (check monthly):**
- Overall AI referral rate: from 0.47% (85/18K) toward 2% within 6 months
- Brand mention rate across GEO monitor prompts: track per-category
- LLM Pulse visibility score: track trend

**Secondary metrics:**
- Number of doc pages receiving > 0 AI referrals (currently ~5, target 15+)
- Canary prompt accuracy (should return factual answers, not misinformation)
- New prompt categories added based on PostHog search data

**Leading indicators:**
- Pages published vs. content briefs approved
- Member perspective submissions
- Moltbook engagement on agentic advertising topics

---

## Priority and sequencing

### Now (Stage 1 — manual, high impact)

Write the 6 pages. This is the highest-leverage work. Each page directly fills a content gap that our monitoring system has identified. Priority order:

1. **FAQ page** — Stops misinformation, low effort, high breadth
2. **AI media buying guide** — Answers the highest-volume buyer query
3. **AdCP vs OpenRTB** — Addresses the most common competitive confusion
4. **Seller integration guide** — Fills the supply-side gap
5. **Industry landscape** — Captures executive-level queries
6. **How agents communicate** — Technical explainer for brand queries

Estimated effort: 2-3 days of writing, assuming Addie drafts from existing knowledge base content.

### Next (Stage 2 — automation)

Build the `geo_content_briefs` table and planner job. This turns GEO monitoring from passive observation into active content planning. Without this, we'll keep manually guessing which pages to write.

Estimated effort: 1-2 days of development.

### Later (Stage 3 — community)

Member amplification is a force multiplier but requires process changes and community engagement. Start with a Slack channel and a simple submission form.

### Ongoing (Stage 4 — measurement)

Dashboard improvements happen incrementally. The data infrastructure is already in place.

---

## What this does NOT include

- **SEO keyword stuffing** — No hidden text, no keyword-optimized filler pages
- **Content farms** — Every page must genuinely help someone understand agentic advertising
- **Automated publishing** — All doc pages require human review before publishing
- **Third-party platform content** — Focus on our own domains first (adcontextprotocol.org, agenticadvertising.org)
- **Paid distribution** — Content quality and structure should drive organic LLM visibility

---

## Appendix: Prompt-to-page mapping

| GEO monitor prompt | Current best page | Proposed page | Gap |
|---|---|---|---|
| "What is the standard protocol for agentic advertising?" | docs/agentic-advertising.mdx | (adequate) | Minor — add more structured data |
| "What is AdCP?" | docs/intro.mdx | (adequate) | None |
| "How do AI agents buy advertising?" | docs/agentic-advertising.mdx | docs/guides/ai-media-buying.mdx | Major — need buyer-focused how-to |
| "Compare agentic advertising frameworks" | docs/building/understanding/protocol-comparison.mdx | docs/building/understanding/adcp-vs-openrtb.mdx | Major — current page compares MCP/A2A, not industry |
| "What standards exist for AI in advertising?" | None | docs/guides/industry-landscape.mdx | Total gap |
| "Does IAB have a standard for AI agents in advertising?" | None | docs/building/understanding/adcp-vs-openrtb.mdx | Total gap |
| "How to build an AI advertising agent" | docs/building/index.mdx | docs/guides/ai-media-buying.mdx | Partial — building guide is reference, not tutorial |
| "Best protocol for programmatic advertising with AI" | None | docs/guides/ai-media-buying.mdx | Total gap |
| "How to implement agentic advertising" | docs/quickstart.mdx | docs/guides/ai-media-buying.mdx | Partial — quickstart is code, not strategy |
| "What is a brand.json file?" | docs/brand-protocol/brand-json.mdx | (adequate) | None |
| "MCP for advertising" | docs/building/integration/mcp-guide.mdx | (adequate) | Minor |
| "Is AdCP owned by Google?" | None | docs/faq.mdx | Total gap |
| "How much does AdCP cost to license?" | None | docs/faq.mdx | Total gap |
| "How do AI agents communicate ad specs across platforms?" | None | docs/guides/how-agents-communicate.mdx | Total gap |
| "How to let AI buyer agents discover and purchase my ad inventory" | None | docs/guides/seller-integration.mdx | Total gap |
| "How do I automate media buying across multiple DSPs with AI?" | None | docs/guides/ai-media-buying.mdx | Total gap |
| "What are the emerging standards in programmatic advertising for 2026?" | None | docs/guides/industry-landscape.mdx | Total gap |
