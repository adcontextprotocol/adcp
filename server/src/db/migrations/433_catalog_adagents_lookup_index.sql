-- Index supporting the property-side reader cutover (PR 4a of #3177).
--
-- The new readers in federated-index-db.ts and property-db.ts join
-- catalog_properties on (created_by = 'adagents_json:<domain>',
-- property_id = <manifest_property_id>) inside a CROSS JOIN LATERAL over
-- the publisher's manifest. Without this index, each manifest property
-- triggers a sequential scan of catalog_properties — O(N×M) for a
-- publisher with M properties against N catalog rows.
--
-- The partial WHERE clause keeps the index narrow: only adagents-sourced
-- rows ever match this lookup pattern. Community/system/seed rows are
-- still served by their own classification/status indexes.

CREATE INDEX IF NOT EXISTS idx_catalog_properties_adagents_lookup
  ON catalog_properties (created_by, property_id)
  WHERE created_by LIKE 'adagents_json:%';
