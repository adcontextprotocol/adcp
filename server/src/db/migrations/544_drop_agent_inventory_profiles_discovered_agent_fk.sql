-- Inventory profiles are built for public agents registered in member_profiles.
-- A registered agent may also appear in discovered_agents when a publisher's
-- adagents.json names it, but that discovery row is neither required nor the
-- source of truth for registry enrollment. Requiring it as a parent therefore
-- makes valid member-only agents fail the crawler's profile materialization.
--
-- Keep agent_url as the profile's primary key, but do not attach it to one of
-- the several registries from which an agent can originate.

ALTER TABLE agent_inventory_profiles
  DROP CONSTRAINT IF EXISTS agent_inventory_profiles_agent_url_fkey;
