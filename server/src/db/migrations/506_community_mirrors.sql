-- Community-mirror catalog lifecycle (#2176).
-- First-class storage for AAO-maintained catalog-only adagents.json mirrors,
-- served at creative.adcontextprotocol.org/translated/<platform>/adagents.json
-- for platforms that have not adopted AdCP. One mirror per platform; the body
-- is a catalog-only adagents.json (authorized_agents: []) carrying formats/
-- properties/placements. Idempotent re-publish updates in place (PK = platform).
CREATE TABLE IF NOT EXISTS community_mirrors (
  platform           TEXT PRIMARY KEY CHECK (platform ~ '^[a-z0-9_-]{1,64}$'),
  adagents_json      JSONB NOT NULL,
  catalog_etag       TEXT,
  superseded_by      TEXT,
  created_by_user_id TEXT,
  created_by_email   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_mirrors_updated_at
  ON community_mirrors (updated_at DESC);

DROP TRIGGER IF EXISTS update_community_mirrors_updated_at ON community_mirrors;
CREATE TRIGGER update_community_mirrors_updated_at
  BEFORE UPDATE ON community_mirrors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE community_mirrors IS 'AAO catalog-only adagents.json mirrors for unadopted platforms, keyed by platform slug; served at /translated/<platform>/adagents.json';
COMMENT ON COLUMN community_mirrors.adagents_json IS 'Catalog-only adagents.json body (authorized_agents: []) — formats/properties/placements';
COMMENT ON COLUMN community_mirrors.catalog_etag IS 'Publisher-controlled cache validator; used for the serving ETag (falls back to a content hash when absent)';
COMMENT ON COLUMN community_mirrors.superseded_by IS 'URL of the platform-hosted adagents.json once the platform self-adopts (per the adagents.json superseded_by lifecycle)';
