-- Perspective: Signals and Planning Are the Agentic Use Case Everyone's Sleeping On
-- Based on Benjamin Masse's analysis in community discussion, April 2026

INSERT INTO perspectives (
  slug,
  content_type,
  title,
  subtitle,
  category,
  excerpt,
  content,
  author_name,
  author_title,
  content_origin,
  status,
  published_at,
  display_order,
  tags
) VALUES (
  'signals-planning-sleeper-use-case',
  'article',
  'Signals and Planning Are the Agentic Use Case Everyone''s Sleeping On',
  'Whoever builds the interoperable signal layer owns the top of the funnel before a single dollar is spent',
  'Perspective',
  'The agentic conversation is dominated by execution — automating bids, optimizing creative, managing campaigns. But the real leverage is upstream: making audience signals interoperable across partners so that allocation decisions happen before spend, not after.',
  $article$The agentic conversation in advertising is dominated by execution. Automating bids. Optimizing creative. Managing campaigns inside platforms. That work matters, but it is automation — not agentic in any meaningful sense.

The real leverage is upstream.

Today, audience insights are locked inside platforms. You get signals from Platform A in Platform A's format, and they don't translate to Platform B. The planning layer is fragmented by design. Every buyer who wants to make an informed allocation decision across partners has to manually reconcile incompatible signal formats, negotiate individual data contracts, and build custom integrations per platform.

That is where the agentic opportunity lives. The moment you make signals interoperable — discovery, segmentation, planning — you are not just automating research. You are shifting control of allocation upstream, before a single dollar is committed.

## What interoperable signals change

AdCP's [Signals protocol](/docs/signals/overview) exposes audience signals in a protocol-level format that buyer agents can query across signals agents and their participating data providers. Instead of planning inside silos, buyers get cross-partner reasoning before spend.

A buyer agent can query signals agents across the ecosystem and receive normalized results from automotive data providers, geo/mobility companies, retail purchase panels, and identity partners — all in the same format, all queryable the same way. No CSVs. No bilateral negotiations for each data source. No waiting for IO sign-offs.

That changes the planning conversation from "which platform has the segment I need?" to "given everything available across 20 partners, what is the optimal allocation?"

## Data providers control their own catalog

This is the mechanism that makes interoperability work without creating a new gatekeeper.

Each data provider publishes a signal catalog at `adagents.json` on their own domain — the same pattern publishers use to declare ad inventory. The catalog lists available signals with their value types, pricing, and which agents are authorized to resell them. An automotive intender company publishes on their domain, not on LiveRamp's or The Trade Desk's. A retail purchase panel defines their signals on their terms, not repackaged by a DSP.

Buyers verify signal provenance by fetching the data provider's own `adagents.json` and confirming the signal exists and the returning agent is authorized. This is structural verification, not trust-the-intermediary.

Today, data providers hand segments to platforms and lose control of how they are described, categorized, and priced. Their signals get repackaged and bundled in ways they have no visibility into. Signal catalogs invert this. A data provider can authorize one agent for all automotive signals but restrict another to a single segment. That granularity lives in the data provider's file, not the intermediary's system.

This also unlocks long-tail signal providers. The current ecosystem favors large data companies who can integrate with every major platform. A standardized signal catalog means a niche provider with deep automotive intender data from dealer networks can publish their catalog and be discoverable by buyer agents without needing a sales team and integration partnerships with every DSP.

## Walled gardens are not the threat

There is a common worry that walled gardens will lock this down. The pushback deserves a more precise answer.

**Inside the wall** — adding agents that optimize within Meta or Google is just automation. It does not change the allocation question. The platform already controls the loop.

**At the wall's edge** — this is where it gets interesting. Platforms that have avoided commoditizing their inventory through RTB actually have a reason to participate in upstream allocation through AdCP. They can publish a selective signal catalog — exposing select audience segments for upstream planning without opening their inventory to race-to-the-bottom bidding dynamics. A Sales Agent lets them be discoverable to buyer agents on their own terms, choosing exactly which signals to make available and to whom.

So the question is not whether walled gardens block interoperable signals. It is whether they want to be discoverable upstream or only executable downstream. AdCP makes that a choice they can make without giving up control — and signal catalogs give them fine-grained authorization to participate exactly as much as they want.

## The subversive shift

The signals use case is arguably the most subversive shift in agentic advertising — because it does not require walled garden buy-in to be transformative.

A buyer agent querying signals agents across 20 data providers and 30 publisher partners before a dollar is committed changes the planning conversation regardless of what any single platform does. The allocation decision moves from inside platforms to above them.

And the shift runs in both directions. Buyers escape platform silos for planning. Data providers escape platform silos for distribution. A data provider who publishes a signal catalog becomes discoverable to every buyer agent in the ecosystem without going through a single intermediary's marketplace.

Whoever builds the agent layer that automates signal discovery and cross-partner planning owns the top of the funnel. Not execution. Not optimization. The decision about where money goes in the first place.$article$,
  'Benjamin Masse',
  'AdCP Community',
  'member',
  'draft',
  NULL,
  0,
  ARRAY['perspective', 'signals', 'planning', 'allocation', 'thought-leadership']
) ON CONFLICT (slug) DO NOTHING;

