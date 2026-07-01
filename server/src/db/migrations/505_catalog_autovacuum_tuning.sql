-- Migration 505: aggressive per-table autovacuum/analyze for high-row catalog tables.
--
-- catalog_properties grows via incremental INSERT ... ON CONFLICT upserts to
-- millions of rows, but with the cluster defaults (analyze_scale_factor 0.1,
-- vacuum_scale_factor 0.2) autoanalyze does not fire until ~10-20% of the table
-- has changed — ~227k mods on a 2.27M-row table. In production this let the
-- planner statistics drift catastrophically: pg_class.reltuples stayed near zero
-- (~185) while the table actually held 2.27M rows, so the planner chose
-- nested-loop/seq-scan plans sized for a tiny table and queries that scan these
-- tables (brand enrichment, catalog/registry reads) took tens of seconds.
--
-- Pin a much tighter cadence so statistics can never again fall that far behind.
-- A fixed threshold (5000) plus a small scale factor keeps analyze tracking the
-- table without waiting on a percentage of millions of rows. These are storage
-- parameters (reloptions); setting them is idempotent and online (no rewrite,
-- no blocking lock). Run a one-time ANALYZE so the corrected stats land
-- immediately rather than on the next autoanalyze tick.

ALTER TABLE catalog_properties SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 5000
);

ALTER TABLE catalog_identifiers SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 5000
);

ALTER TABLE registry_requests SET (
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 5000,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 5000
);

ANALYZE catalog_properties;
ANALYZE catalog_identifiers;
ANALYZE registry_requests;
