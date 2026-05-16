-- Persist discovery provenance fields from AdAgentsValidationResult onto the
-- publishers overlay row so the AAO API can surface how authorization was
-- discovered (direct vs. authoritative_location vs. ads_txt_managerdomain)
-- and, when a managerdomain hop was used, which manager domain served the
-- manifest.
--
-- The CHECK constraint mirrors the DiscoveryMethod type in
-- server/src/adagents-manager.ts so the DB rejects invalid values at
-- write time rather than silently storing garbage.

ALTER TABLE publishers
  ADD COLUMN discovery_method TEXT
    CHECK (discovery_method IN ('direct', 'authoritative_location', 'ads_txt_managerdomain')),
  ADD COLUMN manager_domain TEXT;

-- Backfill: every successfully-validated publisher row that exists at the
-- time of this migration was necessarily discovered via the direct path —
-- the other two methods didn't exist before 4173/4204 landed. Stamping
-- 'direct' on those rows eliminates the otherwise-confusing NULL window
-- between this migration and the next crawl cycle, so /api/validate-publisher
-- and /api/registry/publisher return a stable provenance value immediately.
UPDATE publishers
   SET discovery_method = 'direct'
 WHERE discovery_method IS NULL
   AND source_type = 'adagents_json'
   AND adagents_json IS NOT NULL;

-- Partial index supports the manager → publishers reverse lookup planned
-- in #4200 item 2 (queue-backed fan-out when a manager rotates their
-- adagents.json). Building it here is essentially free — the column is
-- mostly NULL, so the index footprint is tiny — and means item 2 ships
-- without another schema migration.
CREATE INDEX idx_publishers_manager_domain
  ON publishers (manager_domain)
  WHERE manager_domain IS NOT NULL;

COMMENT ON COLUMN publishers.discovery_method IS
  'How the publisher''s adagents.json was discovered on the most recent successful crawl. ''direct'': publisher''s own /.well-known/ served the document. ''authoritative_location'': publisher''s stub redirected to a third-party canonical URL. ''ads_txt_managerdomain'': discovery fell back to a manager domain via ads.txt MANAGERDOMAIN delegation. Backfilled to ''direct'' for previously-validated rows.';

COMMENT ON COLUMN publishers.manager_domain IS
  'The manager domain whose adagents.json was used to authorize this publisher''s agents. Non-NULL only when discovery_method = ''ads_txt_managerdomain''. Matches the MANAGERDOMAIN value from the publisher''s ads.txt. NULL for all other discovery methods.';
