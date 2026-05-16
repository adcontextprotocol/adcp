-- Phase B of the publisher-page redesign (.context/publisher-page-phase-b-roadmap.md):
-- record per-fetch metadata on the publishers overlay row so the
-- /api/registry/publisher hero chrome can surface verifier-grade
-- "Last verified at <ts> · HTTP <code> · <bytes>" lines, and so the
-- backend can detect HTTP-layer redirects that produce a third-party
-- resolved URL (the Case-B `self_redirected` case from Phase A's
-- backend addendum).
--
-- Backfill is implicit: every publisher gets re-crawled within the
-- 60-minute crawl cadence, so the new columns populate naturally on
-- next-fetch. UI degrades gracefully when fields are NULL (Phase A
-- already renders the hero correctly without HTTP status / bytes).
--
-- No indexes — these columns are read on the per-domain detail
-- endpoint only, never used as filter or sort keys.

ALTER TABLE publishers
  ADD COLUMN last_http_status SMALLINT,
  ADD COLUMN last_response_bytes INTEGER,
  ADD COLUMN resolved_url TEXT;

COMMENT ON COLUMN publishers.last_http_status IS
  'HTTP status code (100..599) returned by the most recent fetch attempt of the publisher origin /.well-known/adagents.json. NULL until first fetch records or transient errors that never produced an HTTP response.';
COMMENT ON COLUMN publishers.last_response_bytes IS
  'Response body byte length from the most recent fetch (post-decompression). When authoritative_location is followed, measures the canonical document body, not the stub. NULL when last_http_status is NULL.';
COMMENT ON COLUMN publishers.resolved_url IS
  'Final URL after following both HTTP-layer redirects and authoritative_location. Differs from the publisher''s expected /.well-known URL when self_redirected or aao_hosted. Lets verifiers audit the TLS chain at the actual canonical origin. NULL until first fetch.';
