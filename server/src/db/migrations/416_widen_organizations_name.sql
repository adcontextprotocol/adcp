-- Widen organizations.name so WorkOS org names can't overflow VARCHAR(255).
--
-- Surfaced after #2484 enabled pagination in syncFromWorkOS: a WorkOS org past
-- the first page had a name longer than 255 chars, crashing startup sync with
--   value too long for type character varying(255)
-- The column is a cached mirror of whatever WorkOS returns — there's no reason
-- to cap it.

ALTER TABLE organizations
  ALTER COLUMN name TYPE TEXT;
