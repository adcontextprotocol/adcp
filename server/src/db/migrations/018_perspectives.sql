-- Migration: 017_perspectives.sql
-- Perspectives/Insights content management system
-- Supports both full markdown articles and external links

-- Perspectives table for managing insights/articles content
CREATE TABLE IF NOT EXISTS perspectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Content identification
  slug VARCHAR(255) UNIQUE NOT NULL,  -- URL-friendly identifier

  -- Content type: 'article' for full content, 'link' for external links
  content_type VARCHAR(50) NOT NULL DEFAULT 'article'
    CHECK (content_type IN ('article', 'link')),

  -- Display content
  title VARCHAR(500) NOT NULL,
  subtitle VARCHAR(1000),
  category VARCHAR(100),  -- e.g., 'Press Release', 'Op-Ed', 'Ecosystem', etc.
  excerpt TEXT,  -- Short description for cards/listings

  -- Full article content (markdown) - used when content_type = 'article'
  content TEXT,

  -- External link - used when content_type = 'link'
  external_url TEXT,
  external_site_name VARCHAR(255),  -- e.g., 'Substack', 'Forbes', etc.

  -- Author information
  author_name VARCHAR(255),
  author_title VARCHAR(255),

  -- Featured image for cards
  featured_image_url TEXT,

  -- Publishing
  status VARCHAR(50) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMP WITH TIME ZONE,

  -- Display ordering (lower numbers appear first)
  display_order INTEGER DEFAULT 0,

  -- Optional tags for filtering
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],

  -- Flexible metadata for future extensions
  metadata JSONB NOT NULL DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_perspectives_slug ON perspectives(slug);
CREATE INDEX IF NOT EXISTS idx_perspectives_status ON perspectives(status);
CREATE INDEX IF NOT EXISTS idx_perspectives_published_at ON perspectives(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_perspectives_content_type ON perspectives(content_type);
CREATE INDEX IF NOT EXISTS idx_perspectives_display_order ON perspectives(display_order, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_perspectives_tags ON perspectives USING GIN(tags);

-- Trigger for updated_at timestamp
CREATE TRIGGER update_perspectives_updated_at
  BEFORE UPDATE ON perspectives
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE perspectives IS 'Stores insights/perspectives content including articles and external links';
COMMENT ON COLUMN perspectives.content_type IS 'article = full markdown content stored here, link = external URL';
COMMENT ON COLUMN perspectives.slug IS 'URL-friendly identifier, used for /insights/{slug} routes';
COMMENT ON COLUMN perspectives.category IS 'Display category like Press Release, Op-Ed, Ecosystem, etc.';
COMMENT ON COLUMN perspectives.display_order IS 'Lower numbers appear first in listings';
