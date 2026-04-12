-- Migrate member offerings to services.
-- Agent-derived offerings (buyer_agent, sales_agent, etc.) are removed.
-- Remaining offerings are renamed to service equivalents.

-- Map old offerings to new services:
-- si_agent → system_integration
-- data_provider → data_services
-- publisher → publisher_services
-- consulting → consulting (unchanged)
-- other → other (unchanged)
-- buyer_agent, sales_agent, creative_agent, signals_agent, governance_agent → removed (derived from brand.json)

UPDATE member_profiles
SET offerings = (
  SELECT array_agg(DISTINCT mapped)
  FROM (
    SELECT CASE
      WHEN unnest = 'si_agent' THEN 'system_integration'
      WHEN unnest = 'data_provider' THEN 'data_services'
      WHEN unnest = 'publisher' THEN 'publisher_services'
      WHEN unnest IN ('consulting', 'other') THEN unnest
      WHEN unnest IN ('agent_development', 'system_integration', 'data_services', 'publisher_services') THEN unnest
      ELSE NULL  -- Drop buyer_agent, sales_agent, creative_agent, signals_agent, governance_agent
    END as mapped
    FROM unnest(offerings)
  ) sub
  WHERE mapped IS NOT NULL
)
WHERE offerings IS NOT NULL AND array_length(offerings, 1) > 0;