-- Also seed into addie_knowledge so Addie can reference this argument
INSERT INTO addie_knowledge (
  title,
  category,
  content,
  source_url,
  fetch_url,
  source_type,
  fetch_status,
  last_fetched_at,
  summary,
  key_insights,
  addie_notes,
  relevance_tags,
  quality_score,
  mentions_agentic,
  mentions_adcp,
  discovery_source,
  discovery_context,
  created_by
) VALUES (
  'Signals and Planning Are the Agentic Use Case Everyone''s Sleeping On',
  'Perspective',
  'Audience research and insights are the under-the-radar agentic use case. Today, audience insights are locked inside platforms — signals from Platform A don''t translate to Platform B. The planning layer is fragmented by design. The moment you make signals interoperable (discovery, segmentation, planning), you shift control of allocation upstream, before a dollar is spent. AdCP''s Signals protocol exposes audience signals in a protocol-level format that buyer agents can query across signals agents and their data providers. The key mechanism is signal catalogs: each data provider publishes adagents.json on their own domain, listing available signals, value types, and authorized resellers. Buyers verify provenance by fetching the provider''s own file — structural verification, not trust-the-intermediary. This is seller-independent distribution: data providers control their catalog, authorization rules, and commercial terms without going through platform-specific marketplaces. On walled gardens: agents inside their walls is just automation, not agentic. Agentic only matters across environments. Platforms can publish selective signal catalogs — participating in upstream allocation without commoditizing inventory. The shift is two-directional: buyers escape platform silos for planning, data providers escape platform silos for distribution.',
  'https://agenticadvertising.org/insights/signals-planning-sleeper-use-case',
  'https://agenticadvertising.org/insights/signals-planning-sleeper-use-case',
  'perspective',
  'success',
  NOW(),
  'Benjamin Masse argues that audience signals and planning — not execution optimization — are the transformative agentic use case. Making signals interoperable across partners shifts allocation control upstream before spend. The key mechanism is signal catalogs published via adagents.json at each data provider''s own domain, enabling seller-independent distribution with structural provenance verification.',
  '[{"insight": "Signals interoperability shifts allocation control upstream, before spend happens", "importance": "high"}, {"insight": "Signal catalogs at the data provider''s domain enable seller-independent distribution without a new gatekeeper", "importance": "high"}, {"insight": "Agentic is only meaningful across environments, not within a single platform", "importance": "high"}, {"insight": "Walled gardens can publish selective signal catalogs to participate in upstream allocation on their own terms", "importance": "medium"}, {"insight": "The shift is two-directional: buyers escape silos for planning, data providers escape silos for distribution", "importance": "high"}]',
  'Ben nails it — execution optimization inside platforms is just automation wearing an agent costume. The real agentic unlock is upstream: cross-partner signal discovery and allocation planning before a dollar moves. And the mechanism that makes it work without creating a new gatekeeper? Signal catalogs published at the data provider''s own domain.',
  ARRAY['signals', 'planning', 'allocation', 'adcp', 'ai-agents'],
  5,
  true,
  true,
  'perspective_publish',
  '{"author": "Benjamin Masse", "source": "community_discussion"}',
  'system'
) ON CONFLICT (source_url) DO NOTHING;

-- Link perspective ownership to Ben's user account so it appears in his "My Content"
WITH ben_user AS (
  SELECT om.workos_user_id
  FROM member_profiles mp
  JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
  WHERE mp.slug = 'ben-masse'
  LIMIT 1
)
UPDATE perspectives p
SET author_user_id = bu.workos_user_id,
    proposer_user_id = COALESCE(p.proposer_user_id, bu.workos_user_id)
FROM ben_user bu
WHERE p.slug = 'signals-planning-sleeper-use-case'
  AND (
    p.author_user_id IS DISTINCT FROM bu.workos_user_id
    OR p.proposer_user_id IS NULL
  );

INSERT INTO content_authors (perspective_id, user_id, display_name, display_title, display_order)
SELECT
  p.id,
  om.workos_user_id,
  'Benjamin Masse',
  p.author_title,
  0
FROM perspectives p
JOIN member_profiles mp ON mp.slug = 'ben-masse'
JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
WHERE p.slug = 'signals-planning-sleeper-use-case'
ON CONFLICT (perspective_id, user_id) DO NOTHING;
