-- Materialized inventory profiles for agent search.
-- Populated by the crawler from adagents.json data.
-- Supports structured queries: "find sales agents with CTV inventory in the US."

CREATE TABLE agent_inventory_profiles (
  agent_url        TEXT PRIMARY KEY REFERENCES discovered_agents(agent_url) ON DELETE CASCADE,
  channels         TEXT[] NOT NULL DEFAULT '{}',    -- ctv, olv, display, audio, dooh, etc.
  property_types   TEXT[] NOT NULL DEFAULT '{}',    -- website, mobile_app, ctv_app, etc.
  markets          TEXT[] NOT NULL DEFAULT '{}',    -- ISO 3166-1 alpha-2 country codes
  categories       TEXT[] NOT NULL DEFAULT '{}',    -- IAB content taxonomy IDs
  tags             TEXT[] NOT NULL DEFAULT '{}',    -- publisher-defined tags
  delivery_types   TEXT[] NOT NULL DEFAULT '{}',    -- direct, delegated, ad_network
  format_ids       JSONB NOT NULL DEFAULT '[]',     -- structured format descriptors
  property_count   INT NOT NULL DEFAULT 0,
  publisher_count  INT NOT NULL DEFAULT 0,
  has_tmp          BOOLEAN NOT NULL DEFAULT false,
  category_taxonomy TEXT,                            -- e.g. 'iab_content_3.0'
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GIN indexes for array overlap queries (&&)
CREATE INDEX idx_aip_channels ON agent_inventory_profiles USING GIN (channels);
CREATE INDEX idx_aip_property_types ON agent_inventory_profiles USING GIN (property_types);
CREATE INDEX idx_aip_markets ON agent_inventory_profiles USING GIN (markets);
CREATE INDEX idx_aip_categories ON agent_inventory_profiles USING GIN (categories);
CREATE INDEX idx_aip_tags ON agent_inventory_profiles USING GIN (tags);
CREATE INDEX idx_aip_delivery_types ON agent_inventory_profiles USING GIN (delivery_types);
CREATE INDEX idx_aip_has_tmp ON agent_inventory_profiles (has_tmp) WHERE has_tmp = true;
