-- Backfill sales agents misclassified as 'buying' in member_profiles.agents JSONB.
--
-- Migration 387 (since corrected by 392 + the inference fix in 453) included a
-- JSONB-aware rewrite that flipped elem->>'type' = 'sales' to '"buying"' inside
-- member_profiles.agents. Migration 392 only restored the agent_contexts CHECK
-- constraint and left the JSONB rewrite in place, so member-registered sales
-- agents are still persisted as 'buying'.
--
-- Unlike discovered_agents (where every 'buying' row was a misclassification),
-- a member can legitimately register a buy-side agent. We use a conservative
-- discriminator that flips only when we have strong evidence the agent is
-- sell-side:
--
--   1. The agent URL appears in discovered_agents with agent_type = 'sales'.
--      Migration 453 already back-filled discovered_agents, so this is the
--      authoritative source: if we crawled the URL via adagents.json, we know
--      what the agent's exposed tools say.
--   2. The member's offerings declare 'sales_agent' AND do NOT declare
--      'buyer_agent'. An unambiguous self-declaration: the member only offers
--      sales agents, so any registered agent typed 'buying' must be a 387
--      victim.
--
-- Members offering BOTH 'buyer_agent' and 'sales_agent' are skipped to avoid
-- flipping a legitimately-registered buyer agent. Those rows can be corrected
-- once they're discovered through the federated index, or by the prevention
-- layer in PR #3 (server-side inference at registration time).

UPDATE member_profiles mp
SET agents = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'type' = 'buying' AND (
        EXISTS (
          SELECT 1 FROM discovered_agents da
          WHERE da.agent_url = elem->>'url'
            AND da.agent_type = 'sales'
        )
        OR (
          'sales_agent' = ANY(mp.offerings)
          AND NOT ('buyer_agent' = ANY(mp.offerings))
        )
      )
      THEN jsonb_set(elem, '{type}', '"sales"')
      ELSE elem
    END
  )
  FROM jsonb_array_elements(mp.agents) elem
)
WHERE mp.agents IS NOT NULL
  AND mp.agents != '[]'::jsonb
  AND mp.agents::text LIKE '%"buying"%';
