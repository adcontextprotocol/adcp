-- Audit trail for agent type transitions. Closes #3550, refs #3538 / #3541.
--
-- #3541 added a backfill script + crawler disagreement-log path, but the only
-- record of any flip is whatever stdout dumps during the run. Future audit
-- ("when did Bidcliq flip from buying to sales?") should answer with a row,
-- not a screen-scrape.
--
-- This table is append-only. We never UPDATE/DELETE rows here — the historical
-- record matters even after the underlying agent disappears from the registry,
-- so there is deliberately no FK to `agents` / `discovered_agents`.
--
-- Three writers (see `server/src/db/type-reclassification-log-db.ts`):
--   1. backfill_script — `server/scripts/backfill-member-agent-types.ts`
--      real-mode runs only; populates `run_id` so a single backfill is
--      groupable.
--   2. crawler_promote — `server/src/crawler.ts:refreshAgentSnapshots`
--      writes a row when stored differs from inferred (#3541's disagreement
--      path). `member_id` is null because crawler-side promotion has no
--      member context.
--   3. member_write — `server/src/routes/member-profiles.ts:resolveAgentTypes`
--      writes a row each time a profile save flips an agent's type.

CREATE TABLE IF NOT EXISTS type_reclassification_log (
  id          BIGSERIAL    PRIMARY KEY,
  agent_url   TEXT         NOT NULL,
  member_id   TEXT,                                                       -- nullable; crawler events have no member context
  old_type    TEXT,                                                       -- nullable for first-classification
  new_type    TEXT         NOT NULL,
  source      TEXT         NOT NULL CHECK (source IN ('backfill_script', 'crawler_promote', 'member_write')),
  run_id      TEXT,                                                       -- groups rows from the same backfill run
  changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  notes       JSONB                                                       -- per-event metadata, e.g. {"decision": "logged_only_no_promote"}
);

CREATE INDEX IF NOT EXISTS idx_type_reclass_log_agent
  ON type_reclassification_log (agent_url);

CREATE INDEX IF NOT EXISTS idx_type_reclass_log_member
  ON type_reclassification_log (member_id) WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_type_reclass_log_changed_at
  ON type_reclassification_log (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_type_reclass_log_run
  ON type_reclassification_log (run_id) WHERE run_id IS NOT NULL;
