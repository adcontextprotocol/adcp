-- Cache for brand logo binary data, downloaded from external sources (e.g. Brandfetch CDN).
-- Logos are served from /logos/brands/:domain/:idx so external agents can download them.
CREATE TABLE brand_logo_cache (
  domain TEXT NOT NULL,
  idx INT NOT NULL,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, idx)
);
