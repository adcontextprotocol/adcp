-- Migration: 025_federated_discovery.sql
-- Purpose: Create tables for federated agent/publisher discovery
-- This enables the directory to track agents discovered from publisher adagents.json files
-- and publishers discovered from sales agents' list_authorized_properties responses.

-- Discovered agents (from adagents.json crawling)
-- These are agents we learn about by parsing publisher adagents.json files
CREATE TABLE discovered_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL,  -- 'adagents_json' or 'list_authorized_properties'
  source_domain TEXT NOT NULL, -- which domain we discovered this agent from

  -- Cached agent metadata (nullable, refreshed when we can probe the agent)
  name TEXT,
  agent_type TEXT,  -- 'sales', 'creative', 'signals', 'buyer'
  protocol TEXT DEFAULT 'mcp',

  -- Discovery metadata
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  CONSTRAINT valid_source_type CHECK (source_type IN ('adagents_json', 'list_authorized_properties'))
);

-- Discovered publishers (from sales agent list_authorized_properties responses)
-- These are publisher domains we learn about by querying sales agents
CREATE TABLE discovered_publishers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  discovered_by_agent TEXT NOT NULL, -- which sales agent told us about this domain
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  has_valid_adagents BOOLEAN DEFAULT FALSE, -- whether we found a valid adagents.json
  expires_at TIMESTAMPTZ,

  UNIQUE(domain, discovered_by_agent)
);

-- Many-to-many: agent <-> publisher authorizations
-- Records which agents are authorized for which publisher domains
-- This is populated from both directions:
--   1. From adagents.json authorized_agents array
--   2. From sales agent list_authorized_properties responses (claimed but may not be verified)
CREATE TABLE agent_publisher_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url TEXT NOT NULL,
  publisher_domain TEXT NOT NULL,
  authorized_for TEXT,  -- scope description from adagents.json
  property_ids TEXT[],  -- specific properties if authorization is limited
  source TEXT NOT NULL, -- 'adagents_json' (verified) or 'agent_claim' (unverified)
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,

  UNIQUE(agent_url, publisher_domain, source)
);

-- Indexes for fast reverse lookups
-- "Which agents are authorized for domain X?"
CREATE INDEX idx_auth_by_publisher ON agent_publisher_authorizations(publisher_domain);

-- "Which publishers does agent Y represent?"
CREATE INDEX idx_auth_by_agent ON agent_publisher_authorizations(agent_url);

-- "Which sales agents claim to sell for domain X?"
CREATE INDEX idx_discovered_publishers_domain ON discovered_publishers(domain);

-- "List all discovered agents of type X"
CREATE INDEX idx_discovered_agents_type ON discovered_agents(agent_type);

-- For cleanup of expired records
CREATE INDEX idx_discovered_agents_expires ON discovered_agents(expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX idx_discovered_publishers_expires ON discovered_publishers(expires_at)
  WHERE expires_at IS NOT NULL;
