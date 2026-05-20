-- Add 'adagents_authoritative' to the publishers.discovery_method CHECK
-- constraint. Used for child publisher rows synthesized from a manager
-- file's publisher_properties[].publisher_domains[] fan-out, where the
-- child's own adagents.json has NOT been fetched (the parent file IS
-- the authorization declaration per the inline-resolution rule landed
-- in adcp#4825 / PR #4827).
--
-- Distinct from the existing three values:
--   - 'direct': publisher served their own /.well-known/ document
--   - 'authoritative_location': publisher's stub pointed at a manager URL
--   - 'ads_txt_managerdomain': ads.txt MANAGERDOMAIN delegation discovered the manager
--   - 'adagents_authoritative' (NEW): the manager file inlined the publisher,
--     and the publisher itself was never independently fetched. Trust profile:
--     medium — the publisher is named on each property in the manager file
--     (via property.publisher_domain), but no bilateral confirmation from
--     the publisher's own origin.
--
-- The fourth value was specced in adcp#4823 / PR #4828's response schema
-- and the adagents resolution rule in adcp#4825 / PR #4827. This migration
-- enables the crawler to actually write it.

ALTER TABLE publishers DROP CONSTRAINT publishers_discovery_method_check;
ALTER TABLE publishers
  ADD CONSTRAINT publishers_discovery_method_check
  CHECK (discovery_method IN (
    'direct',
    'authoritative_location',
    'ads_txt_managerdomain',
    'adagents_authoritative'
  ));

COMMENT ON COLUMN publishers.discovery_method IS
  'How the publisher''s authorization was discovered on the most recent successful crawl. '
  '''direct'': publisher''s own /.well-known/ served the document. '
  '''authoritative_location'': publisher''s stub redirected to a third-party canonical URL. '
  '''ads_txt_managerdomain'': discovery fell back to a manager domain via ads.txt MANAGERDOMAIN delegation. '
  '''adagents_authoritative'': child publisher synthesized from a manager file''s '
  'publisher_properties[].publisher_domains[] fan-out — the manager file inlines the publisher with explicit '
  'publisher_domain on each property; the child''s own origin was never fetched. Backfilled to ''direct'' for '
  'previously-validated rows.';
