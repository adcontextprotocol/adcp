-- Perspective Illustrations
-- AI-generated editorial illustrations for perspective articles, via Gemini.

CREATE TABLE IF NOT EXISTS perspective_illustrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perspective_id UUID NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  image_data BYTEA,
  prompt_used TEXT,
  author_description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'approved', 'rejected')),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perspective_illustrations_perspective
  ON perspective_illustrations(perspective_id);
CREATE INDEX IF NOT EXISTS idx_perspective_illustrations_status
  ON perspective_illustrations(status);

CREATE TRIGGER update_perspective_illustrations_updated_at
  BEFORE UPDATE ON perspective_illustrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Active illustration pointer on perspectives
ALTER TABLE perspectives
  ADD COLUMN IF NOT EXISTS illustration_id UUID REFERENCES perspective_illustrations(id);
