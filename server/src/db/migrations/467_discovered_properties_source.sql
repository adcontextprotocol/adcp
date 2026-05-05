-- Migration: 467_discovered_properties_source.sql
-- Purpose: Add source column to discovered_properties to distinguish crawler-written
-- rows from hosted-sync-written rows, enabling full property reconciliation on re-sync.
--
-- Prior to this migration, discovered_properties had no write-path discriminator, so
-- hosted-property-sync.ts could only do additive upserts — it could not safely delete
-- rows it no longer owns without risking crawler-written rows. This column fixes that:
-- only rows with source='aao_hosted' are owned (and reconciled) by the sync job.

ALTER TABLE discovered_properties
  ADD COLUMN source TEXT NOT NULL DEFAULT 'crawler'
  CHECK (source IN ('crawler', 'aao_hosted'));

-- Index for reconcile queries: delete WHERE publisher_domain=$1 AND source='aao_hosted'
CREATE INDEX idx_properties_by_publisher_source
  ON discovered_properties(publisher_domain, source);
