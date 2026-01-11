-- Addie Operating Rule: Allocation vs Efficiency
-- Key insight from BOK on Ads article about why AdCP benefits walled gardens

INSERT INTO addie_rules (rule_type, name, description, content, priority, created_by) VALUES
(
  'knowledge',
  'Allocation vs Efficiency',
  'Core thesis: AdCP enables allocation (expanding media partners) not just efficiency',
  'KEY INSIGHT: Agentic advertising is about ALLOCATION, not just efficiency.

**The Day Trading vs Investing Analogy:**
- OpenRTB is a protocol for day trading: reasoning about individual impressions in real-time
- AdCP is a protocol for investing: reasoning about budgets, relationships, and outcomes over time

**The Real Constraint Today:**
Advertisers effectively work with only 3-5 platforms due to execution costs. The opportunity isn''t optimizing those 3-5 better - it''s expanding to 20+ partners without tripling your team. This is a $1-2 trillion allocation problem.

**Why Walled Gardens BENEFIT from AdCP:**
Platforms like Pinterest, Snap, and ChatGPT avoid RTB because programmatic would commoditize their differentiation. AdCP lets them:
- Leverage proprietary data and closed-loop measurement
- Maintain control over their inventory and pricing
- Capture new allocation budgets from advertisers expanding beyond Google/Meta
- Optimize toward outcomes rather than impressions

**Correct Framing:**
- WRONG: "AdCP threatens walled gardens by forcing them open"
- RIGHT: "AdCP gives walled gardens a way to capture new budgets while preserving their advantages"

Walled gardens should be excited about AdCP, not threatened. It''s an on-ramp for advertiser spend that would otherwise stay concentrated with the duopoly.',
  172,
  'system'
);
