/**
 * Seed realistic member-authored perspectives for testing.
 * Creates fake member orgs/profiles, perspectives with body content,
 * and content_authors links.
 */
import pg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: 'postgresql://adcp:localdev@localhost:62576/adcp_registry' });

const AUTHORS = [
  {
    userId: 'user_seed_june_001',
    orgId: 'org_seed_june_001',
    displayName: 'June Cheung',
    displayTitle: 'Head of Media, Woolworths Group',
    profileName: 'Woolworths Media',
    profileSlug: 'woolworths-media',
    tagline: 'Retail media network for Australia\'s largest supermarket chain',
  },
  {
    userId: 'user_seed_marcus_001',
    orgId: 'org_seed_marcus_001',
    displayName: 'Marcus Chen',
    displayTitle: 'VP Engineering, TradeDesk',
    profileName: 'TradeDesk Engineering',
    profileSlug: 'tradedesk-engineering',
    tagline: 'Building the infrastructure for programmatic advertising',
  },
  {
    userId: 'user_seed_sarah_001',
    orgId: 'org_seed_sarah_001',
    displayName: 'Sarah Kim',
    displayTitle: 'Senior Strategist, Dentsu',
    profileName: 'Dentsu Strategy',
    profileSlug: 'dentsu-strategy',
    tagline: 'Media planning and strategy for global brands',
  },
];

const ARTICLES = [
  {
    authorIdx: 0,
    slug: 'why-our-retail-media-network-is-going-agentic-first',
    title: 'Why our retail media network is going agentic-first',
    subtitle: 'We stopped asking "should we add an API?" and started asking "what if every buyer had an agent?"',
    category: 'retail media',
    excerpt: 'When we piloted agentic buying on three endemic categories, average campaign setup time dropped from four days to eleven minutes. But the real surprise was what happened to non-endemic demand.',
    body: `When I joined Woolworths Media two years ago, our retail media network was a spreadsheet operation disguised as a platform. Buyers would email insertion orders, we'd manually traffic them, and reporting came out weekly if we were lucky.

We knew we needed APIs. Every RMN does. But when we started looking at the agentic advertising protocol, we realized APIs weren't enough. The question wasn't "how do we let buyers programmatically access our inventory?" It was "what if every buyer had an agent that could discover us, evaluate us, and transact with us — without a human in the loop?"

## The pilot

We picked three endemic categories — fresh produce, household cleaning, and pet food — and stood up an adagents.json file describing our available inventory, audience segments, and measurement capabilities. We didn't build a custom integration. We just described what we had.

Within the first week, two DSPs had buyer agents that found us through the registry. One was a brand we'd been trying to close for six months through traditional sales channels.

## What surprised us

Average campaign setup time dropped from four days to eleven minutes. That was expected — automation does that. What wasn't expected was the 340% increase in non-endemic demand. Travel brands, financial services, even automotive — categories that had never considered retail media before — started showing up because their agents could evaluate our first-party purchase data against their KPIs automatically.

The agents didn't care that we were a grocery retailer. They cared that we had high-intent audiences with deterministic purchase signals.

## What I'd tell other RMN leaders

Stop thinking about agentic as an add-on to your existing sales process. It's a new distribution channel for your inventory. The brands that find you through agent discovery are different from the ones your sales team calls on. Both matter, but the agent-discovered ones scale without headcount.

We're still early. Our adagents.json describes maybe 40% of what we can actually offer. But that 40% is generating more incremental revenue than our last two sales hires combined.`,
    tags: ['retail-media', 'agentic', 'case-study'],
  },
  {
    authorIdx: 1,
    slug: 'the-real-cost-of-building-your-own-bidding-agent',
    title: 'The real cost of building your own bidding agent',
    subtitle: 'We built a custom buyer agent from scratch. Here\'s why we\'re switching to the open protocol.',
    category: 'engineering',
    excerpt: 'After 18 months and $2.3M in engineering costs, our proprietary bidding agent worked great — with exactly three publishers. The open protocol gave us 200+ in a weekend.',
    body: `I lead the team at TradeDesk that built our first autonomous bidding agent. It was a beast — custom LLM fine-tuned on five years of bid data, proprietary evaluation framework, real-time budget optimization. It took 18 months and cost us roughly $2.3 million in engineering time.

And it worked. With exactly three publishers who had agreed to build custom integrations with us.

## The integration problem

Every publisher had different APIs, different auth schemes, different ways of describing their inventory. Our agent needed custom adapters for each one. Each adapter took 2-4 weeks of engineering time, plus ongoing maintenance as publishers changed their APIs.

At that rate, we'd need to hire 40 more engineers just to cover the top 200 publishers. The math didn't work.

## What the open protocol changed

When we discovered the Agentic Commerce Protocol, the first thing I noticed was the adagents.json specification. It's a standardized way for sellers to describe their inventory, capabilities, and transaction methods. Our agent doesn't need a custom adapter for each publisher — it reads a standard format and decides whether to engage.

We rebuilt our agent's discovery and evaluation layer on top of AdCP in a weekend hackathon. That Monday, it could discover and evaluate 200+ publishers from the registry. No custom integrations. No bespoke adapters.

## The hard truth about build vs. adopt

Our custom bidding logic — the stuff that actually makes us competitive — was only about 15% of the total codebase. The other 85% was integration plumbing. The protocol handles that 85%.

If you're building a buying agent today, don't start with integrations. Start with the protocol. Invest your engineering time in the decisions that actually differentiate your buying — bid strategy, audience evaluation, creative optimization. Let the standard handle the plumbing.

The competitive advantage isn't in how you connect. It's in what you do once you're connected.`,
    tags: ['engineering', 'buyer-agent', 'protocol'],
  },
  {
    authorIdx: 2,
    slug: 'what-my-clients-actually-ask-about-agentic-advertising',
    title: 'What my clients actually ask about agentic advertising',
    subtitle: 'Spoiler: it\'s not about the technology. It\'s about trust, control, and whether their CFO will sign off.',
    category: 'strategy',
    excerpt: 'After briefing 14 enterprise clients on agentic media buying, the same three questions come up every time. None of them are about AI capabilities.',
    body: `I've spent the last three months briefing enterprise clients on agentic advertising. CPG brands, financial services, automotive — the full range. After 14 of these conversations, I can tell you the pattern.

Nobody asks about the AI. They ask about control.

## Question 1: "What happens when the agent makes a mistake?"

Every single client asks this first. Not "how smart is the agent?" but "what's the blast radius when it screws up?"

This is where governance matters more than capabilities. The Agentic Commerce Protocol has built-in campaign governance — budget caps, brand safety constraints, frequency limits — that the agent must respect. It's not a suggestion. It's a protocol-level requirement.

I show them the governance spec and watch their shoulders drop two inches. The answer they need to hear is: "The agent operates within guardrails you define, and it cannot exceed them. Period."

## Question 2: "Does this replace my agency?"

This one's for me personally, and I answer it honestly: no, it changes what I do for you.

Today, I spend 60% of my time on execution — trafficking campaigns, pulling reports, adjusting bids. Agentic handles that. What it doesn't handle is strategy — which audiences to pursue, how to position against competitors, what the brand should stand for in a given context.

My pitch is simple: you're paying senior strategist rates for junior execution work. Let's fix that.

## Question 3: "Can I see what the agent is doing?"

Transparency is non-negotiable for enterprise buyers. They need audit trails. The protocol requires agents to log every decision — why they bid on a particular impression, why they chose one publisher over another, what data they used.

This is actually better transparency than most human-run campaigns provide. When was the last time a trader documented why they shifted $50K from one publisher to another at 3pm on a Tuesday?

## The real barrier isn't technical

After 14 briefings, I'm convinced the technology is ready. The barrier is organizational. Procurement teams don't have a category for "autonomous media buying agent." Legal doesn't have a template for "agent-to-agent service agreement." Finance doesn't have a line item for "AI that spends our money."

The companies moving fastest are the ones that treat agentic as a procurement innovation, not a technology evaluation.`,
    tags: ['strategy', 'enterprise', 'buy-side'],
  },
];

