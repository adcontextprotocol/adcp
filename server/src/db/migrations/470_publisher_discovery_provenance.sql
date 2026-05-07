-- Persist discovery provenance fields from AdAgentsValidationResult onto the
-- publishers overlay row so the AAO API can surface how authorization was
-- discovered (direct vs. authoritative_location vs. ads_txt_managerdomain)
-- and, when a managerdomain hop was used, which manager domain served the
-- manifest.
--
-- These columns are set by the crawler on every successful manifest cache
-- write. Backfill is implicit: every publisher is re-crawled within the
-- 60-minute cadence, so the new columns populate naturally on next fetch.
-- Callers that see NULL can treat it as "not yet re-crawled since this
-- migration" and fall back to existing adagents_valid signal.
--
-- The CHECK constraint mirrors the DiscoveryMethod type in
-- server/src/adagents-manager.ts so the DB rejects invalid values at
-- write time rather than silently storing garbage.

ALTER TABLE publishers
  ADD COLUMN discovery_method TEXT
    CHECK (discovery_method IN ('direct', 'authoritative_location', 'ads_txt_managerdomain')),
  ADD COLUMN manager_domain TEXT;

COMMENT ON COLUMN publishers.discovery_method IS
  'How the publisher''s adagents.json was discovered on the most recent successful crawl. ''direct'': publisher''s own /.well-known/ served the document. ''authoritative_location'': publisher''s stub redirected to a third-party canonical URL. ''ads_txt_managerdomain'': discovery fell back to a manager domain via ads.txt MANAGERDOMAIN delegation. NULL until first successful crawl after migration 470.';

COMMENT ON COLUMN publishers.manager_domain IS
  'The manager domain whose adagents.json was used to authorize this publisher''s agents. Non-NULL only when discovery_method = ''ads_txt_managerdomain''. Matches the MANAGERDOMAIN value from the publisher''s ads.txt. NULL for all other discovery methods.';
