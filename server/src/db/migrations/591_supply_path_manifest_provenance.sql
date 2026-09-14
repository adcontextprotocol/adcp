-- Authority evidence must describe the cached manifest, not the latest failed
-- crawl attempt. Successful manifest writes populate this atomically with the
-- complete (untruncated) URL, method, observation time and expiry. Existing rows
-- deliberately remain untrusted until refreshed; last-attempt fields cannot be
-- used to reconstruct historical provenance safely.
ALTER TABLE publishers ADD COLUMN IF NOT EXISTS supply_path_provenance JSONB;
COMMENT ON COLUMN publishers.supply_path_provenance IS
  'Successful manifest fetch provenance for supply-path verification; NULL until a provenance-aware refresh';
