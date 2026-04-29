-- Backfill sales agents misclassified as 'buying' in member_profiles.agents JSONB.
--
-- Migration 387 included a JSONB-aware rewrite that flipped elem->>'type' = 'sales'
-- to '"buying"' inside member_profiles.agents. Migration 392 only restored the
-- agent_contexts CHECK constraint and left the JSONB rewrite in place, so
-- member-registered sales agents are still persisted as 'buying'.
--
-- Unlike discovered_agents (where every 'buying' row was a misclassification),
-- a member can legitimately register a buy-side agent. The discriminator must
-- not produce false positives — flipping a real buyer agent to 'sales' would
-- corrupt the registry. We use the strongest available signal:
--
--   The agent URL exists in discovered_agents with agent_type = 'sales'.
--   Post-453, this means the agent's MCP tool listing actually advertises
--   SALES_TOOLS (get_products / create_media_buy / list_authorized_properties).
--   The agent IS sell-side regardless of how the member labelled it.
--
-- An earlier draft also used `member_profiles.offerings @> 'sales_agent' AND
-- NOT 'buyer_agent'` as a fallback, but migration 388 strips those values
-- from offerings entirely, so that branch is dead at runtime. Dropped here
-- for clarity. Sales agents that haven't been crawled yet (no discovered_agents
-- row) stay as 'buying' until either a future crawl picks them up or the
-- prevention layer in PR #3 corrects them at the next registration write.

UPDATE member_profiles mp
SET agents = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'type' = 'buying' AND EXISTS (
        SELECT 1 FROM discovered_agents da
        WHERE da.agent_url = elem->>'url'
          AND da.agent_type = 'sales'
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
