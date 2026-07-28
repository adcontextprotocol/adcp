-- Durable declaration clocks for mutual brand/house relationship aging.

CREATE TABLE IF NOT EXISTS brand_relationship_declarations (
  house_domain TEXT NOT NULL,
  leaf_domain TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  declared_at TIMESTAMPTZ NOT NULL,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (house_domain, leaf_domain, brand_id)
);

COMMENT ON TABLE brand_relationship_declarations IS
  'Shared declaration-age anchors for canonical brand/house relationships. declared_at is publisher effective_at when present, otherwise the first observation retained across processes and deploys.';
