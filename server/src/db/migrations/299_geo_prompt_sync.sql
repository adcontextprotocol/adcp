-- Align internal GEO prompt inventory with the external LLM Pulse project.
-- This preserves legacy prompts for history while allowing synced prompts to
-- carry stable external identifiers.

ALTER TABLE geo_prompts
  ADD COLUMN IF NOT EXISTS source VARCHAR(50) NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS external_prompt_id BIGINT,
  ADD COLUMN IF NOT EXISTS external_project_id INTEGER,
  ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_prompts_external_source
  ON geo_prompts (source, external_project_id, external_prompt_id)
  WHERE external_prompt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_geo_prompts_source_active
  ON geo_prompts (source, is_active);
