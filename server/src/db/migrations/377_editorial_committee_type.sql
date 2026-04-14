-- Migration: 377_editorial_committee_type.sql
-- Editorial is an admin function (content curation/approval), not a working group.
-- Reclassify so it doesn't appear in member-facing surfaces like the digest.

UPDATE working_groups
SET committee_type = 'governance'
WHERE slug = 'editorial';
