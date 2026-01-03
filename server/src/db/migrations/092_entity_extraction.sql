-- Migration: Entity extraction tables
-- Store extracted entities from articles and link to organizations

-- Extracted entities from articles
CREATE TABLE IF NOT EXISTS article_entities (
  id SERIAL PRIMARY KEY,
  knowledge_id INTEGER NOT NULL REFERENCES addie_knowledge(id) ON DELETE CASCADE,

  -- Entity identification
  entity_type VARCHAR(50) NOT NULL, -- 'company', 'person', 'technology', 'product'
  entity_name VARCHAR(500) NOT NULL,
  entity_normalized VARCHAR(500), -- Lowercase, cleaned for matching

  -- Linking to organizations database
  organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id),

  -- Extraction metadata
  mention_count INTEGER DEFAULT 1,
  is_primary BOOLEAN DEFAULT false, -- Is this a primary subject of the article?
  confidence DECIMAL(3,2) DEFAULT 0.80, -- 0.00-1.00 extraction confidence
  context_snippet TEXT, -- Sample text where entity appears

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint: one entity per article per type
  UNIQUE(knowledge_id, entity_type, entity_normalized)
);

-- Indexes for entity queries
CREATE INDEX IF NOT EXISTS idx_article_entities_knowledge ON article_entities(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_article_entities_type ON article_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_article_entities_normalized ON article_entities(entity_normalized);
CREATE INDEX IF NOT EXISTS idx_article_entities_org ON article_entities(organization_id)
  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_article_entities_primary ON article_entities(knowledge_id)
  WHERE is_primary = true;

-- Entity aliases for matching variations like "Google" -> "Alphabet Inc."
CREATE TABLE IF NOT EXISTS entity_aliases (
  id SERIAL PRIMARY KEY,
  canonical_name VARCHAR(500) NOT NULL,
  alias VARCHAR(500) NOT NULL,
  organization_id VARCHAR(255) REFERENCES organizations(workos_organization_id),
  created_by VARCHAR(255), -- WorkOS user ID or 'system'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(alias)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical_name);
CREATE INDEX IF NOT EXISTS idx_entity_aliases_org ON entity_aliases(organization_id)
  WHERE organization_id IS NOT NULL;

-- Add extracted_entities column to addie_knowledge for raw Claude output
ALTER TABLE addie_knowledge
  ADD COLUMN IF NOT EXISTS extracted_entities JSONB;

COMMENT ON TABLE article_entities IS 'Extracted entities (companies, people, technologies) from articles';
COMMENT ON TABLE entity_aliases IS 'Mapping of entity name variations to canonical names';
COMMENT ON COLUMN addie_knowledge.extracted_entities IS 'Raw entity extraction from Claude: {companies: [], people: [], technologies: []}';
