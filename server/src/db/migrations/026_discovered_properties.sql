-- Migration: 026_discovered_properties.sql
-- Purpose: Store full property details from adagents.json crawling
-- This enables the registry API to return rich property data without runtime lookups

-- Discovered properties (from adagents.json properties array)
-- Each property belongs to a publisher domain and can be sold by multiple agents
CREATE TABLE discovered_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Property identification
  property_id TEXT,  -- Optional ID from adagents.json
  publisher_domain TEXT NOT NULL,

  -- Property details from adagents.json
  property_type TEXT NOT NULL,  -- website, mobile_app, ctv_app, dooh, podcast, radio, streaming_audio
  name TEXT NOT NULL,
  identifiers JSONB NOT NULL DEFAULT '[]',  -- Array of {type, value} objects
  tags TEXT[] DEFAULT '{}',

  -- Discovery metadata
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  -- Unique constraint: one property per (publisher_domain, name, property_type) combo
  -- This is the primary deduplication key
  UNIQUE(publisher_domain, name, property_type)
);

-- Partial unique index for properties with property_id
-- This ensures property_id is unique within a publisher domain when present
-- NULLs are excluded (properties without property_id dedupe via name+type above)
CREATE UNIQUE INDEX idx_properties_unique_property_id
  ON discovered_properties(publisher_domain, property_id)
  WHERE property_id IS NOT NULL;

-- Many-to-many: which agents can sell which properties
-- This links discovered_properties to agents (both registered and discovered)
CREATE TABLE agent_property_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_url TEXT NOT NULL,
  property_id UUID NOT NULL REFERENCES discovered_properties(id) ON DELETE CASCADE,
  authorized_for TEXT,  -- Scope from adagents.json
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(agent_url, property_id)
);

-- Indexes for fast lookups
-- "What properties can agent X sell?"
CREATE INDEX idx_agent_property_auth_by_agent ON agent_property_authorizations(agent_url);

-- "Which agents can sell property Y?"
CREATE INDEX idx_agent_property_auth_by_property ON agent_property_authorizations(property_id);

-- "What properties does publisher Z have?"
CREATE INDEX idx_properties_by_publisher ON discovered_properties(publisher_domain);

-- "Find properties by type (channel)"
CREATE INDEX idx_properties_by_type ON discovered_properties(property_type);

-- "Find properties by tag"
CREATE INDEX idx_properties_by_tags ON discovered_properties USING GIN(tags);

-- For cleanup of expired records
CREATE INDEX idx_discovered_properties_expires ON discovered_properties(expires_at)
  WHERE expires_at IS NOT NULL;
