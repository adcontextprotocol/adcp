-- Content briefs generated from GEO monitoring gaps
CREATE TABLE IF NOT EXISTS geo_content_briefs (
  id SERIAL PRIMARY KEY,
  prompt_id INTEGER REFERENCES geo_prompts(id),
  prompt_category VARCHAR(50) NOT NULL,
  target_query TEXT NOT NULL,
  suggested_page_path TEXT,
  brief TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'published', 'dismissed')),
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_geo_content_briefs_status ON geo_content_briefs(status);
CREATE INDEX idx_geo_content_briefs_prompt_id ON geo_content_briefs(prompt_id);

-- Prevent duplicate active briefs for the same prompt
CREATE UNIQUE INDEX idx_geo_content_briefs_active_prompt
  ON geo_content_briefs(prompt_id)
  WHERE status IN ('draft', 'approved', 'published');
