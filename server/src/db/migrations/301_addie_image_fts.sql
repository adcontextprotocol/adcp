-- Add full-text search to addie_images
-- Uses a trigger to maintain the search vector since generated columns
-- require immutable expressions and to_tsvector with a named config is not immutable.

ALTER TABLE addie_images ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Function to update the search vector
CREATE OR REPLACE FUNCTION addie_images_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.alt_text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', replace(array_to_string(NEW.topics, ' '), '-', ' ')), 'C') ||
    setweight(to_tsvector('english', replace(array_to_string(NEW.characters, ' '), '-', ' ')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on insert/update
DROP TRIGGER IF EXISTS addie_images_search_vector_trigger ON addie_images;
CREATE TRIGGER addie_images_search_vector_trigger
  BEFORE INSERT OR UPDATE ON addie_images
  FOR EACH ROW EXECUTE FUNCTION addie_images_search_vector_update();

-- Backfill existing rows
UPDATE addie_images SET search_vector =
  setweight(to_tsvector('english', coalesce(alt_text, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
  setweight(to_tsvector('english', replace(array_to_string(topics, ' '), '-', ' ')), 'C') ||
  setweight(to_tsvector('english', replace(array_to_string(characters, ' '), '-', ' ')), 'D');

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_addie_images_search ON addie_images USING GIN(search_vector);
