-- Widen organizations.name so WorkOS org names can't overflow the column.
--
-- Surfaced after #2484 enabled pagination in syncFromWorkOS: a WorkOS org past
-- the first page had a name longer than 255 chars, crashing startup sync with
--   value too long for type character varying(255)
--
-- Increasing a varchar's length limit (as opposed to changing type to TEXT)
-- is a metadata-only change in Postgres and, crucially, does NOT trip the
-- "column used by a view or rule" check — so we don't have to drop/recreate
-- the ~10 views that select organizations.name.

ALTER TABLE organizations
  ALTER COLUMN name TYPE VARCHAR(1024);
