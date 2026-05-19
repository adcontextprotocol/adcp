-- registry_audit_log.resource_id was declared VARCHAR(255) in 030_recreate_audit_log.sql.
-- Several admin actions write resource identifiers that can exceed that cap —
-- agent URLs with signed-CDN tokens or query strings routinely overflow.
-- Overflow raises 22001 mid-transaction and rolls back the originating
-- mutation (e.g. the admin agent removal added in #4498), with no signal to
-- the caller that the cause was column width.
--
-- TEXT has identical storage characteristics for short values and no cap.
-- No data conversion needed.

ALTER TABLE registry_audit_log ALTER COLUMN resource_id TYPE TEXT;