async function main() {
  // Create member orgs, profiles, and memberships for each author
  for (const author of AUTHORS) {
    // Upsert org
    await pool.query(`
      INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (workos_organization_id) DO NOTHING
    `, [author.orgId, author.profileName]);

    // Upsert membership
    await pool.query(`
      INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, created_at, updated_at, synced_at)
      VALUES ($1, $2, $3, 'admin', NOW(), NOW(), NOW())
      ON CONFLICT (workos_user_id, workos_organization_id) DO NOTHING
    `, [author.userId, author.orgId, `${author.profileSlug}@seed.local`]);

    // Upsert member profile
    await pool.query(`
      INSERT INTO member_profiles (workos_organization_id, display_name, slug, tagline, is_public, created_at, updated_at)
      VALUES ($1, $2, $3, $4, true, NOW(), NOW())
      ON CONFLICT (workos_organization_id) DO UPDATE SET display_name = EXCLUDED.display_name
    `, [author.orgId, author.profileName, author.profileSlug, author.tagline]);

    console.log(`Created author: ${author.displayName} (${author.profileName})`);
  }

  // Create perspectives and link authors
  for (const article of ARTICLES) {
    const author = AUTHORS[article.authorIdx];

    // Check if already exists
    const existing = await pool.query('SELECT id FROM perspectives WHERE slug = $1', [article.slug]);
    if (existing.rows.length > 0) {
      console.log(`SKIP: ${article.slug} already exists`);
      continue;
    }

    const result = await pool.query(`
      INSERT INTO perspectives (slug, content_type, title, subtitle, category, excerpt, body, content,
        author_name, author_title, status, published_at, tags, source_type)
      VALUES ($1, 'article', $2, $3, $4, $5, $6, $6, $7, $8, 'published', NOW() - interval '1 day' * (random() * 7)::int, $9, 'member')
      RETURNING id
    `, [article.slug, article.title, article.subtitle, article.category, article.excerpt,
        article.body, author.displayName, author.displayTitle, article.tags]);

    const perspectiveId = result.rows[0].id;

    // Link author
    await pool.query(`
      INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
      VALUES ($1, $2, $3, $4, 0)
    `, [perspectiveId, author.userId, author.displayName, author.displayTitle]);

    console.log(`Created: "${article.title}" by ${author.displayName} (${perspectiveId})`);
  }

  await pool.end();
  console.log('\nDone! Now generate illustrations for these articles.');
}

main();
